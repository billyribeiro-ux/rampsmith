import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  LINK_TTL_SECONDS,
  LinkKeyError,
  LinkKeyRing,
  mintLinkToken,
  verifyLinkToken,
  type LinkClaims,
} from '../src/index.ts';

interface Vector {
  readonly name: string;
  readonly claims: Omit<LinkClaims, 'addressHash'> & { readonly addressHash: number[] };
  readonly token: string;
}

const FIXTURE = JSON.parse(
  readFileSync(new URL('./fixtures/link-vectors.json', import.meta.url), 'utf8'),
) as { keys: string; oldKeys: string; now: number; vectors: Vector[] };

const ring = LinkKeyRing.parse(FIXTURE.keys);
const claimsOf = (v: Vector): LinkClaims => ({
  ...v.claims,
  addressHash: Uint8Array.from(v.claims.addressHash),
});
const vector = (name: string): Vector => {
  const found = FIXTURE.vectors.find((v) => v.name === name);
  if (found === undefined) throw new Error(`no vector ${name}`);
  return found;
};
const BASE = claimsOf(vector('unsubscribe-notification'));

/** Flips one bit of the decoded token at `index` and encodes it again. */
function flip(token: string, index: number): string {
  const raw = Buffer.from(token, 'base64url');
  raw[index] = (raw[index] ?? 0) ^ 0x01;
  return raw.toString('base64url');
}

