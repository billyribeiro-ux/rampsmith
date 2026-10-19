/**
 * Running a call: budget reservation, retries, the circuit breaker, cost accounting, the
 * `ai_calls` record, telemetry, and reading the answer through the task's schema and checks.
 * Synchronous calls go through `runCall`; batches reuse the same pieces (`batch.ts`).
 */
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { SpanStatusCode, metrics, trace, type Span } from '@opentelemetry/api';
import type {
  ContentBlockParam,
  Message,
  MessageCreateParamsNonStreaming,
} from '@anthropic-ai/sdk/resources/messages/messages';
import { budgetPeriod, type BudgetLedger } from './budget.ts';
import { costMicroUsd, worstCaseCostMicroUsd, type CallMode, type TokenUsage } from './cost.ts';
import { AiError, type AiErrorCode } from './errors.ts';
import type { ModelId } from './models.ts';
import type { Prompt } from './prompts.ts';
import {
  DEFAULT_RETRY_POLICY,
  retriesInCall,
  retryDelayMs,
  type CircuitBreaker,
  type RetryPolicy,
} from './resilience.ts';
import { thinkingParam, type Route, type Task } from './routing.ts';
import { classifyError, type AiTransport } from './transport.ts';

/** What a task makes of a schema-valid answer. */
export type TaskResult<T> =
  | { readonly status: 'draft'; readonly value: T; readonly flags: readonly string[] }
  | {
      readonly status: 'needs_review';
      readonly reasons: readonly string[];
      readonly flags: readonly string[];
    };

/** A request ready to send, with what is needed to price it and to read its answer. */
export interface PreparedCall<T> {
  readonly task: Task;
  readonly route: Route;
  readonly prompt: Prompt;
  readonly params: MessageCreateParamsNonStreaming;
  /** A deliberate overestimate of the prompt's tokens, for the budget reservation. */
  readonly estimatedInputTokens: number;
  /** Signals found in the input, carried into the result's flags. */
  readonly inputFlags: readonly string[];
  readonly accept: (output: unknown) => TaskResult<T>;
}

export type AiCallOutcome = 'ok' | 'needs_review' | 'refused' | 'truncated' | 'malformed' | 'error';

/**
 * One row of `ai_calls` (PLAN §9, §19): metadata only. Prompt content and model output are
 * never stored here (13-month retention, "prompt content is not stored").
 */
export interface AiCallRecord {
  readonly tenantId: string;
  readonly task: Task;
  readonly model: ModelId;
  readonly mode: CallMode;
  readonly promptVersion: string;
  readonly usage: TokenUsage;
  readonly thinkingTokens: number;
  readonly costMicroUsd: number;
  /** True when no usage came back and the reservation was kept as the cost. */
  readonly costIsEstimate: boolean;
  readonly batchId: string | null;
  readonly requestId: string | null;
  readonly outcome: AiCallOutcome;
  readonly errorCode: AiErrorCode | null;
  readonly attempts: number;
  readonly durationMs: number;
  readonly startedAt: string;
}

export interface AiCallSink {
  record(record: AiCallRecord): Promise<void>;
}

export interface AiDeps {
  readonly transport: AiTransport;
  readonly ledger: BudgetLedger;
  readonly breaker: CircuitBreaker;
  readonly sink: AiCallSink;
  /** The tenant's monthly AI budget in micro-dollars, from the entitlements function. */
  readonly budgetLimit: (tenantId: string) => Promise<number>;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly random?: () => number;
  readonly retry?: RetryPolicy;
}

export interface CallContext {
  readonly tenantId: string;
  readonly signal?: AbortSignal;
}

export interface CallOutcome<T> {
  readonly result: TaskResult<T>;
  readonly record: AiCallRecord;
}

const tracer = trace.getTracer('rampsmith.ai');
const meter = metrics.getMeter('rampsmith.ai');
const callCounter = meter.createCounter('rampsmith.ai.calls', {
  description: 'Claude calls by task, model, mode and outcome',
});
const costCounter = meter.createCounter('rampsmith.ai.cost', {
  unit: '{micro_usd}',
  description: 'Claude spend in micro-dollars by task and model',
});
const durationHistogram = meter.createHistogram('rampsmith.ai.call.duration', {
  unit: 's',
  description: 'Wall time of a Claude call, retries included',
});

/**
 * An opaque per-tenant id for the API's `metadata.user_id`, which Anthropic uses to detect
 * abuse and which must hold nothing identifying (API reference).
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/**
 * SHA-256 of a request in canonical JSON. Batch tickets keep it, so a result is only ever
 * read with the exact request that produced it (security audit MEDIUM-5).
 */
export function requestFingerprint(params: MessageCreateParamsNonStreaming): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(params)), 'utf8')
    .digest('hex');
}

