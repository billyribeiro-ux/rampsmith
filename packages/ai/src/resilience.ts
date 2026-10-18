/**
 * Retries, timeouts and the provider-outage behaviour (PLAN §13 "Data handling and
 * resilience"; ADR-215). HTTP 429 and overload responses retry with backoff inside one job
 * attempt; a circuit breaker pauses AI work after repeated failures, so scans continue
 * without AI drafts while the provider recovers.
 */
import { AiError, type AiErrorCode } from './errors.ts';

export interface RetryPolicy {
  /** Attempts per call, the first included. */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** A longer `retry-after` hands the job back to the queue instead of waiting. */
  readonly maxRetryAfterMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 16_000,
  maxRetryAfterMs: 30_000,
};

/** Capacity and transport failures: worth another attempt within the same job attempt. */
const IN_CALL: ReadonlySet<AiErrorCode> = new Set<AiErrorCode>([
  'ai_rate_limited',
  'ai_overloaded',
  'ai_server_error',
  'ai_timeout',
  'ai_connection',
]);

export function retriesInCall(code: AiErrorCode): boolean {
  return IN_CALL.has(code);
}

/**
 * The wait before the next attempt after attempt `attempt` (1-based) failed, or `null` to
 * stop retrying in this call. `retry-after` wins when present; otherwise the delay is
 * exponential with equal jitter, like the queue's own backoff (ADR-018).
 */
export function retryDelayMs(
  attempt: number,
  policy: RetryPolicy,
  random: () => number,
  retryAfterMs?: number,
): number | null {
  if (attempt >= policy.maxAttempts) {
    return null;
  }
  if (retryAfterMs !== undefined) {
    return retryAfterMs > policy.maxRetryAfterMs ? null : Math.max(0, retryAfterMs);
  }
  const exponential = Math.min(
    policy.maxDelayMs,
    policy.baseDelayMs * 2 ** Math.max(0, attempt - 1),
  );
  const half = Math.floor(exponential / 2);
  const jitter = Math.min(Math.max(random(), 0), 0.999_999_999);
  return half + Math.floor(jitter * half);
}

export interface BreakerOptions {
  /** Consecutive capacity failures that open the circuit. */
  readonly failureThreshold?: number;
  readonly baseOpenMs?: number;
  readonly maxOpenMs?: number;
  /** How long a spend limit or a rejected key keeps the circuit open. */
  readonly hardOpenMs?: number;
}

export type BreakerState = 'closed' | 'open' | 'half_open';

/** Failures that open the circuit at once: no retry can succeed until someone acts. */
const HARD: ReadonlySet<AiErrorCode> = new Set<AiErrorCode>(['ai_spend_limit', 'ai_auth']);
/** Failures that say nothing about the provider. */
const NEUTRAL: ReadonlySet<AiErrorCode> = new Set<AiErrorCode>([
  'ai_aborted',
  'ai_unavailable',
  'ai_budget_exhausted',
  'ai_input_invalid',
]);

/**
 * A per-process circuit breaker. Closed, it counts consecutive capacity failures; open, it
 * fails fast with `ai_unavailable` and tells the ai worker to stop claiming jobs until
 * `pausedUntil()`; half-open, it lets one probe through.
 */
export class CircuitBreaker {
  readonly #threshold: number;
  readonly #baseOpenMs: number;
  readonly #maxOpenMs: number;
  readonly #hardOpenMs: number;
  readonly #now: () => number;
  #state: BreakerState = 'closed';
  #failures = 0;
  #openMs: number;
  #openUntil = 0;
  #probeInFlight = false;

  constructor(options: BreakerOptions = {}, now: () => number = Date.now) {
    this.#threshold = options.failureThreshold ?? 5;
    this.#baseOpenMs = options.baseOpenMs ?? 30_000;
    this.#maxOpenMs = options.maxOpenMs ?? 600_000;
    this.#hardOpenMs = options.hardOpenMs ?? 3_600_000;
    this.#openMs = this.#baseOpenMs;
    this.#now = now;
  }

  get state(): BreakerState {
    return this.#state;
  }

  /** Call before every request; throws `ai_unavailable` when no request may be made. */
  acquire(): void {
    const now = this.#now();
    if (this.#state === 'open') {
      if (now < this.#openUntil) {
        throw new AiError('ai_unavailable', 'AI calls are paused after repeated failures', {
          retryAfterMs: this.#openUntil - now,
        });
      }
      this.#state = 'half_open';
      this.#probeInFlight = false;
    }
    if (this.#state === 'half_open') {
      if (this.#probeInFlight) {
        throw new AiError('ai_unavailable', 'AI calls are paused while a probe runs', {
          retryAfterMs: 1000,
        });
      }
      this.#probeInFlight = true;
    }
  }

  success(): void {
    this.#state = 'closed';
    this.#failures = 0;
    this.#openMs = this.#baseOpenMs;
    this.#probeInFlight = false;
  }

  failure(error: AiError): void {
    if (NEUTRAL.has(error.code)) {
      this.#probeInFlight = false;
      return;
    }
    if (HARD.has(error.code)) {
      this.#open(this.#hardOpenMs);
      return;
    }
    if (!IN_CALL.has(error.code)) {
      // The API answered (an invalid request, a refusal, malformed output): it is up.
      this.success();
      return;
    }
    if (this.#state === 'half_open') {
      this.#openMs = Math.min(this.#openMs * 2, this.#maxOpenMs);
      this.#open(this.#openMs);
      return;
    }
    this.#failures += 1;
    if (this.#failures >= this.#threshold) {
      this.#open(this.#openMs);
    }
  }

  /** Until when AI queues should not be claimed, in epoch milliseconds, or `null`. */
  pausedUntil(): number | null {
    return this.#state === 'open' && this.#now() < this.#openUntil ? this.#openUntil : null;
  }

  #open(durationMs: number): void {
    this.#state = 'open';
    this.#openUntil = this.#now() + durationMs;
    this.#probeInFlight = false;
    this.#failures = 0;
  }
}
