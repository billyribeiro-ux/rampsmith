/**
 * Fakes shared by the tests: Messages API responses in the documented shape, a scripted
 * transport, and dependencies wired to the in-memory ledger.
 */
import type {
  Message,
  MessageCreateParamsNonStreaming,
  StopReason,
  Usage,
} from '@anthropic-ai/sdk/resources/messages/messages';
import { InMemoryBudgetLedger } from '../src/budget.ts';
import type { AiCallRecord, AiDeps } from '../src/calls.ts';
import { CircuitBreaker } from '../src/resilience.ts';
import type {
  AiTransport,
  BatchItemResult,
  BatchRequest,
  BatchStatus,
  CallOptions,
  TransportResponse,
} from '../src/transport.ts';

export const TENANT = '0190e8d2-0000-7000-8000-00000000000a';

/** A real 28 × 28 JPEG (one visual token) and PNG. */
export const TINY_JPEG =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAcABwDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDlaKKK9o4gooooAKKKKACiiigD/9k=';
export const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAABwAAAAcCAIAAAD9b0jDAAAAJ0lEQVR4nGOUs+lhoDZgorqJo4aOGjpq6Kiho4aOGjpq6Kihg9JQAGYxAR7+jmV9AAAAAElFTkSuQmCC';

function usage(partial: Partial<Usage> = {}): Usage {
  return {
    cache_creation: null,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    inference_geo: 'global',
    input_tokens: 500,
    output_tokens: 60,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: 'standard',
    speed: 'standard',
    ...partial,
  };
}

/** A Messages API response whose text block is `output` (JSON-encoded unless a string). */
export function message(
  output: unknown,
  options: {
    readonly stopReason?: StopReason;
    readonly usage?: Partial<Usage>;
    readonly model?: string;
    readonly withThinking?: boolean;
  } = {},
): Message {
  const text = typeof output === 'string' ? output : JSON.stringify(output);
  return {
    id: 'msg_01FakeFakeFakeFakeFakeFake',
    container: null,
    content: [
      ...(options.withThinking === true
        ? [{ type: 'thinking' as const, thinking: 'Looking at the image.', signature: 'sig' }]
        : []),
      { type: 'text', text, citations: null },
    ],
    diagnostics: null,
    model: options.model ?? 'claude-haiku-5-5',
    role: 'assistant',
    stop_details: null,
    stop_reason: options.stopReason ?? 'end_turn',
    stop_sequence: null,
    type: 'message',
    usage: usage(options.usage),
  };
}

type Scripted = Message | Error | ((params: MessageCreateParamsNonStreaming) => Message | Error);

/** A transport that answers from a script and remembers every request. */
export class FakeTransport implements AiTransport {
  readonly requests: MessageCreateParamsNonStreaming[] = [];
  readonly options: CallOptions[] = [];
  readonly batches = new Map<string, { requests: readonly BatchRequest[]; deleted: boolean }>();
  batchStatus: BatchStatus['processingStatus'] = 'ended';
  batchResultsScript: BatchItemResult[] = [];
  batchErrors: Error[] = [];
  #script: Scripted[];

  constructor(script: Scripted[] = []) {
    this.#script = [...script];
  }

  push(...items: Scripted[]): void {
    this.#script.push(...items);
  }

  createMessage(
    params: MessageCreateParamsNonStreaming,
    options: CallOptions,
  ): Promise<TransportResponse> {
    this.requests.push(params);
    this.options.push(options);
    const next = this.#script.shift();
    if (next === undefined) {
      return Promise.reject(new Error('FakeTransport: script exhausted'));
    }
    const value = typeof next === 'function' ? next(params) : next;
    return value instanceof Error
      ? Promise.reject(value)
      : Promise.resolve({ message: value, requestId: 'req_fake' });
  }

  createBatch(requests: readonly BatchRequest[]): Promise<{ readonly id: string }> {
    const error = this.batchErrors.shift();
    if (error !== undefined) {
      return Promise.reject(error);
    }
    const id = `msgbatch_${String(this.batches.size + 1)}`;
    this.batches.set(id, { requests, deleted: false });
    return Promise.resolve({ id });
  }

  retrieveBatch(id: string): Promise<BatchStatus> {
    const count = this.batches.get(id)?.requests.length ?? 0;
    return Promise.resolve({
      id,
      processingStatus: this.batchStatus,
      counts: {
        processing: this.batchStatus === 'ended' ? 0 : count,
        succeeded: this.batchStatus === 'ended' ? count : 0,
        errored: 0,
        canceled: 0,
        expired: 0,
      },
    });
  }

  batchResults(): AsyncIterable<BatchItemResult> {
    const items = [...this.batchResultsScript];
    return {
      async *[Symbol.asyncIterator]() {
        await Promise.resolve();
        yield* items;
      },
    };
  }

  deleteBatch(id: string): Promise<void> {
    const batch = this.batches.get(id);
    if (batch !== undefined) {
      batch.deleted = true;
    }
    return Promise.resolve();
  }
}

export interface TestDeps extends AiDeps {
  readonly transport: FakeTransport;
  readonly ledger: InMemoryBudgetLedger;
  readonly records: AiCallRecord[];
  readonly sleeps: number[];
}

export function testDeps(
  transport: FakeTransport,
  overrides: { readonly limitMicroUsd?: number; readonly now?: () => number } = {},
): TestDeps {
  const records: AiCallRecord[] = [];
  const sleeps: number[] = [];
  const now = overrides.now ?? (() => Date.UTC(2026, 9, 17, 12, 0, 0));
  return {
    transport,
    ledger: new InMemoryBudgetLedger(),
    breaker: new CircuitBreaker({ failureThreshold: 5 }, now),
    sink: {
      record: (r) => {
        records.push(r);
        return Promise.resolve();
      },
    },
    budgetLimit: () => Promise.resolve(overrides.limitMicroUsd ?? 1_000_000),
    now,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => 0.5,
    records,
    sleeps,
  };
}
