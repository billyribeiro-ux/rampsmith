/**
 * The seam between Rampsmith and the Claude API. `AiTransport` is what the rest of the package
 * calls; `createAnthropicTransport` implements it with the official TypeScript SDK
 * (`@anthropic-ai/sdk`, ADR-211) and tests use fakes. The SDK's own retries are turned off
 * (`maxRetries: 0`) so that retries, the circuit breaker and cost accounting see every attempt
 * (ADR-215).
 */
import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from '@anthropic-ai/sdk';
import type {
  Message,
  MessageCreateParamsNonStreaming,
} from '@anthropic-ai/sdk/resources/messages/messages';
import { AiError } from './errors.ts';

export interface CallOptions {
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs: number;
}

export interface TransportResponse {
  readonly message: Message;
  readonly requestId: string | undefined;
}

export interface BatchRequest {
  /** `^[a-zA-Z0-9_-]{1,64}$` (batch-processing docs). */
  readonly custom_id: string;
  readonly params: MessageCreateParamsNonStreaming;
}

export interface BatchStatus {
  readonly id: string;
  readonly processingStatus: 'in_progress' | 'canceling' | 'ended';
  readonly counts: {
    readonly processing: number;
    readonly succeeded: number;
    readonly errored: number;
    readonly canceled: number;
    readonly expired: number;
  };
}

export type BatchItemResult =
  | { readonly customId: string; readonly type: 'succeeded'; readonly message: Message }
  | { readonly customId: string; readonly type: 'errored'; readonly errorType: string }
  | { readonly customId: string; readonly type: 'canceled' }
  | { readonly customId: string; readonly type: 'expired' };

export interface AiTransport {
  createMessage(
    params: MessageCreateParamsNonStreaming,
    options: CallOptions,
  ): Promise<TransportResponse>;
  createBatch(
    requests: readonly BatchRequest[],
    options: CallOptions,
  ): Promise<{ readonly id: string }>;
  retrieveBatch(id: string, options: CallOptions): Promise<BatchStatus>;
  batchResults(id: string, options: CallOptions): AsyncIterable<BatchItemResult>;
  /** Deletes the batch and its stored inputs and results, which otherwise stay 29 days. */
  deleteBatch(id: string, options: CallOptions): Promise<void>;
}

export interface AnthropicTransportOptions {
  /** From `ANTHROPIC_API_KEY` (LAUNCH.md section C, row 5); never logged. */
  readonly apiKey: string;
  readonly baseURL?: string;
  /** For tests: a fetch that serves recorded HTTP responses. */
  readonly fetch?: typeof fetch;
}

export function createAnthropicTransport(options: AnthropicTransportOptions): AiTransport {
  if (options.apiKey.trim() === '') {
    throw new AiError('ai_auth', 'ANTHROPIC_API_KEY is empty (LAUNCH.md section C, row 5)');
  }
  const client = new Anthropic({
    apiKey: options.apiKey,
    maxRetries: 0,
    // Fixed here so that no environment variable can make the SDK put prompts or answers in
    // spans or logs (PLAN §19; security audit MEDIUM-4): metadata-only spans, no trace
    // headers sent to Anthropic, and no SDK logging. Failures surface as AiError instead.
    openTelemetry: { propagation: false, traces: { enabled: true, contentMode: 'metadata_only' } },
    logLevel: 'off',
    ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const request = (o: CallOptions) => ({
    timeout: o.timeoutMs,
    maxRetries: 0,
    ...(o.signal === undefined ? {} : { signal: o.signal }),
  });
  const guard = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error: unknown) {
      throw classifyError(error);
    }
  };
  return {
    createMessage: (params, o) =>
      guard(async () => {
        const message = await client.messages.create(params, request(o));
        const requestId = (message as { _request_id?: string | null })._request_id ?? undefined;
        return { message, requestId };
      }),
    createBatch: (requests, o) =>
      guard(async () => {
        const batch = await client.messages.batches.create({ requests: [...requests] }, request(o));
        return { id: batch.id };
      }),
    retrieveBatch: (id, o) =>
      guard(async () => {
        const batch = await client.messages.batches.retrieve(id, null, request(o));
        return {
          id: batch.id,
          processingStatus: batch.processing_status,
          counts: batch.request_counts,
        };
      }),
    batchResults: (id, o) => ({
      async *[Symbol.asyncIterator]() {
        const decoder = await guard(() =>
          client.messages.batches.results(id, undefined, request(o)),
        );
        try {
          for await (const item of decoder) {
            const result = item.result;
            switch (result.type) {
              case 'succeeded':
                yield { customId: item.custom_id, type: 'succeeded', message: result.message };
                break;
              case 'errored':
                yield {
                  customId: item.custom_id,
                  type: 'errored',
                  errorType: result.error.error.type,
                };
                break;
              case 'canceled':
              case 'expired':
                yield { customId: item.custom_id, type: result.type };
                break;
            }
          }
        } catch (error: unknown) {
          throw classifyError(error);
        }
      },
    }),
    deleteBatch: (id, o) =>
      guard(async () => {
        await client.messages.batches.delete(id, null, request(o));
      }),
  };
}

