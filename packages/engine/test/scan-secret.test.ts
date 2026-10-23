import { readFileSync } from 'node:fs';
import { uuidv7 } from '@rampsmith/queue';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ScanKeyRing,
  ScanSecretError,
  scanSecretContext,
  storefrontPasswordFromScan,
} from '../src/scan-secret.ts';
import { freshDatabase, seed, type TestDatabase } from './db.ts';

/** The vector `crates/crypto/tests/vector.rs` opens too: one format, two implementations. */
const vector = Object.fromEntries(
  readFileSync(
    new URL('../../../crates/crypto/tests/vectors/scan-secret.txt', import.meta.url),
    'utf8',
  )
    .split('\n')
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
) as Record<
  | 'ring'
  | 'key_id'
  | 'context'
  | 'plaintext'
  | 'sealed'
  | 'ring_rotated'
  | 'key_id_new'
  | 'sealed_new',
  string
>;

describe('opening a scan secret', () => {
  const ring = new ScanKeyRing(vector.ring);
  const sealed = Buffer.from(vector.sealed, 'base64');

  it('opens what crates/crypto sealed', () => {
    expect(ring.open(vector.key_id, sealed, vector.context)).toBe(vector.plaintext);
  });

  it('refuses another scan, another key id, other bytes and a truncation', () => {
    const other = scanSecretContext(uuidv7());
    expect(() => ring.open(vector.key_id, sealed, other)).toThrow(ScanSecretError);
    expect(() => ring.open('scan2', sealed, vector.context)).toThrow(/unknown scan secret key/);
    const flipped = Buffer.from(sealed);
    flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 1;
    expect(() => ring.open(vector.key_id, flipped, vector.context)).toThrow(ScanSecretError);
    expect(() => ring.open(vector.key_id, sealed.subarray(0, 40), vector.context)).toThrow(
      /malformed/,
    );
  });

  it('never puts the password or a key in an error', () => {
    try {
      ring.open(vector.key_id, sealed, 'scans/storefront_password/elsewhere');
      expect.unreachable();
    } catch (error) {
      const text = (error as Error).message;
      expect(text).not.toContain(vector.plaintext);
      expect(text).not.toContain(vector.ring.split(':')[1] ?? '?');
    }
  });

  it('rejects unusable rings', () => {
    for (const bad of [
      '',
      'nokey',
      'UPPER:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
      'a:AAEC',
    ]) {
      expect(() => new ScanKeyRing(bad), bad).toThrow(ScanSecretError);
    }
    const key = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
    expect(() => new ScanKeyRing(`a:${key},a:${key}`)).toThrow(/duplicate/);
  });
});

describe('a rotated scan ring (docs/runbooks/rotate-scan-secret-keys.md, audit L7)', () => {
  const rotated = new ScanKeyRing(vector.ring_rotated);
  const before = Buffer.from(vector.sealed, 'base64');
  const after = Buffer.from(vector.sealed_new, 'base64');

  it('opens a copy sealed under either key, by the id stored with it', () => {
    expect(rotated.open(vector.key_id, before, vector.context)).toBe(vector.plaintext);
    expect(rotated.open(vector.key_id_new, after, vector.context)).toBe(vector.plaintext);
    // A copy is opened by the key that wrapped it: the other id's key is not tried.
    expect(() => rotated.open(vector.key_id, after, vector.context)).toThrow(ScanSecretError);
    expect(() => rotated.open(vector.key_id_new, before, vector.context)).toThrow(ScanSecretError);
  });

  it('cannot open the new key’s copy until the engine has the new key', () => {
    const oldOnly = new ScanKeyRing(vector.ring);
    expect(() => oldOnly.open(vector.key_id_new, after, vector.context)).toThrow(
      /unknown scan secret key/,
    );
    // And an engine on the rotated ring still serves a scan sealed before the rotation.
    expect(oldOnly.open(vector.key_id, before, vector.context)).toBe(vector.plaintext);
  });

  it('serves scans sealed under both keys through the hook', async () => {
    const db = await freshDatabase();
    try {
      const bound = vector.context.slice('scans/storefront_password/'.length);
      const hook = storefrontPasswordFromScan(db.as('rampsmith_worker'), rotated);
      for (const [keyId, bytes] of [
        [vector.key_id, before],
        [vector.key_id_new, after],
      ] as const) {
        const f = await seed(db.owner, 'https://demo.example/', { scanId: bound });
        await db.owner`
          update scans set storefront_password_ct = ${bytes}, storefront_password_key_id = ${keyId}
           where id = ${f.scanId}`;
        expect(await hook(f.tenantId, f.siteId, f.scanId)).toBe(vector.plaintext);
        await db.owner`delete from scans where id = ${f.scanId}`.catch(() => undefined);
      }
    } finally {
      await db.drop();
    }
  });
});

describe('the storefront password hook', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await freshDatabase();
  });
  afterAll(async () => {
    await db.drop();
  });

  const BASE = 'https://demo.example/';

  it('hands the engine the password of its own scan, only while the scan runs', async () => {
    const ring = new ScanKeyRing(vector.ring);
    const f = await seed(db.owner, BASE);
    // The vector is bound to its own scan id, so file it under that id's context: a scan whose
    // id differs from the sealed context yields nothing (the secret cannot be moved).
    const hook = storefrontPasswordFromScan(db.as('rampsmith_worker'), ring);
    const sealed = Buffer.from(vector.sealed, 'base64');
    await db.owner`
      update scans set storefront_password_ct = ${sealed}, storefront_password_key_id = ${vector.key_id}
       where id = ${f.scanId}`;
    expect(await hook(f.tenantId, f.siteId, f.scanId)).toBeUndefined();

    const bound = vector.context.slice('scans/storefront_password/'.length);
    const mine = await seed(db.owner, BASE, { scanId: bound });
    await db.owner`
      update scans set storefront_password_ct = ${sealed}, storefront_password_key_id = ${vector.key_id}
       where id = ${mine.scanId}`;
    expect(await hook(mine.tenantId, mine.siteId, mine.scanId)).toBe(vector.plaintext);
    // Another tenant cannot ask for it, and nothing is returned once the scan has ended.
    expect(await hook(f.tenantId, mine.siteId, mine.scanId)).toBeUndefined();
    await db.owner`update scans set status = 'succeeded', finished_at = now() where id = ${mine.scanId}`;
    expect(await hook(mine.tenantId, mine.siteId, mine.scanId)).toBeUndefined();
  });
});
