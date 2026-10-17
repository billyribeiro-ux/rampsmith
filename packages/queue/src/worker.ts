/**
 * The worker loop of PLAN §10, the twin of crates/queue's `run`: claim, run with
 * heartbeats every third of the lease, then complete or fail.
 */
import type { JobError } from '@rampsmith/contracts-ts';
import type postgres from 'postgres';
import {
  CHANNEL,
  LeaseLostError,
  claim,
  complete,
  fail,
  heartbeat,
  type ClaimedJob,
  type Failure,
} from './protocol.ts';

/** Throw from a handler to choose how the attempt fails. */
export class JobFailure extends Error {
  readonly failure: Failure;

  constructor(kind: Failure['kind'], error: Omit<JobError, 'retryable'>) {
    super(error.message);
    this.name = 'JobFailure';
    this.failure = { kind, error: { ...error, retryable: kind === 'retryable' } };
  }
}

export interface WorkerEvent {
  readonly type:
    'claim_failed' | 'lease_lost' | 'completed' | 'retrying' | 'dead' | 'record_failed';
  readonly jobId?: string;
  readonly error?: unknown;
}

export interface WorkerOptions {
  /** A pool, not a transaction: the worker also LISTENs on it. */
  readonly sql: postgres.Sql;
  readonly queue: string;
  /** Unique per process; stored in `locked_by`. */
  readonly workerId: string;
  /** Lease length. Default 30 seconds. */
  readonly leaseMs?: number;
  /** Poll interval besides LISTEN. Default 5 seconds. */
  readonly pollMs?: number;
  /** Jobs run at once. Default 1. */
  readonly concurrency?: number;
  /** Aborting stops claiming; the promise resolves once attempts in flight finish. */
  readonly signal: AbortSignal;
  /**
   * Runs one attempt. Side effects must be idempotent: a job can run again after a crash
   * between its effect and its completion. The signal aborts when the lease is lost.
   * Throw `JobFailure` to choose retryable or permanent; anything else is retryable.
   */
  readonly handler: (job: ClaimedJob, signal: AbortSignal) => Promise<void>;
  /** Observability hook; telemetry attaches here (PLAN §21). */
  readonly onEvent?: (event: WorkerEvent) => void;
}

const MAX_MESSAGE = 300;

function toFailure(error: unknown): Failure {
  if (error instanceof JobFailure) return error.failure;
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : 'a non-error value was thrown';
  return {
    kind: 'retryable',
    error: { code: 'unhandled_error', message: message.slice(0, MAX_MESSAGE), retryable: true },
  };
}

async function attempt(options: WorkerOptions, job: ClaimedJob, leaseMs: number): Promise<void> {
  const emit = options.onEvent ?? (() => undefined);
  const lost = new AbortController();
  const beat = setInterval(() => {
    heartbeat(options.sql, job.lease, leaseMs)
      .then((held) => {
        if (!held) lost.abort(new LeaseLostError(job.lease));
      })
      .catch((error: unknown) => {
        emit({ type: 'record_failed', jobId: job.lease.jobId, error });
      });
  }, leaseMs / 3);
  const lostPromise = new Promise<'lost'>((resolve) => {
    lost.signal.addEventListener('abort', () => {
      resolve('lost');
    });
  });
  try {
    const outcome = await Promise.race([
      options.handler(job, lost.signal).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
      lostPromise,
    ]);
    if (outcome === 'lost' || lost.signal.aborted) {
      emit({ type: 'lease_lost', jobId: job.lease.jobId });
      return;
    }
    if (outcome.ok) {
      await complete(options.sql, job.lease);
      emit({ type: 'completed', jobId: job.lease.jobId });
    } else {
      const result = await fail(options.sql, job.lease, toFailure(outcome.error));
      emit({ type: result.state, jobId: job.lease.jobId });
    }
  } catch (error: unknown) {
    emit({
      type: error instanceof LeaseLostError ? 'lease_lost' : 'record_failed',
      jobId: job.lease.jobId,
      error,
    });
  } finally {
    clearInterval(beat);
  }
}

/** Runs until `options.signal` aborts, then waits for attempts in flight. */
export async function runWorker(options: WorkerOptions): Promise<void> {
  const leaseMs = options.leaseMs ?? 30_000;
  const pollMs = options.pollMs ?? 5_000;
  const concurrency = Math.max(1, options.concurrency ?? 1);
  const emit = options.onEvent ?? (() => undefined);
  const inFlight = new Set<Promise<void>>();
  let wake: (() => void) | undefined;
  const nudge = (): void => {
    wake?.();
  };

  const listening = await options.sql.listen(CHANNEL, (payload) => {
    if (payload === options.queue) nudge();
  });
  options.signal.addEventListener('abort', nudge);
  try {
    while (!options.signal.aborted) {
      const free = concurrency - inFlight.size;
      if (free > 0) {
        try {
          const jobs = await claim(options.sql, options.queue, free, options.workerId, leaseMs);
          for (const job of jobs) {
            const running = attempt(options, job, leaseMs).finally(() => {
              inFlight.delete(running);
              nudge();
            });
            inFlight.add(running);
          }
          if (jobs.length > 0) continue;
        } catch (error: unknown) {
          emit({ type: 'claim_failed', error });
        }
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, pollMs);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = undefined;
    }
  } finally {
    options.signal.removeEventListener('abort', nudge);
    await Promise.allSettled(inFlight);
    await listening.unlisten();
  }
}
