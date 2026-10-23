/**
 * Opens the storefront password `ctl` sealed for one scan (ADR-264).
 *
 * The engine holds no master key (ADR-035). `ctl` opens the merchant's saved password and seals
 * it again under `RAMPSMITH_SCAN_SECRET_KEYS`, a key ring only `ctl` and the engine hold, with
 * the scan's id as context. This module reads that format: `crates/crypto` format version 1
 * (ADR-021), which the Rust tests and `test/scan-secret.test.ts` pin with the same vector.
 *
 * Nothing here logs, caches or returns a key or a password beyond the call that asked.
 */
import { createDecipheriv } from 'node:crypto';
import type postgres from 'postgres';
import { withTenant } from './store.ts';

const VERSION = 1;
const NONCE = 12;
const TAG = 16;
const KEY = 32;
const WRAP_NONCE_AT = 1;
const WRAPPED_AT = WRAP_NONCE_AT + NONCE;
const DATA_NONCE_AT = WRAPPED_AT + KEY + TAG;
const DATA_AT = DATA_NONCE_AT + NONCE;
const KEY_ID = /^[a-z0-9_-]{1,32}$/;

/** A key ring or a sealed value that cannot be used. Messages never carry key material. */
export class ScanSecretError extends Error {
  override readonly name = 'ScanSecretError';
}

/** `id:base64key[,id:base64key...]`, as `crypto::KeyRing::parse` reads it. */
export class ScanKeyRing {
  readonly #keys = new Map<string, Buffer>();

  constructor(spec: string) {
    if (spec.trim() === '') throw new ScanSecretError('no scan secret keys');
    for (const entry of spec.split(',')) {
      const at = entry.indexOf(':');
      if (at < 0) throw new ScanSecretError('each entry is id:base64key');
      const id = entry.slice(0, at).trim();
      if (!KEY_ID.test(id)) throw new ScanSecretError('a key id is invalid');
      const key = Buffer.from(entry.slice(at + 1).trim(), 'base64');
      if (key.length !== KEY) throw new ScanSecretError('a scan secret key must be 32 bytes');
      if (this.#keys.has(id)) throw new ScanSecretError('duplicate key id');
      this.#keys.set(id, key);
    }
  }

  /** Opens `sealed`, which was wrapped by key `keyId`, for `context`. */
  open(keyId: string, sealed: Uint8Array, context: string): string {
    const master = this.#keys.get(keyId);
    if (master === undefined) throw new ScanSecretError(`unknown scan secret key ${keyId}`);
    const bytes = Buffer.from(sealed);
    if (bytes.length < DATA_AT + TAG || bytes[0] !== VERSION) {
      throw new ScanSecretError('malformed sealed value');
    }
    const ctx = Buffer.from(context, 'utf8');
    const id = Buffer.from(keyId, 'utf8');
    const wrapAad = Buffer.concat([
      Buffer.from('rampsmith/envelope/v1/wrap\0', 'utf8'),
      Buffer.from([id.length]),
      id,
      ctx,
    ]);
    const dataAad = Buffer.concat([Buffer.from('rampsmith/envelope/v1/data\0', 'utf8'), ctx]);
    try {
      const dataKey = gcmOpen(
        master,
        bytes.subarray(WRAP_NONCE_AT, WRAPPED_AT),
        bytes.subarray(WRAPPED_AT, DATA_NONCE_AT),
        wrapAad,
      );
      const plain = gcmOpen(
        dataKey,
        bytes.subarray(DATA_NONCE_AT, DATA_AT),
        bytes.subarray(DATA_AT),
        dataAad,
      );
      dataKey.fill(0);
      const text = plain.toString('utf8');
      plain.fill(0);
      return text;
    } catch {
      // The reason (wrong key, wrong context, tampering) is not worth telling anyone.
      throw new ScanSecretError('the sealed value failed authentication');
    }
  }
}

/** AES-256-GCM with the tag at the end of `sealed`. */
function gcmOpen(key: Buffer, nonce: Buffer, sealed: Buffer, aad: Buffer): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG));
  return Buffer.concat([
    decipher.update(sealed.subarray(0, sealed.length - TAG)),
    decipher.final(),
  ]);
}

/** The context `ctl` seals a scan's storefront password under. */
export function scanSecretContext(scanId: string): string {
  return `scans/storefront_password/${scanId}`;
}

/**
 * The `EngineDeps.storefrontPassword` hook over the scan key ring: reads the scan's sealed
 * password and opens it. A scan without one, or one that cannot be opened, yields `undefined`
 * and the page is reported as blocked (ADR-071); it is never an error that fails the scan.
 */
export function storefrontPasswordFromScan(
  sql: postgres.Sql,
  ring: ScanKeyRing,
): (tenantId: string, siteId: string, scanId: string) => Promise<string | undefined> {
  return async (tenantId, siteId, scanId) => {
    const [row] = await withTenant(
      sql,
      tenantId,
      (tx) =>
        tx<{ ct: Buffer | null; key_id: string | null }[]>`
          select storefront_password_ct as ct, storefront_password_key_id as key_id
            from scans
           where tenant_id = ${tenantId} and id = ${scanId} and site_id = ${siteId}
             and status in ('queued', 'running')`,
    );
    if (row?.ct === undefined || row.ct === null || row.key_id === null) return undefined;
    try {
      return ring.open(row.key_id, row.ct, scanSecretContext(scanId));
    } catch {
      return undefined;
    }
  };
}
