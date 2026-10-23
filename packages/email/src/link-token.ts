/**
 * Signed, expiring, single-purpose links in email (ADR-274): the unsubscribe link of one message
 * category and the email preferences link. The engine mints them when it sends; the api verifies
 * them when a recipient follows one. Both hold `EMAIL_LINK_KEYS` and nothing else can mint a
 * token: it is a key ring of its own, so no master key or scan key reaches the engine or the
 * recipient's mail client (ADR-266, ADR-274).
 *
 * A token is `base64url(body || mac)`. `crates/api/src/email_link.rs` reads the same layout, and
 * `test/fixtures/link-vectors.json` pins both implementations to the same bytes.
 *
 * ```
 * byte 0        version (1)
 * byte 1        purpose: 1 unsubscribe, 2 preferences
 * byte 2        category: 1 notification, 2 marketing (unsubscribe); 0 (preferences)
 * bytes 3..7    expiry, seconds since the Unix epoch, big endian
 * bytes 7..23   tenant id, 16 bytes
 * bytes 23..39  shop id, 16 bytes
 * bytes 39..71  address hash: `email_address_hash(tenant, address)`, 32 bytes
 * byte 71       key id length n (1 to 16)
 * bytes 72..    key id, n ASCII bytes
 * then          HMAC-SHA-256(key, DOMAIN || every byte above), 32 bytes
 * ```
 *
 * The token carries a hash of the address, never the address: a tenant-salted SHA-256 is what the
 * suppression tables store, and the api needs nothing else to record a choice.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** What a link may be used for. A token for one purpose is refused for the other. */
export type LinkPurpose = 'unsubscribe' | 'preferences';

/** The categories a recipient can switch off (ADR-191: security and transactional cannot be). */
export type OptOutCategory = 'notification' | 'marketing';

export const OPT_OUT_CATEGORIES: readonly OptOutCategory[] = ['notification', 'marketing'];

/** How long a link works: three times CAN-SPAM's 30 days and well past CASL's 60 (ADR-191). */
export const LINK_TTL_SECONDS = 180 * 24 * 60 * 60;

const DOMAIN = Buffer.from('rampsmith/email-link/v1\0', 'utf8');
const VERSION = 1;
const FIXED = 72;
const MAC = 32;
const MIN_KEY_BYTES = 32;
const KEY_ID = /^[A-Za-z0-9_-]{1,16}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export class LinkKeyError extends Error {
  constructor(message: string) {
    super(`email link keys: ${message}`);
    this.name = 'LinkKeyError';
  }
}

/** The key ring of `EMAIL_LINK_KEYS`: `id:base64key[,id:base64key…]`, newest first. */
export class LinkKeyRing {
  readonly #keys: ReadonlyMap<string, Buffer>;
  readonly #activeId: string;

  private constructor(keys: ReadonlyMap<string, Buffer>, activeId: string) {
    this.#keys = keys;
    this.#activeId = activeId;
  }

  /** Throws {@link LinkKeyError}; its message names the problem and never a key. */
  static parse(spec: string): LinkKeyRing {
    const keys = new Map<string, Buffer>();
    let activeId: string | undefined;
    for (const entry of spec.split(',')) {
      const trimmed = entry.trim();
      const colon = trimmed.indexOf(':');
      if (colon < 1) {
        throw new LinkKeyError('each entry must look like id:base64key');
      }
      const id = trimmed.slice(0, colon).trim();
      const encoded = trimmed.slice(colon + 1).trim();
      if (!KEY_ID.test(id)) {
        throw new LinkKeyError('a key id is 1 to 16 letters, digits, hyphens or underscores');
      }
      if (keys.has(id)) {
        throw new LinkKeyError(`key id ${id} is listed twice`);
      }
      if (!/^[A-Za-z0-9+/_-]+={0,2}$/u.test(encoded)) {
        throw new LinkKeyError(`key ${id} is not base64`);
      }
      const key = Buffer.from(encoded, 'base64');
      if (key.length < MIN_KEY_BYTES) {
        throw new LinkKeyError(`key ${id} is shorter than ${String(MIN_KEY_BYTES)} bytes`);
      }
      keys.set(id, key);
      activeId ??= id;
    }
    if (activeId === undefined) {
      throw new LinkKeyError('the ring is empty');
    }
    return new LinkKeyRing(keys, activeId);
  }

  get activeId(): string {
    return this.#activeId;
  }

  /** HMAC-SHA-256 of `DOMAIN || data` under key `id`; undefined when the ring lacks it. */
  mac(id: string, data: Uint8Array): Buffer | undefined {
    const key = this.#keys.get(id);
    return key === undefined
      ? undefined
      : createHmac('sha256', key).update(DOMAIN).update(data).digest();
  }

