/**
 * R0 exit criterion (PLAN §5) for the TypeScript engine's queue: a worker killed with
 * SIGKILL mid-job loses nothing and duplicates nothing. Mirrors crates/queue/tests/kill.rs.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { enqueue, reapExpired } from '../src/index.ts';
import { freshDatabase, type TestDatabase } from './db.ts';

const LEASE_MS = 1500;
const HARNESS = fileURLToPath(new URL('./harness.ts', import.meta.url));
let db: TestDatabase;
let workers: postgres.Sql;
const children: ChildProcess[] = [];

beforeAll(async () => {
  db = await freshDatabase();
  workers = db.as('rampsmith_worker');
  await db.owner`create table queue_test_effects (key text primary key, attempt int not null)`;
  await db.owner`grant select, insert on queue_test_effects to rampsmith_worker`;
});

afterAll(async () => {
  for (const child of children) child.kill('SIGKILL');
  await db.drop();
});

function startWorker(id: string): ChildProcess {
  const child = spawn(process.execPath, [HARNESS, db.url, db.name, id, String(LEASE_MS)], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  children.push(child);
  return child;
}

async function kill(child: ChildProcess): Promise<void> {
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;
}

async function waitFor(what: string, check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function flag(query: Promise<{ done: boolean }[]>): Promise<boolean> {
  const [row] = await query;
  return row?.done === true;
}

it('survives a worker killed mid-job with no lost or duplicated job', async () => {
  const modes = ['ok', 'hang_before_effect', 'hang_after_effect'] as const;
  for (let i = 0; i < 15; i += 1) {
    const key = `k${String(i).padStart(2, '0')}`;
    await enqueue(workers, {
      queue: 'test.effect',
      payloadSchema: 'test.effect@1',
      payload: { key, mode: modes[i % 3] ?? 'ok' },
    });
  }

  const a = startWorker('worker-a');
  await waitFor('worker A to reach every hang point', () =>
    flag(db.owner<{ done: boolean }[]>`
      select (select count(*) from jobs where state = 'succeeded') = 5
         and (select count(*) from jobs where state = 'running' and attempts = 1) = 10
         and (select count(*) from queue_test_effects) = 10 as done`),
  );
  await kill(a);

  await waitFor("worker A's leases to expire", () =>
    flag(db.owner<{ done: boolean }[]>`
      select bool_and(locked_until < now()) as done from jobs where state = 'running'`),
  );
  expect(await reapExpired(workers)).toBe(10);

  const b = startWorker('worker-b');
  await waitFor('every job to succeed', () =>
    flag(
      db.owner<
        { done: boolean }[]
      >`select count(*) = 15 as done from jobs where state = 'succeeded'`,
    ),
  );
  await kill(b);

  const rows = await db.owner<
    { key: string; mode: string; attempts: number; effect_attempt: number }[]
  >`
    select j.payload->>'key' as key, j.payload->>'mode' as mode, j.attempts, e.attempt as effect_attempt
      from jobs j join queue_test_effects e on e.key = j.payload->>'key'
     order by 1`;
  expect(rows).toHaveLength(15);
  const expected = { ok: [1, 1], hang_before_effect: [2, 2], hang_after_effect: [2, 1] } as Record<
    string,
    [number, number]
  >;
  for (const row of rows) {
    expect([row.attempts, row.effect_attempt], `${row.key} (${row.mode})`).toEqual(
      expected[row.mode],
    );
  }
  const [stuck] = await db.owner<
    { n: number }[]
  >`select count(*)::int as n from jobs where state <> 'succeeded'`;
  expect(stuck?.n).toBe(0);
});
