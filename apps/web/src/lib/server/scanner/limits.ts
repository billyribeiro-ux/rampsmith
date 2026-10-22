/**
 * The free scanner's caps and cache (PLAN §16): 3 scans per IP and 1 per domain per day, and
 * results cached for 24 hours per domain.
 *
 * State is held in this process, which is correct while the web service runs one instance. A
 * second instance would double every cap, so scaling out needs a shared store first (ADR-262).
 * Both structures are bounded, so a flood of distinct keys cannot grow memory without limit.
 * Time is passed in so tests need no clock.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

export interface LimitCheck {
  readonly allowed: boolean;
  /** When refused: whole seconds until the oldest counted entry leaves the window. */
  readonly retryAfterSeconds: number;
}

export interface WindowLimiterOptions {
  readonly limit: number;
  readonly windowMs: number;
  readonly maxKeys: number;
}

/** At most `limit` recorded events per key inside a rolling window. */
export class WindowLimiter {
  readonly #options: WindowLimiterOptions;
  // Map iteration order is insertion order, which this keeps as least recently used first.
  readonly #events = new Map<string, number[]>();

  constructor(options: WindowLimiterOptions) {
    this.#options = options;
  }

  #live(key: string, now: number): number[] {
    const kept = (this.#events.get(key) ?? []).filter((at) => now - at < this.#options.windowMs);
    if (kept.length === 0) this.#events.delete(key);
    else this.#events.set(key, kept);
    return kept;
  }

  check(key: string, now: number): LimitCheck {
    const live = this.#live(key, now);
    if (live.length < this.#options.limit) return { allowed: true, retryAfterSeconds: 0 };
    const oldest = live[live.length - this.#options.limit] ?? now;
    const wait = Math.max(0, oldest + this.#options.windowMs - now);
    return { allowed: false, retryAfterSeconds: Math.ceil(wait / 1000) };
  }

  record(key: string, now: number): void {
    const live = this.#live(key, now);
    live.push(now);
    // Re-insert so the key becomes the most recently used.
    this.#events.delete(key);
    this.#events.set(key, live);
    while (this.#events.size > this.#options.maxKeys) {
      const eldest = this.#events.keys().next();
      if (eldest.done) break;
      this.#events.delete(eldest.value);
    }
  }

  /** Removes one recorded event, for a scan that was counted but never ran. */
  forget(key: string, at: number): void {
    const events = this.#events.get(key);
    if (events === undefined) return;
    const index = events.indexOf(at);
    if (index >= 0) events.splice(index, 1);
    if (events.length === 0) this.#events.delete(key);
  }

  size(): number {
    return this.#events.size;
  }
}

export interface ResultCacheOptions {
  readonly ttlMs: number;
  readonly maxEntries: number;
}

/** A time-limited cache with a size bound; the oldest entry leaves first. */
export class ResultCache<T> {
  readonly #options: ResultCacheOptions;
  readonly #entries = new Map<string, { readonly value: T; readonly expiresAt: number }>();

  constructor(options: ResultCacheOptions) {
    this.#options = options;
  }

  get(key: string, now: number): T | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    if (now >= entry.expiresAt) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, now: number): void {
    this.#entries.delete(key);
    this.#entries.set(key, { value, expiresAt: now + this.#options.ttlMs });
    while (this.#entries.size > this.#options.maxEntries) {
      const eldest = this.#entries.keys().next();
      if (eldest.done) break;
      this.#entries.delete(eldest.value);
    }
  }
}
