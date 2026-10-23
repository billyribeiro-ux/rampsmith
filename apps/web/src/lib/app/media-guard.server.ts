/**
 * Limits on the media route (security audit L4, ADR-099). The route fetches from Shopify's CDN
 * for any signed-in visitor, so a stolen or looping client could use it to hold sockets open
 * and burn bandwidth. Every request counts against a fixed window per key (the hash of the
 * session token and the visitor's address) and against a cap on fetches in flight, per key and
 * overall. Nothing here is stored beyond counters, and a key is never logged.
 */

export interface GuardLimits {
  /** Requests one session token may make in a window. */
  readonly perTokenPerWindow: number;
  /** Requests one address may make in a window: more, since an office shares one. */
  readonly perAddressPerWindow: number;
  readonly windowMs: number;
  /** Fetches one key may have in flight. */
  readonly perKeyInFlight: number;
  /** Fetches in flight across all keys. */
  readonly totalInFlight: number;
  /**
   * Most keys tracked per kind (tokens, addresses); finished windows are dropped first, then
   * the oldest. Kept apart so a flood of made-up tokens cannot push an address's count out.
   */
  readonly maxKeys: number;
}

const MEDIA_LIMITS: GuardLimits = {
  // A page of thumbnails is at most 100 images; a token lives about a minute.
  perTokenPerWindow: 240,
  perAddressPerWindow: 600,
  windowMs: 60_000,
  perKeyInFlight: 8,
  totalInFlight: 32,
  maxKeys: 5_000,
};

export type Entry =
  | { readonly ok: true; readonly release: () => void }
  | { readonly ok: false; readonly retryAfterSeconds: number };

interface Counter {
  windowStart: number;
  count: number;
  inFlight: number;
}

export class MediaGuard {
  readonly #limits: GuardLimits;
  readonly #now: () => number;
  readonly #tokens = new Map<string, Counter>();
  readonly #addresses = new Map<string, Counter>();
  #inFlight = 0;

  constructor(limits: GuardLimits = MEDIA_LIMITS, now: () => number = Date.now) {
    this.#limits = limits;
    this.#now = now;
  }

  /**
   * Admits one request counted against the token and the address, or says when to come back.
   * A request that is admitted must call `release` when its fetch is over.
   */
  enter(tokenKey: string, address: string): Entry {
    const now = this.#now();
    const { windowMs, perTokenPerWindow, perAddressPerWindow, perKeyInFlight, totalInFlight } =
      this.#limits;
    const counters = [
      this.#counter(this.#tokens, tokenKey, now),
      this.#counter(this.#addresses, address, now),
    ];
    const ceilings = [perTokenPerWindow, perAddressPerWindow];
    for (const [i, counter] of counters.entries()) {
      if (counter.count >= (ceilings[i] ?? 0)) {
        const wait = Math.ceil((counter.windowStart + windowMs - now) / 1000);
        return { ok: false, retryAfterSeconds: Math.max(1, wait) };
      }
    }
    if (this.#inFlight >= totalInFlight || counters.some((c) => c.inFlight >= perKeyInFlight)) {
      return { ok: false, retryAfterSeconds: 1 };
    }
    for (const counter of counters) {
      counter.count += 1;
      counter.inFlight += 1;
    }
    this.#inFlight += 1;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.#inFlight -= 1;
        for (const counter of counters) counter.inFlight -= 1;
      },
    };
  }

  #counter(book: Map<string, Counter>, key: string, now: number): Counter {
    const found = book.get(key);
    if (found !== undefined) {
      if (now - found.windowStart >= this.#limits.windowMs) {
        found.windowStart = now;
        found.count = 0;
      }
      return found;
    }
    if (book.size >= this.#limits.maxKeys) this.#sweep(book, now);
    const fresh: Counter = { windowStart: now, count: 0, inFlight: 0 };
    book.set(key, fresh);
    return fresh;
  }

  /** Drops finished windows with nothing in flight; if none, the oldest tenth. */
  #sweep(book: Map<string, Counter>, now: number): void {
    for (const [key, counter] of book) {
      if (counter.inFlight === 0 && now - counter.windowStart >= this.#limits.windowMs) {
        book.delete(key);
      }
    }
    if (book.size < this.#limits.maxKeys) return;
    const drop = Math.ceil(this.#limits.maxKeys / 10);
    let dropped = 0;
    for (const [key, counter] of book) {
      if (dropped >= drop) break;
      if (counter.inFlight === 0) {
        book.delete(key);
        dropped += 1;
      }
    }
  }
}
