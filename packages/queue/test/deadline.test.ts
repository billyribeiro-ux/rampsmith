/**
 * Audit M2: a job attempt has a deadline. A handler that never returns (a page that replaced
 * its timers, a stuck renderer) does not hold its lease forever: at the deadline the signal
 * aborts, the heartbeat stops and the attempt fails as retryable.
 */
import type postgres from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { enqueue, runWorker, type WorkerEvent } from '../src/index.ts';
import { freshDatabase, type TestDatabase } from './db.ts';

let db: TestDatabase;
let workers: postgres.Sql;

beforeAll(async () => {
  db = await freshDatabase();
  workers = db.as('rampsmith_worker');
});
afterAll(async () => {
  await db.drop();
});

it('fails an attempt that outlasts the deadline as retryable, aborts its signal and stops its heartbeat', async () => {
  const { id } = await enqueue(workers, {
    queue: 'test.effect',
    payloadSchema: 'test.effect@1',
    payload: {},
  });
  const stop = new AbortController();
  const events: WorkerEvent[] = [];
  let aborted = false;
  let attempts = 0;
  await runWorker({
    sql: workers,
    queue: 'test.effect',
    workerId: 'w-deadline',
    leaseMs: 600,
    pollMs: 100,
    deadlineMs: 400,
    signal: stop.signal,
    onEvent: (event) => {
      events.push(event);
      if (event.type === 'retrying') stop.abort();
    },
    handler: (_job, signal) => {
      attempts += 1;
      signal?.addEventListener('abort', () => {
        aborted = true;
      });
      // Never returns.
      return new Promise<void>(() => undefined);
    },
  });
  expect(attempts).toBe(1);
  expect(aborted).toBe(true);
  expect(events.map((e) => e.type)).toContain('retrying');
  const [row] = await db.owner<{ state: string; last_error: { code?: string } | null }[]>`
    select state, last_error from jobs where id = ${id}`;
  expect(row?.state).toBe('ready');
  expect(row?.last_error?.code).toBe('job_deadline_exceeded');
});

it('leaves an attempt that finishes in time alone', async () => {
  await enqueue(workers, { queue: 'test.fast', payloadSchema: 'test.effect@1', payload: {} });
  const stop = new AbortController();
  const events: string[] = [];
  await runWorker({
    sql: workers,
    queue: 'test.fast',
    workerId: 'w-fast',
    pollMs: 100,
    deadlineMs: 5_000,
    signal: stop.signal,
    onEvent: (event) => {
      events.push(event.type);
      if (event.type === 'completed') stop.abort();
    },
    handler: () => Promise.resolve(),
  });
  expect(events).toEqual(['completed']);
});
