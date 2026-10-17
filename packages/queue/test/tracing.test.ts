/**
 * One trace follows work across the queue (PLAN §10, §21), in TypeScript too: enqueue stores
 * the active trace context, and the worker's job span continues it.
 */
import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import type postgres from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { enqueue, runWorker } from '../src/index.ts';
import { freshDatabase, type TestDatabase } from './db.ts';

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
let db: TestDatabase;
let workers: postgres.Sql;

beforeAll(async () => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(provider);
  db = await freshDatabase();
  workers = db.as('rampsmith_worker');
});

afterAll(async () => {
  await db.drop();
  await provider.shutdown();
  trace.disable();
  propagation.disable();
  context.disable();
});

it('continues the enqueuer’s trace in the job span', async () => {
  const tracer = trace.getTracer('test');
  await tracer.startActiveSpan('webhook', async (span) => {
    await enqueue(workers, { queue: 'test.effect', payloadSchema: 'test.effect@1', payload: {} });
    span.end();
  });
  const [stored] = await db.owner<{ traceparent: string | null }[]>`select traceparent from jobs`;
  expect(stored?.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);

  const stop = new AbortController();
  await runWorker({
    sql: workers,
    queue: 'test.effect',
    workerId: 'w1',
    pollMs: 100,
    signal: stop.signal,
    handler: () => {
      trace.getTracer('test').startSpan('handler').end();
      stop.abort();
      return Promise.resolve();
    },
  });

  const spans = exporter.getFinishedSpans();
  const webhook = spans.find((s) => s.name === 'webhook');
  const job = spans.find((s) => s.name === 'job');
  const handler = spans.find((s) => s.name === 'handler');
  if (webhook === undefined || job === undefined || handler === undefined) {
    throw new Error(`missing spans: ${spans.map((s) => s.name).join(', ')}`);
  }
  expect(job.spanContext().traceId).toBe(webhook.spanContext().traceId);
  expect(job.parentSpanContext?.spanId).toBe(webhook.spanContext().spanId);
  expect(handler.parentSpanContext?.spanId).toBe(job.spanContext().spanId);
  expect(job.attributes).toMatchObject({ queue: 'test.effect', attempt: 1 });
});
