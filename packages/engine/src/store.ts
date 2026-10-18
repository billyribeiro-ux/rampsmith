/**
 * Records a scanned page for its tenant (PLAN §9, §11 step 8): the page row, findings merged
 * by fingerprint, their occurrences, and the scan's progress, in one transaction scoped by
 * `app.tenant_id`, so row-level security applies to every statement (ADR-006).
 *
 * Idempotent: `scan_pages` is unique per scan, URL and state, so a job that runs again after
 * a crash records nothing twice.
 */
import { uuidv7 } from '@rampsmith/queue';
import type postgres from 'postgres';
import { fingerprint } from './fingerprint.ts';
import type { Impact, Occurrence, PageScan } from './scan-page.ts';

export interface PageContext {
  readonly tenantId: string;
  readonly siteId: string;
  readonly scanId: string;
}

export interface RecordOutcome {
  /** False when this page was already recorded for the scan. */
  readonly recorded: boolean;
  readonly findings: number;
  readonly occurrences: number;
}

const RANK: Record<Impact, number> = { minor: 1, moderate: 2, serious: 3, critical: 4 };

function worst(group: readonly Occurrence[]): Impact {
  return group.reduce<Impact>((acc, o) => (RANK[o.impact] > RANK[acc] ? o.impact : acc), 'minor');
}

/** Runs `fn` in a transaction scoped to `tenantId`. */
export function withTenant<T>(
  sql: postgres.Sql,
  tenantId: string,
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

export function recordPage(
  sql: postgres.Sql,
  ctx: PageContext,
  scan: PageScan,
  capturedAt: Date = new Date(),
): Promise<RecordOutcome> {
  return withTenant(sql, ctx.tenantId, async (tx) => {
    const page = await tx`
      insert into scan_pages
        (id, tenant_id, scan_id, url, page_state, http_status, duration_ms, blocked_reason, violations)
      values (${uuidv7()}, ${ctx.tenantId}, ${ctx.scanId}, ${scan.url}, 'default', ${scan.status},
              ${Math.round(scan.durationMs)}, ${scan.blocked ?? null}, ${scan.violations.length})
      on conflict (scan_id, url, page_state) do nothing
      returning id`;
    if (page.length === 0) return { recorded: false, findings: 0, occurrences: 0 };

    const groups = new Map<string, { print: Uint8Array; items: Occurrence[] }>();
    for (const o of scan.violations) {
      const print = fingerprint(o.ruleId, o.target, o.section ?? '');
      const key = Buffer.from(print).toString('hex');
      const group = groups.get(key) ?? { print, items: [] };
      group.items.push(o);
      groups.set(key, group);
    }

    let occurrences = 0;
    for (const { print, items } of groups.values()) {
      const [first] = items;
      if (first === undefined) continue;
      const [finding] = await tx<{ id: string }[]>`
        insert into findings (id, tenant_id, site_id, fingerprint, rule_id, criteria, impact,
                              status, first_seen_scan, last_seen_scan, occurrence_count)
        values (${uuidv7()}, ${ctx.tenantId}, ${ctx.siteId}, ${Buffer.from(print)}, ${first.ruleId},
                ${tx.array([...first.criteria])}, ${worst(items)}, 'open', ${ctx.scanId},
                ${ctx.scanId}, ${items.length})
        on conflict (site_id, fingerprint) do update
           set occurrence_count = case
                 when findings.last_seen_scan = excluded.last_seen_scan
                 then findings.occurrence_count + excluded.occurrence_count
                 else excluded.occurrence_count end,
               last_seen_scan = excluded.last_seen_scan,
               impact = excluded.impact,
               criteria = excluded.criteria,
               status = case when findings.status = 'fixed' then 'open' else findings.status end
         where findings.tenant_id = excluded.tenant_id
        returning id`;
      if (finding === undefined) continue;
      for (const o of items) {
        await tx`
          insert into finding_occurrences
            (finding_id, scan_id, tenant_id, page_url, page_state, target, html_excerpt, captured_at)
          values (${finding.id}, ${ctx.scanId}, ${ctx.tenantId}, ${scan.finalUrl}, 'default',
                  ${o.target}, ${o.html}, ${capturedAt})`;
        occurrences += 1;
      }
    }

    await tx`
      update scans
         set pages_done = pages_done + 1,
             started_at = coalesce(started_at, now()),
             status = case when pages_done + 1 >= pages_planned then 'succeeded' else 'running' end,
             finished_at = case when pages_done + 1 >= pages_planned then now() else finished_at end
       where tenant_id = ${ctx.tenantId} and id = ${ctx.scanId}
         and pages_done < pages_planned and status in ('queued', 'running')`;
    return { recorded: true, findings: groups.size, occurrences };
  });
}