describe('link tokens', () => {
  it('mints the pinned bytes that the Rust verifier reads (ADR-274)', () => {
    for (const v of FIXTURE.vectors) {
      const key = v.name.endsWith('old-key') ? LinkKeyRing.parse(FIXTURE.oldKeys) : ring;
      expect(mintLinkToken(key, claimsOf(v)), v.name).toBe(v.token);
    }
  });

  it('matches an independent HMAC over the documented layout', () => {
    const token = Buffer.from(vector('preferences').token, 'base64url');
    const body = token.subarray(0, token.length - 32);
    const key = Buffer.from(Array.from({ length: 32 }, (_, i) => 32 + i));
    const mac = createHmac('sha256', key)
      .update(Buffer.from('rampsmith/email-link/v1\0'))
      .update(body)
      .digest();
    expect(token.subarray(token.length - 32).equals(mac)).toBe(true);
    expect(body[0]).toBe(1);
    expect(body[1]).toBe(2);
    expect(body[2]).toBe(0);
    expect(body.readUInt32BE(3)).toBe(1_800_000_000);
    expect(body.subarray(72).toString('ascii')).toBe('k2');
  });

  it('round-trips every vector with the claims it was minted from', () => {
    for (const v of FIXTURE.vectors) {
      const verdict = verifyLinkToken(ring, v.token, FIXTURE.now);
      expect(verdict.ok, v.name).toBe(true);
      if (verdict.ok) {
        expect(verdict.claims.purpose).toBe(v.claims.purpose);
        expect(verdict.claims.category).toBe(v.claims.category);
        expect(verdict.claims.tenantId).toBe(v.claims.tenantId);
        expect(verdict.claims.shopId).toBe(v.claims.shopId);
        expect([...verdict.claims.addressHash]).toEqual(v.claims.addressHash);
      }
    }
  });

  it('refuses a token with any single bit changed', () => {
    const { token } = vector('unsubscribe-notification');
    const length = Buffer.from(token, 'base64url').length;
    for (let index = 0; index < length; index += 1) {
      const verdict = verifyLinkToken(ring, flip(token, index), FIXTURE.now);
      expect(verdict.ok, `byte ${String(index)}`).toBe(false);
    }
  });

  it('reports a forged claim as a bad signature, not as what it claims', () => {
    const { token } = vector('unsubscribe-notification');
    // Byte 2 is the category: marketing instead of notification.
    expect(verifyLinkToken(ring, flip(token, 2), FIXTURE.now)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    // Byte 3 is the top byte of the expiry.
    expect(verifyLinkToken(ring, flip(token, 3), FIXTURE.now)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('expires at the second named in the token, and not before', () => {
    const { token } = vector('unsubscribe-notification');
    expect(verifyLinkToken(ring, token, BASE.expiresAt - 1).ok).toBe(true);
    expect(verifyLinkToken(ring, token, BASE.expiresAt)).toEqual({ ok: false, reason: 'expired' });
    expect(verifyLinkToken(ring, token, BASE.expiresAt + 86_400)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('keeps accepting a token signed with an older key that is still in the ring', () => {
    expect(
      verifyLinkToken(ring, vector('unsubscribe-notification-old-key').token, FIXTURE.now).ok,
    ).toBe(true);
    const retired = LinkKeyRing.parse(FIXTURE.keys.split(',')[0] ?? '');
    expect(
      verifyLinkToken(retired, vector('unsubscribe-notification-old-key').token, FIXTURE.now),
    ).toEqual({ ok: false, reason: 'unknown_key' });
  });

  it('refuses a token signed with a key of the same id but other bytes', () => {
    const other = LinkKeyRing.parse(`k2:${Buffer.alloc(32, 7).toString('base64')}`);
    const forged = mintLinkToken(other, BASE);
    expect(verifyLinkToken(ring, forged, FIXTURE.now)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('refuses malformed text without throwing', () => {
    for (const text of [
      '',
      'x',
      '!!!!',
      'A'.repeat(401),
      'A'.repeat(140),
      `${vector('preferences').token}AA`,
      vector('preferences').token.slice(0, -4),
    ]) {
      const verdict = verifyLinkToken(ring, text, FIXTURE.now);
      expect(verdict.ok, text.slice(0, 12)).toBe(false);
    }
  });

  it('will not mint an unsubscribe without a category, or preferences with one', () => {
    expect(() => mintLinkToken(ring, { ...BASE, category: undefined })).toThrow(/category/u);
    expect(() => mintLinkToken(ring, { ...BASE, purpose: 'preferences' })).toThrow(
      /every category/u,
    );
  });

  it('will not mint a token that cannot be read back', () => {
    expect(() => mintLinkToken(ring, { ...BASE, tenantId: 'not-a-uuid' })).toThrow(TypeError);
    expect(() => mintLinkToken(ring, { ...BASE, addressHash: new Uint8Array(31) })).toThrow(
      TypeError,
    );
    expect(() => mintLinkToken(ring, { ...BASE, expiresAt: -1 })).toThrow(RangeError);
    expect(() => mintLinkToken(ring, { ...BASE, expiresAt: 2 ** 32 })).toThrow(RangeError);
  });

  it('gives a new link the documented lifetime', () => {
    expect(LINK_TTL_SECONDS).toBe(180 * 86_400);
  });
});

describe('LinkKeyRing', () => {
  it('names the problem without printing a key', () => {
    const secret = Buffer.alloc(8, 9).toString('base64');
    for (const spec of [
      '',
      'no-colon',
      `k1:${secret}`,
      `bad id:${Buffer.alloc(32).toString('base64')}`,
      `k1:${Buffer.alloc(32).toString('base64')},k1:${Buffer.alloc(32, 1).toString('base64')}`,
      'k1:@@@@',
    ]) {
      let message = '';
      try {
        LinkKeyRing.parse(spec);
      } catch (error) {
        expect(error).toBeInstanceOf(LinkKeyError);
        message = (error as Error).message;
      }
      expect(message, spec).not.toBe('');
      expect(message).not.toContain(secret);
    }
  });

  it('shows ids and never key bytes when logged', () => {
    const text = JSON.stringify(ring) + String(JSON.stringify({ ring }));
    expect(text).toContain('k2');
    expect(text).not.toContain(FIXTURE.keys.split(',')[0]?.split(':')[1] ?? 'x');
  });
});