/** Seconds (possibly fractional) or an HTTP date, as `retry-after` allows. */
export function parseRetryAfter(headers: Headers | undefined, nowMs: number): number | undefined {
  const ms = headers?.get('retry-after-ms');
  if (ms !== null && ms !== undefined && /^\d+(?:\.\d+)?$/u.test(ms)) {
    return Math.ceil(Number(ms));
  }
  const value = headers?.get('retry-after');
  if (value === null || value === undefined || value.trim() === '') {
    return undefined;
  }
  if (/^\d+(?:\.\d+)?$/u.test(value.trim())) {
    return Math.ceil(Number(value) * 1000);
  }
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - nowMs);
}

function errorCodeOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) {
    return undefined;
  }
  const inner = (body as { error?: unknown }).error;
  const details =
    typeof inner === 'object' && inner !== null
      ? (inner as { details?: unknown }).details
      : undefined;
  const code =
    typeof details === 'object' && details !== null
      ? (details as { error_code?: unknown }).error_code
      : undefined;
  return typeof code === 'string' ? code : undefined;
}

const SPEND_LIMIT_MESSAGE = /reached your specified (?:workspace )?API usage limits/iu;

/**
 * Maps any failure of a Claude API call onto an `AiError` (errors docs:
 * https://platform.claude.com/docs/en/api/errors). The provider's message is not copied,
 * only the status, the error type and the request id.
 */
export function classifyError(error: unknown, nowMs: number = Date.now()): AiError {
  if (error instanceof AiError) {
    return error;
  }
  if (error instanceof APIUserAbortError) {
    return new AiError('ai_aborted', 'the call was aborted', { cause: error });
  }
  if (error instanceof APIConnectionTimeoutError) {
    return new AiError('ai_timeout', 'the call timed out', { cause: error });
  }
  if (error instanceof APIConnectionError) {
    return new AiError('ai_connection', 'could not reach the Claude API', { cause: error });
  }
  if (error instanceof APIError) {
    const status = typeof error.status === 'number' ? error.status : undefined;
    const requestId = error.requestID ?? undefined;
    const base = { status, requestId };
    const label = `Claude API returned ${String(status)} ${error.type ?? 'error'}`;
    if (status === 429) {
      if (errorCodeOf(error.error) === 'enforced_spend_limit_reached') {
        return new AiError('ai_spend_limit', `${label}: monthly spend cap reached`, base);
      }
      return new AiError('ai_rate_limited', label, {
        ...base,
        retryAfterMs: parseRetryAfter(error.headers as Headers | undefined, nowMs),
      });
    }
    if (status === 400 && SPEND_LIMIT_MESSAGE.test(error.message)) {
      return new AiError('ai_spend_limit', `${label}: spend limit reached`, base);
    }
    if (status === 401 || status === 403) {
      return new AiError('ai_auth', label, base);
    }
    if (status === 402) {
      return new AiError('ai_spend_limit', `${label}: billing`, base);
    }
    if (status === 413) {
      return new AiError('ai_request_too_large', label, base);
    }
    if (status === 529) {
      return new AiError('ai_overloaded', label, base);
    }
    if (status === 504) {
      return new AiError('ai_timeout', label, base);
    }
    if (status !== undefined && status >= 500) {
      return new AiError('ai_server_error', label, base);
    }
    return new AiError('ai_invalid_request', label, base);
  }
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return new AiError('ai_timeout', 'the call timed out', { cause: error });
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new AiError('ai_aborted', 'the call was aborted', { cause: error });
  }
  return new AiError('ai_connection', 'the Claude API call failed', { cause: error });
}
