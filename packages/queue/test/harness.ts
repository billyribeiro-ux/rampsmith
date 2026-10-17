/**
 * Test fixture for kill.test.ts; never deployed. Runs one worker on `test.effect` as
 * `rampsmith_worker`. Each job writes an idempotent effect keyed by `payload.key`; on its
 * first attempt a job can hang before or after the effect, so the test can SIGKILL this
 * process at either point.
 *
 * Usage: node test/harness.ts <database-url> <database-name> <worker-id> <lease-ms>
 */
import process from 'node:process';
import postgres from 'postgres';
import { runWorker } from '../src/index.ts';

const [url, database, workerId, leaseMs] = process.argv.slice(2);
if (
  url === undefined ||
  database === undefined ||
  workerId === undefined ||
  leaseMs === undefined
) {
  throw new Error('usage: harness.ts <database-url> <database-name> <worker-id> <lease-ms>');
}
const sql = postgres(url, {
  database,
  max: 8,
  onnotice: () => undefined,
  connection: { role: 'rampsmith_worker' },
});
const hang = (): Promise<never> => new Promise(() => undefined);

await runWorker({
  sql,
  queue: 'test.effect',
  workerId,
  leaseMs: Number(leaseMs),
  pollMs: 200,
  concurrency: 16,
  signal: new AbortController().signal,
  async handler(job) {
    const { key, mode } = job.payload as { key: string; mode?: string };
    const first = job.lease.attempt === 1;
    if (first && mode === 'hang_before_effect') await hang();
    await sql`insert into queue_test_effects (key, attempt) values (${key}, ${job.lease.attempt})
              on conflict (key) do nothing`;
    if (first && mode === 'hang_after_effect') await hang();
  },
});
