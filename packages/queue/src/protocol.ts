/**
 * The five operations of PLAN §10, the twin of crates/queue (ADR-003, ADR-018). The SQL is
 * the same, so a job enqueued by either language can be claimed, fenced and retried by the
 * other.
 */
import type { JobError } from '@rampsmith/contracts-ts';
import type postgres from 'postgres';
import { retryDelayMs } from './backoff.ts';
import { uuidv7 } from './uuid.ts';

/** The `LISTEN`/`NOTIFY` channel; the payload is the queue name. */
export const CHANNEL = 'jobs';

/** A connection pool or a transaction: anything that runs a query. */
export type Executor = postgres.ISql;

export interface NewJob {
  /** The queue, such as `scan.page`. */
  readonly queue: string;
  /** The payload's schema and version, such as `scan.page@1`. */
  readonly payloadSchema: string;
  readonly payload: postgres.JSONValue;
  /** The tenant the job acts for; absent for system jobs. */
  readonly tenantId?: string;
  /** Higher runs first. Default 0. */
  readonly priority?: number;
  /** Earliest start. Default now. */
  readonly runAt?: Date;
  /** Attempts before the job is dead. Default 8. */
  readonly maxAttempts?: number;
  readonly idempotencyKey?: string;
  readonly parentId?: string;
  /** W3C trace context of the enqueuer. */
  readonly traceparent?: string;
}

export type Enqueued =
  { readonly created: true; readonly id: string } | { readonly created: false };

/** A worker's hold on one attempt; the attempt number fences outdated holders. */
export interface Lease {
  readonly jobId: string;
  readonly worker: string;
  readonly attempt: number;
}

export interface ClaimedJob {
  readonly lease: Lease;
  readonly queue: string;
  readonly payloadSchema: string;
  readonly payload: unknown;
  readonly tenantId: string | null;
  readonly maxAttempts: number;
  readonly lockedUntil: Date;
  readonly traceparent: string | null;
}

export type Failure =
  | { readonly kind: 'retryable'; readonly error: JobError }
  | { readonly kind: 'permanent'; readonly error: JobError };

export type FailOutcome =
  { readonly state: 'retrying'; readonly runAt: Date } | { readonly state: 'dead' };

/** The lease is no longer held; another attempt owns the job. Stop without side effects. */
export class LeaseLostError extends Error {
  constructor(lease: Lease) {
    super(`lease on job ${lease.jobId} attempt ${String(lease.attempt)} is no longer held`);
    this.name = 'LeaseLostError';
  }
}

/** Enqueues inside the caller's transaction; listeners are notified when it commits. */
export async function enqueue(sql: Executor, job: NewJob): Promise<Enqueued> {
  const rows = await sql<{ id: string }[]>`
    with inserted as (
      insert into jobs (id, queue, payload_schema, payload, tenant_id, priority, state,
                        max_attempts, run_at, idempotency_key, parent_id, traceparent)
      values (${uuidv7()}, ${job.queue}, ${job.payloadSchema}, ${sql.json(job.payload)},
              ${job.tenantId ?? null}, ${job.priority ?? 0}, 'ready', ${job.maxAttempts ?? 8},
              coalesce(${job.runAt ?? null}::timestamptz, now()), ${job.idempotencyKey ?? null},
              ${job.parentId ?? null}, ${job.traceparent ?? null})
      on conflict (idempotency_key) do nothing
      returning id, queue
    )
    select id from inserted, lateral (select pg_notify('jobs', inserted.queue)) as n`;
  const [row] = rows;
  return row === undefined ? { created: false } : { created: true, id: row.id };
}

interface ClaimRow {
  id: string;
  queue: string;
  payload_schema: string;
  payload: unknown;
  tenant_id: string | null;
  attempts: number;
  max_attempts: number;
  locked_until: Date;
  traceparent: string | null;
  priority: number;
  run_at: Date;
}

