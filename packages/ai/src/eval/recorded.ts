/**
 * Recorded responses for the evaluation harness. `RecordedTransport` answers each request
 * from a file keyed by the SHA-256 of the request (everything but `metadata`), so a changed
 * prompt, schema, image or model finds no recording and fails loudly instead of replaying a
 * stale answer. `RecordingTransport` wraps the live transport and writes those files.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type {
  Message,
  MessageCreateParamsNonStreaming,
} from '@anthropic-ai/sdk/resources/messages/messages';
import { AiError } from '../errors.ts';
import { loadPrompts } from '../prompts.ts';
import type {
  AiTransport,
  BatchItemResult,
  BatchStatus,
  CallOptions,
  TransportResponse,
} from '../transport.ts';

export const BUNDLED_RECORDINGS = new URL('../../eval/recorded/', import.meta.url);

export interface Recording {
  readonly provenance: string;
  readonly prompt_version: string;
  readonly model: string;
  readonly image_id: string;
  readonly request_sha256: string;
  readonly response: Message;
}

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

/** The key of a request: everything that shapes the answer, nothing tenant-specific. */
export function requestKey(params: MessageCreateParamsNonStreaming): string {
  const rest: Partial<MessageCreateParamsNonStreaming> = { ...params };
  delete rest.metadata;
  return createHash('sha256')
    .update(JSON.stringify(canonical(rest)), 'utf8')
    .digest('hex');
}

/** The prompt version a request was built from, found by its system prompt. */
export function promptVersionOf(params: MessageCreateParamsNonStreaming): string {
  const system = Array.isArray(params.system)
    ? params.system.map((b) => b.text).join('')
    : (params.system ?? '');
  for (const p of loadPrompts().values()) {
    if (p.text === system) {
      return p.version;
    }
  }
  return 'unknown';
}

function files(dir: string): string[] {
  let out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    out = statSync(path).isDirectory() ? [...out, ...files(path)] : [...out, path];
  }
  return out.filter((f) => f.endsWith('.json'));
}

const unsupported = (): Promise<never> =>
  Promise.reject(new AiError('ai_invalid_request', 'recordings cover synchronous calls only'));

export class RecordedTransport implements AiTransport {
  readonly #byKey = new Map<string, Recording>();

  constructor(dir: URL = BUNDLED_RECORDINGS) {
    for (const file of files(fileURLToPath(dir))) {
      const recording = JSON.parse(readFileSync(file, 'utf8')) as Recording;
      this.#byKey.set(recording.request_sha256, recording);
    }
  }

  get size(): number {
    return this.#byKey.size;
  }

  createMessage(params: MessageCreateParamsNonStreaming): Promise<TransportResponse> {
    const found = this.#byKey.get(requestKey(params));
    if (found === undefined) {
      return Promise.reject(
        new AiError(
          'ai_invalid_request',
          `no recording for this ${promptVersionOf(params)} request on ${params.model}; run the harness live with --record (LAUNCH.md section C, row 5)`,
        ),
      );
    }
    return Promise.resolve({ message: found.response, requestId: undefined });
  }

  createBatch = unsupported;
  retrieveBatch = (): Promise<BatchStatus> => unsupported();
  batchResults(): AsyncIterable<BatchItemResult> {
    return { [Symbol.asyncIterator]: () => ({ next: unsupported }) };
  }
  deleteBatch = (): Promise<void> => unsupported();
}

/** Wraps the live transport and writes each answer as a recording. */
export class RecordingTransport implements AiTransport {
  readonly #inner: AiTransport;
  readonly #dir: string;
  /** Set by the runner before each image. */
  imageId = 'unknown';

  constructor(inner: AiTransport, dir: URL = BUNDLED_RECORDINGS) {
    this.#inner = inner;
    this.#dir = fileURLToPath(dir);
  }

  async createMessage(
    params: MessageCreateParamsNonStreaming,
    options: CallOptions,
  ): Promise<TransportResponse> {
    const response = await this.#inner.createMessage(params, options);
    const version = promptVersionOf(params);
    const recording: Recording = {
      provenance: `recorded from the Claude API on ${new Date().toISOString().slice(0, 10)}`,
      prompt_version: version,
      model: params.model,
      image_id: this.imageId,
      request_sha256: requestKey(params),
      response: response.message,
    };
    const dir = join(this.#dir, version);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${this.imageId}.${params.model}.json`),
      `${JSON.stringify(recording, null, 2)}\n`,
    );
    return response;
  }

  createBatch: AiTransport['createBatch'] = (r, o) => this.#inner.createBatch(r, o);
  retrieveBatch: AiTransport['retrieveBatch'] = (id, o) => this.#inner.retrieveBatch(id, o);
  batchResults: AiTransport['batchResults'] = (id, o) => this.#inner.batchResults(id, o);
  deleteBatch: AiTransport['deleteBatch'] = (id, o) => this.#inner.deleteBatch(id, o);
}
