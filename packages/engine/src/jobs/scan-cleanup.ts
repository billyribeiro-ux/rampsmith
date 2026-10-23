/**
 * A scan that can no longer finish ends, and its sealed storefront-password copy goes with it
 * (audit M3, ADR-283). The copy is cleared when a scan finalises or a verification completes
 * (`finalize.ts`, `verify.ts`); this covers the jobs that die first: a permanent failure, or a
 * retryable one on the job's last attempt, leaves nothing that would ever end the scan.
 *
 * The backstop for a job that is killed before it can run this (a worker deadline on the last
 * attempt, a crash) is `scan_passwords_sweep()`, which `ctl`'s leader runs hourly.
 */
import { JobFailure } from '@rampsmith/queue';
import type postgres from 'postgres';
import { withTenant } from '../store.ts';
import { isLastAttempt, type JobHandler, type JobInput } from './payload.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Ends the scan as failed and clears its password copy. Only a scan not yet over changes. */
async function failScan(
  sql: postgres.Sql,
  tenantId: string,
  scanId: string,
  code: string,
): Promise<void> {
  await withTenant(sql, tenantId, async (tx) => {
    await tx`
      update scans
         set status = 'failed', finished_at = now(), error_code = ${code.slice(0, 100)},
             storefront_password_ct = null, storefront_password_key_id = null
       where tenant_id = ${tenantId} and id = ${scanId} and status in ('queued', 'running')`;
  });
}

function scanIdOf(job: JobInput): string | undefined {
  const payload = job.payload as { scan_id?: unknown } | null;
  const id = payload?.scan_id;
  return typeof id === 'string' && UUID.test(id) ? id : undefined;
}

/**
 * Wraps `handler`: when it fails for good, the job's scan ends. A failure is final when it is
 * permanent and, with `onLastAttempt`, also when the job has no attempt left.
 * `scan.page` passes `onLastAttempt: false`: its last attempt records the page as failed and
 * lets the scan finish with the other pages.
 */
export function endingScanOnFailure(
  sql: postgres.Sql,
  handler: JobHandler,
  { onLastAttempt }: { readonly onLastAttempt: boolean },
): JobHandler {
  return async (job, signal) => {
    try {
      await handler(job, signal);
    } catch (error) {
      const permanent = error instanceof JobFailure && error.failure.kind === 'permanent';
      const scanId = scanIdOf(job);
      if (
        scanId !== undefined &&
        job.tenantId !== null &&
        (permanent || (onLastAttempt && isLastAttempt(job)))
      ) {
        const code = error instanceof JobFailure ? error.failure.error.code : 'job_failed';
        // Ending the scan must not hide the failure that ended it.
        await failScan(sql, job.tenantId, scanId, code).catch(() => undefined);
      }
      throw error;
    }
  };
}
