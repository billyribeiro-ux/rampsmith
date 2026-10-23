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
) as Record<'ring' | 'key_id' | 'context' | 'plaintext' | 'sealed', string>;

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
      const text = String((error as Error).message);
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