  /** Keys are secrets: logging a ring shows its ids only. */
  toJSON(): { readonly ids: string[] } {
    return { ids: [...this.#keys.keys()] };
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `LinkKeyRing { ids: ${[...this.#keys.keys()].join(', ')} }`;
  }
}

export interface LinkClaims {
  readonly purpose: LinkPurpose;
  /** The category to switch off; absent for a preferences link, which covers all of them. */
  readonly category?: OptOutCategory | undefined;
  /** Seconds since the Unix epoch. */
  readonly expiresAt: number;
  readonly tenantId: string;
  readonly shopId: string;
  /** `email_address_hash(tenant, address)`, 32 bytes. */
  readonly addressHash: Uint8Array;
}

function uuidBytes(value: string, what: string): Buffer {
  if (!UUID.test(value)) {
    throw new TypeError(`${what} must be a lower-case UUID`);
  }
  return Buffer.from(value.replaceAll('-', ''), 'hex');
}

function uuidText(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Mints a token for `claims` under the ring's newest key. */
export function mintLinkToken(ring: LinkKeyRing, claims: LinkClaims): string {
  const purposeByte = claims.purpose === 'unsubscribe' ? 1 : 2;
  let categoryByte = 0;
  if (claims.purpose === 'unsubscribe') {
    if (claims.category === undefined) {
      throw new TypeError('an unsubscribe link names its category');
    }
    categoryByte = claims.category === 'notification' ? 1 : 2;
  } else if (claims.category !== undefined) {
    throw new TypeError('a preferences link covers every category');
  }
  if (
    !Number.isInteger(claims.expiresAt) ||
    claims.expiresAt < 0 ||
    claims.expiresAt > 0xffff_ffff
  ) {
    throw new RangeError('expiresAt must be whole seconds that fit 32 bits');
  }
  if (claims.addressHash.length !== 32) {
    throw new TypeError('addressHash must be 32 bytes');
  }
  const id = Buffer.from(ring.activeId, 'ascii');
  const body = Buffer.alloc(FIXED + id.length);
  body[0] = VERSION;
  body[1] = purposeByte;
  body[2] = categoryByte;
  body.writeUInt32BE(claims.expiresAt, 3);
  uuidBytes(claims.tenantId, 'tenantId').copy(body, 7);
  uuidBytes(claims.shopId, 'shopId').copy(body, 23);
  Buffer.from(claims.addressHash).copy(body, 39);
  body[71] = id.length;
  id.copy(body, FIXED);
  const mac = ring.mac(ring.activeId, body);
  if (mac === undefined) {
    throw new LinkKeyError('the active key is missing');
  }
  return Buffer.concat([body, mac]).toString('base64url');
}

export type LinkRefusal = 'malformed' | 'unknown_key' | 'bad_signature' | 'expired';

export type LinkVerdict =
  | { readonly ok: true; readonly claims: LinkClaims }
  | { readonly ok: false; readonly reason: LinkRefusal };

/**
 * Reads and checks a token. The signature is checked before any claim is trusted, and the
 * expiry last, so a forged token is `bad_signature` whatever it claims.
 */
export function verifyLinkToken(ring: LinkKeyRing, token: string, nowSeconds: number): LinkVerdict {
  if (token.length > 400 || !/^[A-Za-z0-9_-]+$/u.test(token)) {
    return { ok: false, reason: 'malformed' };
  }
  const raw = Buffer.from(token, 'base64url');
  if (raw.length < FIXED + 1 + MAC || raw[0] !== VERSION) {
    return { ok: false, reason: 'malformed' };
  }
  const idLength = raw[71] ?? 0;
  if (idLength < 1 || idLength > 16 || raw.length !== FIXED + idLength + MAC) {
    return { ok: false, reason: 'malformed' };
  }
  const bodyEnd = FIXED + idLength;
  const id = raw.subarray(FIXED, bodyEnd).toString('ascii');
  if (!KEY_ID.test(id)) {
    return { ok: false, reason: 'malformed' };
  }
  const expected = ring.mac(id, raw.subarray(0, bodyEnd));
  if (expected === undefined) {
    return { ok: false, reason: 'unknown_key' };
  }
  if (!timingSafeEqual(expected, raw.subarray(bodyEnd))) {
    return { ok: false, reason: 'bad_signature' };
  }
  const purposeByte = raw[1];
  const categoryByte = raw[2];
  const purpose = purposeByte === 1 ? 'unsubscribe' : purposeByte === 2 ? 'preferences' : undefined;
  const category =
    categoryByte === 1 ? 'notification' : categoryByte === 2 ? 'marketing' : undefined;
  if (purpose === undefined || (purpose === 'unsubscribe') !== (category !== undefined)) {
    return { ok: false, reason: 'malformed' };
  }
  const expiresAt = raw.readUInt32BE(3);
  if (nowSeconds >= expiresAt) {
    return { ok: false, reason: 'expired' };
  }
  return {
    ok: true,
    claims: {
      purpose,
      category,
      expiresAt,
      tenantId: uuidText(raw.subarray(7, 23)),
      shopId: uuidText(raw.subarray(23, 39)),
      addressHash: Uint8Array.from(raw.subarray(39, 71)),
    },
  };
}
