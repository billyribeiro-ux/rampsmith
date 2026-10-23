import { describe, expect, it } from 'vitest';
import { MediaGuard, type GuardLimits } from './media-guard.server.ts';

const LIMITS: GuardLimits = {
  perTokenPerWindow: 3,
  perAddressPerWindow: 5,
  windowMs: 60_000,
  perKeyInFlight: 2,
  totalInFlight: 3,
  maxKeys: 4,
};

describe('MediaGuard (security audit L4)', () => {
  it('refuses a token past its window quota and says when to come back', () => {
    let now = 1_000_000;
    const guard = new MediaGuard(LIMITS, () => now);
    for (let i = 0; i < 3; i += 1) {
      const entry = guard.enter('token-a', `10.0.0.${String(i)}`);
      expect(entry.ok).toBe(true);
      if (entry.ok) entry.release();
    }
    now += 20_000;
    const refused = guard.enter('token-a', '10.0.0.9');
    expect(refused).toEqual({ ok: false, retryAfterSeconds: 40 });
    // Another token is unaffected, and the window renews.
    expect(guard.enter('token-b', '10.0.0.9').ok).toBe(true);
    now += 40_000;
    expect(guard.enter('token-a', '10.0.0.9').ok).toBe(true);
  });

  it('limits an address across tokens, so rotating tokens does not help', () => {
    // Few token slots: made-up tokens evict each other but never the address's count.
    const guard = new MediaGuard({ ...LIMITS, perTokenPerWindow: 100 });
    const results = Array.from({ length: 7 }, (_, i) => {
      const entry = guard.enter(`token-${String(i)}`, '203.0.113.7');
      if (entry.ok) entry.release();
      return entry.ok;
    });
    expect(results).toEqual([true, true, true, true, true, false, false]);
  });

  it('caps fetches in flight per key and overall, and frees the slot on release', () => {
    const guard = new MediaGuard({ ...LIMITS, perTokenPerWindow: 100, perAddressPerWindow: 100 });
    const a1 = guard.enter('a', 'ip-1');
    const a2 = guard.enter('a', 'ip-2');
    expect(a1.ok && a2.ok).toBe(true);
    expect(guard.enter('a', 'ip-3').ok, 'a third fetch for one token waits').toBe(false);
    const b1 = guard.enter('b', 'ip-4');
    expect(b1.ok).toBe(true);
    expect(guard.enter('c', 'ip-5').ok, 'three in flight overall').toBe(false);
    if (a1.ok) {
      a1.release();
      a1.release(); // releasing twice frees one slot only
    }
    expect(guard.enter('c', 'ip-5').ok).toBe(true);
    expect(guard.enter('d', 'ip-6').ok).toBe(false);
  });

  it('keeps its memory bounded', () => {
    const guard = new MediaGuard(LIMITS);
    for (let i = 0; i < 50; i += 1) {
      const entry = guard.enter(`token-${String(i)}`, `ip-${String(i)}`);
      if (entry.ok) entry.release();
    }
    expect(guard.enter('late', 'late-ip').ok).toBe(true);
  });
});
