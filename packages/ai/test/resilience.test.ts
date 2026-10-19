import { describe, expect, it } from 'vitest';
import { AiError, type AiErrorCode } from '../src/errors.ts';
import {
  CircuitBreaker,
  DEFAULT_RETRY_POLICY,
  retriesInCall,
  retryDelayMs,
} from '../src/resilience.ts';

const err = (code: AiErrorCode, retryAfterMs?: number) =>
  new AiError(code, code, retryAfterMs === undefined ? {} : { retryAfterMs });

describe('retries inside one job attempt', () => {
  it.each<[AiErrorCode, boolean]>([
    ['ai_rate_limited', true],
    ['ai_overloaded', true],
    ['ai_server_error', true],
    ['ai_timeout', true],
    ['ai_connection', true],
    ['ai_spend_limit', false],
    ['ai_auth', false],
    ['ai_invalid_request', false],
    ['ai_output_malformed', false],
    ['ai_aborted', false],
    ['ai_unavailable', false],
  ])('%s retries in the call: %s', (code, expected) => {
    expect(retriesInCall(code)).toBe(expected);
  });

  it('backs off exponentially with equal jitter, capped', () => {
    const p = { maxAttempts: 10, baseDelayMs: 1000, maxDelayMs: 8000, maxRetryAfterMs: 30_000 };
    expect(retryDelayMs(1, p, () => 0)).toBe(500);
    expect(retryDelayMs(1, p, () => 0.999)).toBe(999);
    expect(retryDelayMs(3, p, () => 0)).toBe(2000);
    expect(retryDelayMs(9, p, () => 0)).toBe(4000);
  });

  it('honours retry-after, but hands long waits back to the queue', () => {
    expect(retryDelayMs(1, DEFAULT_RETRY_POLICY, () => 0.5, 2500)).toBe(2500);
    expect(retryDelayMs(1, DEFAULT_RETRY_POLICY, () => 0.5, 120_000)).toBeNull();
  });

  it('stops after the last attempt', () => {
    expect(
      retryDelayMs(DEFAULT_RETRY_POLICY.maxAttempts, DEFAULT_RETRY_POLICY, () => 0),
    ).toBeNull();
  });
});

describe('CircuitBreaker (PLAN §13: pause AI queues after repeated failures)', () => {
  function clock(start = 0) {
    let t = start;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  }

  it('opens after consecutive capacity failures and fails fast while open', () => {
    const c = clock();
    const b = new CircuitBreaker({ failureThreshold: 3, baseOpenMs: 1000 }, c.now);
    for (let i = 0; i < 2; i += 1) {
      b.acquire();
      b.failure(err('ai_overloaded'));
    }
    expect(b.state).toBe('closed');
    b.acquire();
    b.failure(err('ai_server_error'));
    expect(b.state).toBe('open');
    expect(b.pausedUntil()).toBe(1000);
    expect(() => {
      b.acquire();
    }).toThrow(expect.objectContaining({ code: 'ai_unavailable', retryAfterMs: 1000 }));
  });

  it('lets one probe through when the open period ends and closes on success', () => {
    const c = clock();
    const b = new CircuitBreaker({ failureThreshold: 1, baseOpenMs: 1000 }, c.now);
    b.acquire();
    b.failure(err('ai_timeout'));
    c.advance(1000);
    b.acquire();
    expect(b.state).toBe('half_open');
    expect(() => {
      b.acquire();
    }).toThrow(expect.objectContaining({ code: 'ai_unavailable' }));
    b.success();
    expect(b.state).toBe('closed');
    expect(b.pausedUntil()).toBeNull();
  });

  it('doubles the open period when the probe fails, up to the cap', () => {
    const c = clock();
    const b = new CircuitBreaker({ failureThreshold: 1, baseOpenMs: 1000, maxOpenMs: 3000 }, c.now);
    b.acquire();
    b.failure(err('ai_connection'));
    for (const expected of [2000, 3000, 3000]) {
      c.advance(10_000);
      b.acquire();
      b.failure(err('ai_connection'));
      expect(b.pausedUntil()).toBe(c.now() + expected);
    }
  });

  it('opens at once, for the long period, on a spend limit or a bad key', () => {
    for (const code of ['ai_spend_limit', 'ai_auth'] as const) {
      const c = clock(5);
      const b = new CircuitBreaker({ hardOpenMs: 3_600_000 }, c.now);
      b.acquire();
      b.failure(err(code));
      expect(b.state).toBe('open');
      expect(b.pausedUntil()).toBe(5 + 3_600_000);
    }
  });

  it('treats an answer from the API as proof it is up', () => {
    const c = clock();
    const b = new CircuitBreaker({ failureThreshold: 2 }, c.now);
    b.acquire();
    b.failure(err('ai_overloaded'));
    b.acquire();
    b.failure(err('ai_invalid_request'));
    b.acquire();
    b.failure(err('ai_overloaded'));
    expect(b.state).toBe('closed');
  });

  it('releases a probe that the caller aborted without judging the provider', () => {
    const c = clock();
    const b = new CircuitBreaker({ failureThreshold: 1, baseOpenMs: 1000 }, c.now);
    b.acquire();
    b.failure(err('ai_timeout'));
    c.advance(1000);
    b.acquire();
    b.failure(err('ai_aborted'));
    expect(b.state).toBe('half_open');
    b.acquire();
    b.success();
    expect(b.state).toBe('closed');
  });
});