/** Claims up to `limit` ready jobs of `queue` in one round trip (`FOR UPDATE SKIP LOCKED`). */
export async function claim(
  sql: Executor,
  queue: string,
  limit: number,
  worker: string,
  leaseMs: number,
): Promise<ClaimedJob[]> {
  const rows = await sql<ClaimRow[]>`
    with next as (
      select id from jobs
       where queue = ${queue} and state = 'ready' and run_at <= now()
       order by priority desc, run_at
       for update skip locked
       limit ${limit}
    )
    update jobs j
       set state = 'running', attempts = j.attempts + 1,
           locked_by = ${worker}, locked_until = now() + make_interval(secs => ${leaseMs / 1000})
      from next
     where j.id = next.id
    returning j.id, j.queue, j.payload_schema, j.payload, j.tenant_id, j.attempts,
              j.max_attempts, j.locked_until, j.traceparent, j.priority, j.run_at`;
  // UPDATE ... RETURNING does not preserve the subquery's order; restore it.
  const ordered = [...rows].sort(
    (x, y) => y.priority - x.priority || x.run_at.getTime() - y.run_at.getTime(),
  );
  return ordered.map((r) => ({
    lease: { jobId: r.id, worker, attempt: r.attempts },
    queue: r.queue,
    payloadSchema: r.payload_schema,
    payload: r.payload,
    tenantId: r.tenant_id,
    maxAttempts: r.max_attempts,
    lockedUntil: r.locked_until,
    traceparent: r.traceparent,
  }));
}

/** Extends the lease to `leaseMs` from now. `false` means the lease is lost. */
export async function heartbeat(sql: Executor, lease: Lease, leaseMs: number): Promise<boolean> {
  const result = await sql`
    update jobs set locked_until = now() + make_interval(secs => ${leaseMs / 1000})
     where id = ${lease.jobId} and locked_by = ${lease.worker} and attempts = ${lease.attempt}
       and state = 'running'`;
  return result.count === 1;
}

/** Marks the attempt succeeded, or throws `LeaseLostError`. */
export async function complete(sql: Executor, lease: Lease): Promise<void> {
  const result = await sql`
    update jobs set state = 'succeeded', finished_at = now(), locked_by = null, locked_until = null
     where id = ${lease.jobId} and locked_by = ${lease.worker} and attempts = ${lease.attempt}
       and state = 'running'`;
  if (result.count !== 1) throw new LeaseLostError(lease);
}

/**
 * Records a failed attempt: a retryable failure with attempts left becomes ready after
 * `retryDelayMs`; anything else is dead. Throws `LeaseLostError` when the lease is lost.
 */
export async function fail(
  sql: Executor,
  lease: Lease,
  failure: Failure,
  jitter: number = Math.random(),
): Promise<FailOutcome> {
  const delaySeconds = retryDelayMs(lease.attempt, jitter) / 1000;
  const rows = await sql<{ state: string; run_at: Date }[]>`
    with decision as (
      select id, (${failure.kind === 'retryable'}::bool and attempts < max_attempts) as retry
        from jobs
       where id = ${lease.jobId} and locked_by = ${lease.worker} and attempts = ${lease.attempt}
         and state = 'running'
       for update
    )
    update jobs j set
      state = case when d.retry then 'ready' else 'dead' end,
      run_at = case when d.retry then now() + make_interval(secs => ${delaySeconds}) else j.run_at end,
      finished_at = case when d.retry then null else now() end,
      last_error = jsonb_set(${sql.json({ ...failure.error })}::jsonb, '{retryable}', to_jsonb(d.retry)),
      locked_by = null,
      locked_until = null
    from decision d
    where j.id = d.id
    returning j.state, j.run_at`;
  const [row] = rows;
  if (row === undefined) throw new LeaseLostError(lease);
  return row.state === 'ready' ? { state: 'retrying', runAt: row.run_at } : { state: 'dead' };
}

/**
 * Returns expired leases to `ready`, or `dead` when no attempts remain. In production only
 * the Rust `ctl` leader runs this (PLAN §10); it is here for tests and parity.
 */
export async function reapExpired(sql: Executor): Promise<number> {
  const result = await sql`
    update jobs set
      state = case when attempts < max_attempts then 'ready' else 'dead' end,
      run_at = now(),
      finished_at = case when attempts < max_attempts then null else now() end,
      locked_by = null,
      locked_until = null,
      last_error = jsonb_build_object(
        'code', 'lease_expired',
        'message', 'the worker lost its lease before finishing',
        'retryable', attempts < max_attempts)
    where state = 'running' and locked_until < now()`;
  return result.count;
}