function opaqueUserId(tenantId: string): string {
  return createHash('sha256')
    .update(`rampsmith-tenant:${tenantId}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
}

/**
 * The Messages API request for a task. The instruction prefix is the system prompt with a
 * cache breakpoint, so it is identical across calls and cached (PLAN §13); tenant data comes
 * after it, in the user turn. The response format is the prompt's wire schema.
 */
export function buildParams(
  route: Route,
  prompt: Prompt,
  content: ContentBlockParam[],
  tenantId: string,
): MessageCreateParamsNonStreaming {
  const thinking = thinkingParam(route);
  return {
    model: route.model,
    max_tokens: route.maxTokens,
    system: [
      {
        type: 'text',
        text: prompt.text,
        cache_control: { type: 'ephemeral', ttl: route.cacheTtl },
      },
    ],
    messages: [{ role: 'user', content }],
    output_config: {
      effort: route.effort,
      format: { type: 'json_schema', schema: { ...prompt.schema.wire } },
    },
    ...(thinking === undefined ? {} : { thinking }),
    metadata: { user_id: opaqueUserId(tenantId) },
  };
}

/** The response's usage in the shape the cost model prices. */
export function usageOf(
  message: Message,
  cacheTtl: Route['cacheTtl'],
): { usage: TokenUsage; thinking: number } {
  const u = message.usage;
  const created = u.cache_creation_input_tokens ?? 0;
  const split = u.cache_creation;
  const cacheWrite5m =
    split === null ? (cacheTtl === '5m' ? created : 0) : split.ephemeral_5m_input_tokens;
  const cacheWrite1h =
    split === null ? (cacheTtl === '1h' ? created : 0) : split.ephemeral_1h_input_tokens;
  return {
    usage: {
      input: u.input_tokens,
      output: u.output_tokens,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite5m,
      cacheWrite1h,
    },
    thinking: u.output_tokens_details?.thinking_tokens ?? 0,
  };
}

const MAX_OUTPUT_CHARS = 200_000;

/**
 * Reads a response: a refusal, a truncation or anything but one JSON text block that passes
 * the strict schema is an `AiError`, never a guess (PLAN §13). Thinking blocks are ignored.
 */
export function interpret<T>(call: PreparedCall<T>, message: Message): TaskResult<T> {
  const stop = message.stop_reason;
  if (stop === 'refusal') {
    throw new AiError('ai_refused', `the model declined the ${call.task} task`);
  }
  if (stop === 'max_tokens' || stop === 'model_context_window_exceeded') {
    throw new AiError('ai_output_truncated', `the ${call.task} output hit its token limit`);
  }
  if (stop !== 'end_turn') {
    throw new AiError(
      'ai_output_malformed',
      `the ${call.task} output stopped with ${String(stop)}`,
    );
  }
  const texts = message.content.filter((b) => b.type === 'text');
  const only = texts.length === 1 ? texts[0] : undefined;
  if (only === undefined || only.text.length > MAX_OUTPUT_CHARS) {
    throw new AiError('ai_output_malformed', `the ${call.task} output was not one text block`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(only.text) as unknown;
  } catch {
    throw new AiError('ai_output_malformed', `the ${call.task} output was not JSON`);
  }
  const checked = call.prompt.schema.check(parsed);
  if (!checked.ok) {
    throw new AiError('ai_output_malformed', `the ${call.task} output ${checked.reason}`);
  }
  let result: TaskResult<T>;
  try {
    result = call.accept(checked.value);
  } catch {
    // A check that cannot evaluate the output fails closed and permanently; retrying would pay
    // for the same answer again (security audit LOW-6).
    throw new AiError('ai_output_malformed', `the ${call.task} output could not be checked`);
  }
  return call.inputFlags.length === 0
    ? result
    : { ...result, flags: [...new Set([...call.inputFlags, ...result.flags])] };
}

const OUTCOMES: Partial<Record<AiErrorCode, AiCallOutcome>> = {
  ai_refused: 'refused',
  ai_output_truncated: 'truncated',
  ai_output_malformed: 'malformed',
};

export function outcomeOf(error: AiError): AiCallOutcome {
  return OUTCOMES[error.code] ?? 'error';
}

/** Failures after which the request may have been processed and billed. */
const AMBIGUOUS: ReadonlySet<AiErrorCode> = new Set<AiErrorCode>([
  'ai_timeout',
  'ai_connection',
  'ai_aborted',
]);

const ZERO: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };

export function observe(record: AiCallRecord, span?: Span): void {
  const attributes = {
    'rampsmith.ai.task': record.task,
    'gen_ai.request.model': record.model,
    'rampsmith.ai.mode': record.mode,
    'rampsmith.ai.outcome': record.outcome,
  };
  callCounter.add(1, attributes);
  costCounter.add(record.costMicroUsd, {
    'rampsmith.ai.task': record.task,
    'gen_ai.request.model': record.model,
  });
  if (record.mode === 'sync') {
    durationHistogram.record(record.durationMs / 1000, attributes);
  }
  span?.setAttributes({
    ...attributes,
    'gen_ai.system': 'anthropic',
    'gen_ai.usage.input_tokens': record.usage.input,
    'gen_ai.usage.output_tokens': record.usage.output,
    'rampsmith.ai.cache_read_tokens': record.usage.cacheRead,
    'rampsmith.ai.prompt_version': record.promptVersion,
    'rampsmith.ai.cost_micro_usd': record.costMicroUsd,
    'rampsmith.ai.attempts': record.attempts,
    'rampsmith.tenant_id': record.tenantId,
    ...(record.errorCode === null ? {} : { 'rampsmith.ai.error_code': record.errorCode }),
  });
}

const defaultSleep = async (ms: number, signal?: AbortSignal): Promise<void> => {
  await delay(ms, undefined, signal === undefined ? {} : { signal });
};

/**
 * Runs one synchronous call end to end. Throws `AiError` for every failure, after recording
 * it whenever the call reached the provider.
 */
export async function runCall<T>(
  deps: AiDeps,
  call: PreparedCall<T>,
  context: CallContext,
): Promise<CallOutcome<T>> {
  return tracer.startActiveSpan(`ai.${call.task}`, async (span) => {
    try {
      const outcome = await runCallInSpan(deps, call, context, span);
      span.setStatus({ code: SpanStatusCode.OK });
      return outcome;
    } catch (error: unknown) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof AiError ? error.code : 'error',
      });
      throw error;
    } finally {
      span.end();
    }
  });
}

async function runCallInSpan<T>(
  deps: AiDeps,
  call: PreparedCall<T>,
  context: CallContext,
  span: Span,
): Promise<CallOutcome<T>> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const random = deps.random ?? Math.random;
  const policy = deps.retry ?? DEFAULT_RETRY_POLICY;
  const { route } = call;
  const started = now();
  const limit = await deps.budgetLimit(context.tenantId);
  const worst = worstCaseCostMicroUsd(
    route.model,
    'sync',
    call.estimatedInputTokens,
    route.maxTokens,
  );
  const reserved = await deps.ledger.reserve({
    tenantId: context.tenantId,
    period: budgetPeriod(started),
    amountMicroUsd: worst,
    limitMicroUsd: limit,
  });
  if (!reserved.ok) {
    throw new AiError(
      'ai_budget_exhausted',
      `the monthly AI budget cannot cover a ${call.task} call`,
    );
  }
  const reservationId = reserved.reservation.id;

  const base = {
    tenantId: context.tenantId,
    task: call.task,
    model: route.model,
    mode: 'sync' as const,
    promptVersion: call.prompt.version,
    batchId: null,
    startedAt: new Date(started).toISOString(),
  };

  let attempts = 0;
  let ambiguousAttempts = 0;
  let response;
  for (;;) {
    attempts += 1;
    try {
      deps.breaker.acquire();
      response = await deps.transport.createMessage(call.params, {
        signal: context.signal,
        timeoutMs: route.timeoutMs,
      });
      deps.breaker.success();
      break;
    } catch (thrown: unknown) {
      const error = classifyError(thrown, now());
      deps.breaker.failure(error);
      ambiguousAttempts += AMBIGUOUS.has(error.code) ? 1 : 0;
      const wait = retriesInCall(error.code)
        ? retryDelayMs(attempts, policy, random, error.retryAfterMs)
        : null;
      if (wait !== null && context.signal?.aborted !== true) {
        try {
          await sleep(wait, context.signal);
          continue;
        } catch {
          // Aborted while waiting: fall through and fail with the last error.
        }
      }
      // A timeout or a dropped connection may still have been billed: keep the worst case.
      const ambiguous = ambiguousAttempts > 0;
      const estimate = worst * ambiguousAttempts;
      const reachedProvider = error.code !== 'ai_unavailable' || attempts > 1;
      if (ambiguous) {
        await deps.ledger.settle(reservationId, estimate);
      } else {
        await deps.ledger.release(reservationId);
      }
      if (reachedProvider) {
        const record: AiCallRecord = {
          ...base,
          usage: ZERO,
          thinkingTokens: 0,
          costMicroUsd: estimate,
          costIsEstimate: ambiguous,
          requestId: error.requestId ?? null,
          outcome: 'error',
          errorCode: error.code,
          attempts,
          durationMs: now() - started,
        };
        observe(record, span);
        await deps.sink.record(record);
      }
      throw error;
    }
  }

  const { usage, thinking } = usageOf(response.message, route.cacheTtl);
  const cost = costMicroUsd(route.model, 'sync', usage);
  // Earlier attempts that timed out may have been billed too; count their worst case.
  const charged = cost + worst * ambiguousAttempts;
  await deps.ledger.settle(reservationId, charged);
  const finish = async (outcome: AiCallOutcome, errorCode: AiErrorCode | null) => {
    const record: AiCallRecord = {
      ...base,
      usage,
      thinkingTokens: thinking,
      costMicroUsd: charged,
      costIsEstimate: ambiguousAttempts > 0,
      requestId: response.requestId ?? null,
      outcome,
      errorCode,
      attempts,
      durationMs: now() - started,
    };
    observe(record, span);
    await deps.sink.record(record);
    return record;
  };
  let result: TaskResult<T>;
  try {
    result = interpret(call, response.message);
  } catch (thrown: unknown) {
    const error = thrown instanceof AiError ? thrown : classifyError(thrown);
    await finish(outcomeOf(error), error.code);
    throw error;
  }
  const record = await finish(result.status === 'draft' ? 'ok' : 'needs_review', null);
  return { result, record };
}
