/**
 * The Message Batches API path (PLAN §10 queues `ai.*`, §13 "Batch API"; ADR-215), at half
 * the synchronous price. The ai worker submits a batch, stores the returned ticket in its job
 * payload, polls with a delayed job, collects the results, persists them and then retires the
 * batch, which deletes Anthropic's stored copy instead of leaving it for 29 days (ADR-216).
 *
 * Batch limits (https://platform.claude.com/docs/en/build-with-claude/batch-processing):
 * 100,000 requests or 256 MB per batch, `custom_id` matching `^[a-zA-Z0-9_-]{1,64}$`, results
 * within 24 hours or the request expires, and results returned in any order.
 */
import { budgetPeriod } from './budget.ts';
import {
  interpret,
  observe,
  outcomeOf,
  usageOf,
  type AiCallRecord,
  type AiDeps,
  type CallOutcome,
  type PreparedCall,
} from './calls.ts';
import { costMicroUsd, worstCaseCostMicroUsd } from './cost.ts';
import { AiError } from './errors.ts';
import type { ModelId } from './models.ts';
import { DEFAULT_RETRY_POLICY, retriesInCall, retryDelayMs } from './resilience.ts';
import type { Task } from './routing.ts';
import {
  classifyError,
  type BatchRequest,
  type BatchStatus,
  type CallOptions,
} from './transport.ts';

export const CUSTOM_ID = /^[a-zA-Z0-9_-]{1,64}$/u;
/** Stays clear of the documented 256 MB request limit. */
export const MAX_BATCH_BYTES = 200 * 1024 * 1024;
export const MAX_BATCH_REQUESTS = 100_000;

const TIMEOUT: CallOptions = { timeoutMs: 120_000 };

export interface BatchItem<T> {
  /** Unique within the batch; the engine uses the job or fix id without separators. */
  readonly customId: string;
  readonly tenantId: string;
  readonly call: PreparedCall<T>;
}

/** What the worker stores to collect a batch later. Plain JSON, no prompt content. */
export interface BatchTicket {
  readonly batchId: string;
  readonly submittedAt: string;
  readonly items: readonly {
    readonly customId: string;
    readonly tenantId: string;
    readonly task: Task;
    readonly model: ModelId;
    readonly promptVersion: string;
    readonly reservationId: string;
    readonly reservedMicroUsd: number;
  }[];
}

export interface SubmitResult {
  /** `null` when every item was refused. */
  readonly ticket: BatchTicket | null;
  readonly refused: readonly { readonly customId: string; readonly error: AiError }[];
}

