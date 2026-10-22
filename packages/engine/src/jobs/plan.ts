/**
 * `scan.plan@1` (ADR-035, ADR-036, ADR-070): chooses the pages of the render scan from the store
 * data `ctl` stored in `scan_inputs`, writes the plan on the scan, and enqueues one
 * `scan.page@2` job per planned page. Planning is idempotent: a plan already on the scan is
 * enqueued again as it stands (the jobs' idempotency keys make that a no-op), never re-planned.
 */
import { JobFailure, enqueue } from '@rampsmith/queue';
import type postgres from 'postgres';
import { readInputs } from '../pipeline/inputs.ts';
import { planPages, type PlannedPage } from '../pipeline/planner.ts';
import { AUDITED_KINDS } from '../pipeline/snapshot.ts';
import { withTenant } from '../store.ts';
import { parsePayload, requireTenant, type JobHandler } from './payload.ts';

/** The `scans.plan` document. */
interface StoredPlan {
  readonly version: 1;
  readonly pages: readonly PlannedPage[];
}

/** Attempts a page job gets: a flaky load is retried, a dead store is not hammered. */
const PAGE_ATTEMPTS = 4;

function permanent(code: string, message: string): JobFailure {
  return new JobFailure('permanent', { code, message });
}

function isStoredPlan(value: unknown): value is StoredPlan {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { version?: unknown }).version === 1 &&
    Array.isArray((value as { pages?: unknown }).pages)
  );
}

export interface PlanDeps {
  readonly sql: postgres.Sql;
}

export function scanPlanHandler(deps: PlanDeps): JobHandler {
  return async (job) => {
    const payload = parsePayload(job, 'scan.plan@1');
    const tenantId = requireTenant(job);
    await withTenant(deps.sql, tenantId, async (tx) => {
      const [site] = await tx<{ base_url: string; verified: boolean; primary_locale: string }[]>`
        select base_url, verified_at is not null as verified, primary_locale
          from sites where tenant_id = ${tenantId} and id = ${payload.site_id}`;
      if (site === undefined) throw permanent('site_not_found', 'no such site for this tenant');
      // PLAN §11: scans run only on verified sites.
      if (!site.verified) throw permanent('site_not_verified', 'the site is not verified');
      const [scan] = await tx<{ plan: unknown; status: string }[]>`
        select plan, status from scans
         where tenant_id = ${tenantId} and id = ${payload.scan_id} and site_id = ${payload.site_id}
         for update`;
      if (scan === undefined) throw permanent('scan_not_found', 'no such scan for this tenant');
      if (!['queued', 'running'].includes(scan.status)) {
        throw permanent('scan_closed', `the scan is ${scan.status}`);
      }

      const inputs = await readInputs(tx, tenantId, payload.scan_id, site.primary_locale);
      let plan: StoredPlan;
      if (isStoredPlan(scan.plan)) {
        plan = scan.plan;
      } else {
        plan = {
          version: 1,
          pages: planPages({
            origin: new URL(site.base_url).origin,
            batch: inputs.batch,
            sampling: inputs.shop.sampling,
          }),
        };
        const audited = inputs.rows.filter((r) =>
          (AUDITED_KINDS as readonly string[]).includes(r.kind),
        ).length;
        await tx`
          update scans
             set plan = ${tx.json(plan as unknown as postgres.JSONValue)},
                 pages_planned = ${plan.pages.length},
                 data_inputs_planned = greatest(data_inputs_planned, ${audited})
           where tenant_id = ${tenantId} and id = ${payload.scan_id}`;
      }
      for (const page of plan.pages) {
        await enqueue(tx, {
          queue: 'scan.page',
          payloadSchema: 'scan.page@2',
          payload: {
            scan_id: payload.scan_id,
            site_id: payload.site_id,
            seq: page.seq,
            page_type: page.pageType,
            url: page.url,
            viewport: page.viewport,
            states: [...page.states],
          },
          tenantId,
          maxAttempts: PAGE_ATTEMPTS,
          idempotencyKey: `scan.page:${payload.scan_id}:${String(page.seq)}`,
        });
      }
    });
  };
}
