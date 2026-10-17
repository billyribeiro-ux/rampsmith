/**
 * Retry delays: exponential with equal jitter, capped at one hour (PLAN §10, ADR-018).
 * Must equal `retry_delay` in crates/queue; both are tested against
 * crates/queue/testdata/backoff.json.
 */
const BASE_MS = 5_000;
const CAP_MS = 3_600_000;

/**
 * Delay in milliseconds before retrying after failed attempt number `attempt` (1-based).
 * `e = min(1 h, 5 s × 2^(attempt − 1))`; the delay is `e/2 + ⌊jitter × e/2⌋`. `jitter` is a
 * uniform sample in `[0, 1)`; values outside it are clamped.
 */
export function retryDelayMs(attempt: number, jitter: number): number {
  const exponent = Math.min(Math.max(Math.trunc(attempt) - 1, 0), 30);
  const exponential = Math.min(BASE_MS * 2 ** exponent, CAP_MS);
  const half = Math.floor(exponential / 2);
  const j = Number.isNaN(jitter) ? 0 : Math.min(Math.max(jitter, 0), 0.999_999_999);
  return half + Math.floor(j * half);
}
