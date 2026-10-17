import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { retryDelayMs } from '../src/backoff.ts';

interface Vectors {
  cases: { attempt: number; jitter: number; delay_ms: number }[];
}

const vectors = JSON.parse(
  readFileSync(new URL('../../../crates/queue/testdata/backoff.json', import.meta.url), 'utf8'),
) as Vectors;

describe('retryDelayMs', () => {
  it('matches the vectors shared with the Rust queue', () => {
    expect(vectors.cases.length).toBeGreaterThan(0);
    for (const c of vectors.cases) {
      expect(retryDelayMs(c.attempt, c.jitter), `attempt ${String(c.attempt)}`).toBe(c.delay_ms);
    }
  });

  it('never reaches one hour', () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      expect(retryDelayMs(attempt, 0.9999999)).toBeLessThan(3_600_000);
    }
  });

  it('clamps jitter outside [0, 1)', () => {
    expect(retryDelayMs(1, -3)).toBe(retryDelayMs(1, 0));
    expect(retryDelayMs(1, Number.NaN)).toBe(retryDelayMs(1, 0));
    expect(retryDelayMs(1, 7)).toBeLessThan(5000);
  });

  it('treats attempt zero like the first', () => {
    expect(retryDelayMs(0, 0.5)).toBe(retryDelayMs(1, 0.5));
  });
});