/** Splits items so that each batch stays inside the documented limits. */
export function chunkBatchItems<T>(
  items: readonly BatchItem<T>[],
  limits: { readonly maxBytes?: number; readonly maxRequests?: number } = {},
): BatchItem<T>[][] {
  const maxBytes = limits.maxBytes ?? MAX_BATCH_BYTES;
  const maxRequests = limits.maxRequests ?? MAX_BATCH_REQUESTS;
  const chunks: BatchItem<T>[][] = [];
  let current: BatchItem<T>[] = [];
  let bytes = 0;
  for (const item of items) {
    const size = Buffer.byteLength(
      JSON.stringify({ custom_id: item.customId, params: item.call.params }),
    );
    if (size > maxBytes) {
      throw new AiError(
        'ai_request_too_large',
        'one batch request is larger than a whole batch may be',
      );
    }
    if (current.length > 0 && (bytes + size > maxBytes || current.length >= maxRequests)) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += size;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

/**
 * Reserves each item's worst case at batch prices, then creates one batch with the items the
 * budget covers. Items over budget are refused with `ai_budget_exhausted` and never sent.
 */
export async function submitBatch<T>(
  deps: AiDeps,
  items: readonly BatchItem<T>[],
): Promise<SubmitResult> {
  const now = deps.now ?? Date.now;
  const seen = new Set<string>();
  for (const item of items) {
    if (!CUSTOM_ID.test(item.customId) || seen.has(item.customId)) {
      throw new AiError(
        'ai_input_invalid',
        'every batch item needs a unique custom_id of 1 to 64 safe characters',
      );
    }
    seen.add(item.customId);
  }
  if (chunkBatchItems(items).length > 1) {
    throw new AiError(
      'ai_request_too_large',
      'the batch exceeds the documented limits; chunk it first',
    );
  }
  const period = budgetPeriod(now());
  const accepted: { item: BatchItem<T>; reservationId: string; reserved: number }[] = [];
  const refused: { customId: string; error: AiError }[] = [];
  const limits = new Map<string, number>();
  for (const item of items) {
    const limit = limits.get(item.tenantId) ?? (await deps.budgetLimit(item.tenantId));
    limits.set(item.tenantId, limit);
    const { route } = item.call;
    const worst = worstCaseCostMicroUsd(
      route.model,
      'batch',
      item.call.estimatedInputTokens,
      route.maxTokens,
    );
    const r = await deps.ledger.reserve({
      tenantId: item.tenantId,
      period,
      amountMicroUsd: worst,
      limitMicroUsd: limit,
    });
    if (r.ok) {
      accepted.push({ item, reservationId: r.reservation.id, reserved: worst });
    } else {
      refused.push({
        customId: item.customId,
        error: new AiError(
          'ai_budget_exhausted',
          `the monthly AI budget cannot cover a ${item.call.task} call`,
        ),
      });
    }
  }
  if (accepted.length === 0) {
    return { ticket: null, refused };
  }
  const requests: BatchRequest[] = accepted.map(({ item }) => ({
    custom_id: item.customId,
    params: item.call.params,
  }));
  const policy = deps.retry ?? DEFAULT_RETRY_POLICY;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let batchId: string | undefined;
  for (let attempt = 1; batchId === undefined; attempt += 1) {
    try {
      deps.breaker.acquire();
      batchId = (await deps.transport.createBatch(requests, TIMEOUT)).id;
      deps.breaker.success();
    } catch (thrown: unknown) {
      const error = classifyError(thrown, now());
      deps.breaker.failure(error);
      const wait = retriesInCall(error.code)
        ? retryDelayMs(attempt, policy, deps.random ?? Math.random, error.retryAfterMs)
        : null;
      if (wait === null) {
        // Creating a batch bills nothing; give every reservation back.
        await Promise.all(accepted.map((a) => deps.ledger.release(a.reservationId)));
        throw error;
      }
      await sleep(wait);
    }
  }
  return {
    ticket: {
      batchId,
      submittedAt: new Date(now()).toISOString(),
      items: accepted.map(({ item, reservationId, reserved }) => ({
        customId: item.customId,
        tenantId: item.tenantId,
        task: item.call.task,
        model: item.call.route.model,
        promptVersion: item.call.prompt.version,
        reservationId,
        reservedMicroUsd: reserved,
      })),
    },
    refused,
  };
}

/** The batch's processing state; collect once it is `ended`. */
export async function pollBatch(deps: AiDeps, batchId: string): Promise<BatchStatus> {
  try {
    return await deps.transport.retrieveBatch(batchId, TIMEOUT);
  } catch (thrown: unknown) {
    throw classifyError(thrown);
  }
}

export type BatchItemOutcome<T> =
  | ({ readonly customId: string; readonly ok: true } & CallOutcome<T>)
  | {
      readonly customId: string;
      readonly ok: false;
      readonly error: AiError;
      readonly record: AiCallRecord | null;
    };

/**
 * Reads every result of an ended batch, settles each reservation at the item's actual cost,
 * records each call, and interprets each answer with the call the engine rebuilt from its
 * stored input (`lookup`), which must return the same `PreparedCall` that was submitted.
 * Items that errored, expired or were canceled are not billed: their reservation is released
 * and the error says whether to resubmit.
 */
export async function collectBatch<T>(
  deps: AiDeps,
  ticket: BatchTicket,
  lookup: (customId: string) => PreparedCall<T> | undefined,
): Promise<BatchItemOutcome<T>[]> {
  const now = deps.now ?? Date.now;
  const byId = new Map(ticket.items.map((i) => [i.customId, i]));
  const outcomes: BatchItemOutcome<T>[] = [];
  const done = new Set<string>();
  try {
    for await (const result of deps.transport.batchResults(ticket.batchId, TIMEOUT)) {
      const item = byId.get(result.customId);
      if (item === undefined || done.has(result.customId)) {
        continue;
      }
      done.add(result.customId);
      const base = {
        tenantId: item.tenantId,
        task: item.task,
        model: item.model,
        mode: 'batch' as const,
        promptVersion: item.promptVersion,
        batchId: ticket.batchId,
        startedAt: ticket.submittedAt,
        attempts: 1,
        durationMs: Math.max(0, now() - Date.parse(ticket.submittedAt)),
      };
      if (result.type !== 'succeeded') {
        await deps.ledger.release(item.reservationId);
        const code =
          result.type === 'errored' && result.errorType === 'invalid_request_error'
            ? 'ai_invalid_request'
            : 'ai_server_error';
        outcomes.push({
          customId: result.customId,
          ok: false,
          error: new AiError(code, `the batch request ${result.type}`),
          record: null,
        });
        continue;
      }
      const call = lookup(result.customId);
      const { usage, thinking } = usageOf(result.message, call?.route.cacheTtl ?? '1h');
      const cost = costMicroUsd(item.model, 'batch', usage);
      await deps.ledger.settle(item.reservationId, cost);
      const record = (outcome: AiCallRecord['outcome'], errorCode: AiCallRecord['errorCode']) => {
        const r: AiCallRecord = {
          ...base,
          usage,
          thinkingTokens: thinking,
          costMicroUsd: cost,
          costIsEstimate: false,
          requestId: null,
          outcome,
          errorCode,
        };
        observe(r);
        return r;
      };
      if (call?.prompt.version !== item.promptVersion || call.task !== item.task) {
        const r = record('error', 'ai_input_invalid');
        await deps.sink.record(r);
        outcomes.push({
          customId: result.customId,
          ok: false,
          error: new AiError(
            'ai_input_invalid',
            'the rebuilt call does not match the submitted one',
          ),
          record: r,
        });
        continue;
      }
      try {
        const interpreted = interpret(call, result.message);
        const r = record(interpreted.status === 'draft' ? 'ok' : 'needs_review', null);
        await deps.sink.record(r);
        outcomes.push({ customId: result.customId, ok: true, result: interpreted, record: r });
      } catch (thrown: unknown) {
        const error = thrown instanceof AiError ? thrown : classifyError(thrown);
        const r = record(outcomeOf(error), error.code);
        await deps.sink.record(r);
        outcomes.push({ customId: result.customId, ok: false, error, record: r });
      }
    }
  } catch (thrown: unknown) {
    throw classifyError(thrown);
  }
  // A result the API never returned is treated like an expired request.
  for (const item of ticket.items) {
    if (!done.has(item.customId)) {
      await deps.ledger.release(item.reservationId);
      outcomes.push({
        customId: item.customId,
        ok: false,
        error: new AiError('ai_server_error', 'the batch returned no result for this request'),
        record: null,
      });
    }
  }
  return outcomes;
}

/**
 * Deletes the batch once its results are persisted, so its inputs and outputs do not stay
 * stored for 29 days (ADR-216). Safe to call twice.
 */
export async function retireBatch(deps: AiDeps, batchId: string): Promise<void> {
  try {
    await deps.transport.deleteBatch(batchId, TIMEOUT);
  } catch (thrown: unknown) {
    const error = classifyError(thrown);
    if (error.status === 404) {
      return;
    }
    throw error;
  }
}
