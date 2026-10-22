import { describe, expect, it } from 'vitest';
import { DAY_MS, ResultCache, WindowLimiter } from './limits.ts';

describe('WindowLimiter', () => {
  it('allows up to the limit inside the window, then reports when to retry', () => {
    const limiter = new WindowLimiter({ limit: 3, windowMs: DAY_MS, maxKeys: 100 });
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i += 1) {
      expect(limiter.check('ip', t0 + i).allowed).toBe(true);
      limiter.record('ip', t0 + i);
    }
    const blocked = limiter.check('ip', t0 + 10);
    expect(blocked.allowed).toBe(false);
    // The oldest scan leaves the window one day after it happened.
    expect(blocked.retryAfterSeconds).toBe(Math.ceil((DAY_MS - 10) / 1000));
  });

  it('frees a slot when the oldest entry leaves the window', () => {
    const limiter = new WindowLimiter({ limit: 1, windowMs: 1000, maxKeys: 10 });
    limiter.record('a', 0);
    expect(limiter.check('a', 999).allowed).toBe(false);
    expect(limiter.check('a', 1000).allowed).toBe(true);
  });

  it('keeps keys apart', () => {
    const limiter = new WindowLimiter({ limit: 1, windowMs: 1000, maxKeys: 10 });
    limiter.record('a', 0);
    expect(limiter.check('b', 1).allowed).toBe(true);
  });

  it('forgets one entry, so a scan that never ran does not count', () => {
    const limiter = new WindowLimiter({ limit: 1, windowMs: 1000, maxKeys: 10 });
    limiter.record('a', 5);
    limiter.forget('a', 5);
    expect(limiter.check('a', 6).allowed).toBe(true);
  });

  it('stays within its key budget by dropping the least recently used key', () => {
    const limiter = new WindowLimiter({ limit: 1, windowMs: 10_000, maxKeys: 2 });
    limiter.record('a', 1);
    limiter.record('b', 2);
    limiter.record('c', 3);
    expect(limiter.size()).toBe(2);
    expect(limiter.check('a', 4).allowed).toBe(true);
    expect(limiter.check('c', 4).allowed).toBe(false);
  });
});

describe('ResultCache', () => {
  it('returns a value for 24 hours and then drops it', () => {
    const cache = new ResultCache<string>({ ttlMs: DAY_MS, maxEntries: 10 });
    cache.set('example.com', 'result', 0);
    expect(cache.get('example.com', DAY_MS - 1)).toBe('result');
    expect(cache.get('example.com', DAY_MS)).toBeUndefined();
  });

  it('holds at most maxEntries, oldest first out', () => {
    const cache = new ResultCache<number>({ ttlMs: DAY_MS, maxEntries: 2 });
    cache.set('a', 1, 0);
    cache.set('b', 2, 1);
    cache.set('c', 3, 2);
    expect(cache.get('a', 3)).toBeUndefined();
    expect(cache.get('b', 3)).toBe(2);
    expect(cache.get('c', 3)).toBe(3);
  });
});
