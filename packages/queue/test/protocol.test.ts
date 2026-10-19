import type { JobError } from '@rampsmith/contracts-ts';
import type postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CHANNEL,
  LeaseLostError,
  claim,
  complete,
  enqueue,
  fail,
  heartbeat,
  reapExpired,
  type NewJob,
} from '../src/index.ts';
import { freshDatabase, type TestDatabase } from './db.ts';

const LEASE_MS = 30_000;
let db: TestDatabase;
let workers: postgres.Sql;

const job = (key: string, extra: Partial<NewJob> = {}): NewJob => ({
  queue: 'test.effect',
  payloadSchema: 'test.effect@1',
  payload: { key },
  ...extra,
});

const error = (code: string): JobError => ({ code, message: 'boom', retryable: true });

beforeAll(async () => {
  db = await freshDatabase();
  workers = db.as('rampsmith_worker');
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.owner`delete from jobs`;
});

async function expireLeases(): Promise<void> {
  await db.owner`update jobs set locked_until = now() - interval '1 second' where state = 'running'`;
}

describe('the TypeScript queue protocol', () => {
  it('claims a job with a lease and its payload, once', async () => {
    const enqueued = await enqueue(workers, job('a'));
    expect(enqueued.created).toBe(true);
    const claimed = await claim(workers, 'test.effect', 10, 'w1', LEASE_MS);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.lease).toMatchObject({ worker: 'w1', attempt: 1 });
    expect(claimed[0]?.payload).toEqual({ key: 'a' });
    expect(await claim(workers, 'test.effect', 10, 'w2', LEASE_MS)).toEqual([]);
  });

  it('enqueues once per idempotency key', async () => {
    expect((await enqueue(workers, job('a', { idempotencyKey: 'fix-1' }))).created).toBe(true);
    expect((await enqueue(workers, job('b', { idempotencyKey: 'fix-1' }))).created).toBe(false);
  });

  it('never hands the same job to two concurrent workers', async () => {
    for (let i = 0; i < 60; i += 1) await enqueue(workers, job(`k${String(i)}`));
    const drain = async (w: string): Promise<string[]> => {
      const mine: string[] = [];
      for (;;) {
        const batch = await claim(workers, 'test.effect', 3, w, LEASE_MS);
        if (batch.length === 0) return mine;
        mine.push(...batch.map((j) => j.lease.jobId));
      }
    };
    const all = (await Promise.all(['a', 'b', 'c', 'd', 'e', 'f'].map(drain))).flat();
    expect(all).toHaveLength(60);
    expect(new Set(all).size).toBe(60);
  });

  it('orders by priority, then run_at, and skips future jobs', async () => {
    await enqueue(workers, job('future', { runAt: new Date(Date.now() + 3_600_000) }));
    await enqueue(workers, job('normal'));
    await enqueue(workers, job('urgent', { priority: 10 }));
    const claimed = await claim(workers, 'test.effect', 10, 'w', LEASE_MS);
    expect(claimed.map((j) => (j.payload as { key: string }).key)).toEqual(['urgent', 'normal']);
  });

  it('fences a worker that lost its lease', async () => {
    await enqueue(workers, job('a'));
    const [first] = await claim(workers, 'test.effect', 1, 'w1', LEASE_MS);
    if (first === undefined) throw new Error('nothing claimed');
    await expireLeases();
    expect(await reapExpired(workers)).toBe(1);
    const [second] = await claim(workers, 'test.effect', 1, 'w2', LEASE_MS);
    if (second === undefined) throw new Error('nothing reclaimed');
    expect(second.lease.attempt).toBe(2);

    expect(await heartbeat(workers, first.lease, LEASE_MS)).toBe(false);
    await expect(complete(workers, first.lease)).rejects.toBeInstanceOf(LeaseLostError);
    await expect(
      fail(workers, first.lease, { kind: 'permanent', error: error('late') }),
    ).rejects.toBeInstanceOf(LeaseLostError);
    await complete(workers, second.lease);
    const [row] = await db.owner<
      { state: string; attempts: number }[]
    >`select state, attempts from jobs`;
    expect(row).toEqual({ state: 'succeeded', attempts: 2 });
  });

  it('backs off a retryable failure and buries an exhausted job', async () => {
    await enqueue(workers, job('a', { maxAttempts: 2 }));
    const [j1] = await claim(workers, 'test.effect', 1, 'w', LEASE_MS);
    if (j1 === undefined) throw new Error('nothing claimed');
    const outcome = await fail(
      workers,
      j1.lease,
      { kind: 'retryable', error: error('shopify_throttled') },
      0.5,
    );
    if (outcome.state !== 'retrying') throw new Error(`expected a retry, got ${outcome.state}`);
    const wait = outcome.runAt.getTime() - Date.now();
    expect(wait).toBeGreaterThan(3000);
    expect(wait).toBeLessThan(4000);

    await db.owner`update jobs set run_at = now()`;
    const [j2] = await claim(workers, 'test.effect', 1, 'w', LEASE_MS);
    if (j2 === undefined) throw new Error('nothing reclaimed');
    expect(
      await fail(workers, j2.lease, { kind: 'retryable', error: error('shopify_throttled') }, 0.5),
    ).toEqual({
      state: 'dead',
    });
    const [row] = await db.owner<
      { state: string; last_error: unknown }[]
    >`select state, last_error from jobs`;
    expect(row).toEqual({
      state: 'dead',
      last_error: { code: 'shopify_throttled', message: 'boom', retryable: false },
    });
  });

  it('notifies listeners on commit, not before', async () => {
    const heard: string[] = [];
    const listening = await workers.listen(CHANNEL, (payload) => heard.push(payload));
    await workers.begin(async (tx) => {
      await enqueue(tx, job('a'));
      await new Promise((r) => setTimeout(r, 200));
      expect(heard).toEqual([]);
    });
    for (let i = 0; i < 50 && heard.length === 0; i += 1)
      await new Promise((r) => setTimeout(r, 50));
    expect(heard).toEqual(['test.effect']);
    await listening.unlisten();
  });

  it('keeps the application role to its own tenant and away from claims', async () => {
    const app = db.as('rampsmith_app');
    const [a, b] = ['0190f5a0-0000-7000-8000-00000000000a', '0190f5a0-0000-7000-8000-00000000000b'];
    await db.owner`insert into tenants (id, kind) values (${a}, 'organization'), (${b}, 'organization')`;
    await app.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${a}, true)`;
      expect((await enqueue(tx, job('mine', { tenantId: a }))).created).toBe(true);
    });
    await expect(
      app.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${a}, true)`;
        await enqueue(tx, job('theirs', { tenantId: b }));
      }),
    ).rejects.toThrow(/row-level security/);
    await expect(
      app.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${a}, true)`;
        await claim(tx, 'test.effect', 1, 'app', LEASE_MS);
      }),
    ).rejects.toThrow(/permission denied/);
  });
});
