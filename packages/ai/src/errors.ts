/**
 * Every failure the AI subsystem reports, with a stable `snake_case` code and whether the job
 * should be retried. The engine maps an `AiError` onto the queue's `JobFailure`
 * (`kind: retryable ? 'retryable' : 'permanent'`, `{ code, message }`). Messages never hold
 * prompt content, model output, tokens or personal data (PLAN §8).
 */

export type AiErrorCode =
  /** The circuit breaker is open: the provider failed repeatedly (PLAN §13). */
  | 'ai_unavailable'
  | 'ai_rate_limited'
  | 'ai_overloaded'
  | 'ai_server_error'
  | 'ai_timeout'
  | 'ai_connection'
  /** The organization reached its monthly spend cap or a spend limit set in the Console. */
  | 'ai_spend_limit'
  /** The API key is missing, invalid or lacks permission (LAUNCH.md section C, row 5). */
  | 'ai_auth'
  | 'ai_invalid_request'
  | 'ai_request_too_large'
  /** The caller's signal aborted the call, for example because the job lost its lease. */
  | 'ai_aborted'
  | 'ai_refused'
  | 'ai_output_truncated'
  /** The response was not valid JSON for the task's schema: a failed job, never a guess. */
  | 'ai_output_malformed'
  /** The tenant's monthly AI budget cannot cover the call's worst case (PLAN §13). */
  | 'ai_budget_exhausted'
  /** The caller passed input the task cannot send, such as an oversized image. */
  | 'ai_input_invalid';

const RETRYABLE: ReadonlySet<AiErrorCode> = new Set<AiErrorCode>([
  'ai_unavailable',
  'ai_rate_limited',
  'ai_overloaded',
  'ai_server_error',
  'ai_timeout',
  'ai_connection',
  'ai_spend_limit',
  'ai_auth',
  'ai_aborted',
]);

export class AiError extends Error {
  readonly code: AiErrorCode;
  readonly retryable: boolean;
  /** How long to wait before trying again, when the provider or the breaker says so. */
  readonly retryAfterMs: number | undefined;
  /** HTTP status of the provider's response, when there was one. */
  readonly status: number | undefined;
  /** The provider's `request-id`, safe to log and to quote to Anthropic support. */
  readonly requestId: string | undefined;

  constructor(
    code: AiErrorCode,
    message: string,
    details: {
      readonly retryAfterMs?: number | undefined;
      readonly status?: number | undefined;
      readonly requestId?: string | undefined;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'AiError';
    this.code = code;
    this.retryable = RETRYABLE.has(code);
    this.retryAfterMs = details.retryAfterMs;
    this.status = details.status;
    this.requestId = details.requestId;
  }
}

export function isAiError(value: unknown): value is AiError {
  return value instanceof AiError;
}
