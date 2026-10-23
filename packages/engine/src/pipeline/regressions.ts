/**
 * Regression detection (ADR-310, ADR-311): after a scheduled scan is finalised, compare it with
 * the site's previous completed scan and store what got worse. It runs inside the transaction of
 * `scan.finalize`, so the record exists if and only if the scan's result does, and it keeps the
 * stable finding fingerprint as its identity: a finding is the row `findings` keeps per
 * `(site, fingerprint)`, and a scan "recorded" it when `finding_occurrences` holds a row of it.
 *
 * - new: open now, never seen before this scan (`first_seen_scan` is this scan);
 * - reappeared: open now, seen in an earlier scan, absent from the previous one (it was fixed,
 *   or a Rampsmith fix was verified, and the failure came back);
 * - score deltas: the share of checks that passed and the findings recorded, now and before.
 *
 * Best practices and findings that need review are not failures and never count. A scan with
 * nothing to compare (the first one) gets a record with zero counts, so it is evaluated once.
 */
import type postgres from 'postgres';
import { uuidv7 } from '@rampsmith/queue';

type Tx = postgres.TransactionSql;

/** The findings listed on a record; the counts hold the totals. */
export const MAX_ITEMS = 50;

type Impact = 'critical' | 'serious' | 'moderate' | 'minor';
const IMPACT_ORDER: Readonly<Record<Impact, number>> = {
  critical: 0,
  serious: 1,
  moderate: 2,
  minor: 3,
};

interface RegressionItem {
  readonly findingId: string;
  readonly ruleId: string;
  readonly impact: Impact;
  readonly criteria: readonly string[];
  readonly kind: 'new' | 'reappeared';
}

export interface RegressionRecord {
  readonly id: string;
  readonly previousScanId: string | null;
  readonly newCount: number;
  readonly reappearedCount: number;
  readonly items: readonly RegressionItem[];
}

export interface RegressionContext {
  readonly tenantId: string;
  readonly siteId: string;
  readonly scanId: string;
  readonly trigger: string;
  readonly status: string;
}

/** Percentage of checks that passed, two decimals; `null` when the scan ran none. */
export function passRate(run: number, passed: number): number | null {
  if (run < 1) return null;
  return Math.round((Math.min(passed, run) / run) * 10_000) / 100;
}

/**
 * Compares the scan with the one before it and stores the record. Returns the record when this
 * call wrote it, and `null` when the scan is not a finished scheduled scan or was evaluated
 * before (a retried job writes nothing twice).
 */
export async function recordRegression(
  tx: Tx,
  ctx: RegressionContext,
): Promise<RegressionRecord | null> {
  if (ctx.trigger !== 'scheduled') return null;
  if (ctx.status !== 'succeeded' && ctx.status !== 'partial') return null;
  const [done] = await tx<{ id: string }[]>`
    select id from regressions where tenant_id = ${ctx.tenantId} and scan_id = ${ctx.scanId}`;
  if (done !== undefined) return null;

  const [current] = await tx<{ run: number; passed: number; created: Date }[]>`
    select checks_run as run, checks_passed as passed, created_at as created from scans
     where tenant_id = ${ctx.tenantId} and id = ${ctx.scanId}`;
  if (current === undefined) return null;
  const [previous] = await tx<{ id: string; run: number; passed: number }[]>`
    select id, checks_run as run, checks_passed as passed from scans
     where tenant_id = ${ctx.tenantId} and site_id = ${ctx.siteId} and id <> ${ctx.scanId}
       and trigger in ('manual', 'scheduled', 'webhook')
       and status in ('succeeded', 'partial') and finalized_at is not null
       and created_at < ${current.created}
     order by created_at desc, id desc limit 1`;

  const seen = async (scanId: string): Promise<number> => {
    const [row] = await tx<{ n: number }[]>`
      select count(*)::int as n from findings f
       where f.tenant_id = ${ctx.tenantId} and f.site_id = ${ctx.siteId} and not f.best_practice
         and exists (select 1 from finding_occurrences o
                      where o.tenant_id = ${ctx.tenantId} and o.scan_id = ${scanId}
                        and o.finding_id = f.id)`;
    return row?.n ?? 0;
  };

  let items: RegressionItem[] = [];
  let newCount = 0;
  let reappearedCount = 0;
  if (previous !== undefined) {
    const regressed = await tx<
      {
        id: string;
        rule_id: string;
        impact: Impact;
        criteria: string[];
        first_seen_scan: string;
        priority: string | null;
      }[]
    >`
      select f.id, f.rule_id, f.impact, f.criteria, f.first_seen_scan,
             f.priority_score::text as priority
        from findings f
       where f.tenant_id = ${ctx.tenantId} and f.site_id = ${ctx.siteId}
         and f.status = 'open' and not f.best_practice
         and exists (select 1 from finding_occurrences o
                      where o.tenant_id = ${ctx.tenantId} and o.scan_id = ${ctx.scanId}
                        and o.finding_id = f.id)
         and not exists (select 1 from finding_occurrences o
                          where o.tenant_id = ${ctx.tenantId} and o.scan_id = ${previous.id}
                            and o.finding_id = f.id)`;
    items = regressed
      .map((f): RegressionItem & { priority: number } => ({
        findingId: f.id,
        ruleId: f.rule_id,
        impact: f.impact,
        criteria: f.criteria,
        kind: f.first_seen_scan === ctx.scanId ? 'new' : 'reappeared',
        priority: f.priority === null ? 0 : Number(f.priority),
      }))
      .sort(
        (a, b) =>
          IMPACT_ORDER[a.impact] - IMPACT_ORDER[b.impact] ||
          b.priority - a.priority ||
          a.findingId.localeCompare(b.findingId),
      );
    newCount = items.filter((i) => i.kind === 'new').length;
    reappearedCount = items.length - newCount;
  }

  const id = uuidv7();
  const listed = items.slice(0, MAX_ITEMS).map((i) => ({
    finding_id: i.findingId,
    rule_id: i.ruleId,
    impact: i.impact,
    criteria: i.criteria,
    kind: i.kind,
  }));
  const [written] = await tx<{ id: string }[]>`
    insert into regressions
      (id, tenant_id, site_id, scan_id, previous_scan_id, new_count, reappeared_count,
       findings_seen, previous_findings_seen, pass_rate, previous_pass_rate, items, alert_state)
    values (${id}, ${ctx.tenantId}, ${ctx.siteId}, ${ctx.scanId}, ${previous?.id ?? null},
            ${newCount}, ${reappearedCount}, ${await seen(ctx.scanId)},
            ${previous === undefined ? null : await seen(previous.id)},
            ${passRate(current.run, current.passed)},
            ${previous === undefined ? null : passRate(previous.run, previous.passed)},
            ${tx.json(listed)}, 'not_applicable')
    on conflict (scan_id) do nothing
    returning id`;
  if (written === undefined) return null;
  return {
    id,
    previousScanId: previous?.id ?? null,
    newCount,
    reappearedCount,
    items: items.slice(0, MAX_ITEMS),
  };
}

/** Records what became of the alert for a record (`queued`, `plan`, `no_contact`). */
export async function markAlert(
  tx: Tx,
  tenantId: string,
  regressionId: string,
  state: 'queued' | 'plan' | 'no_contact',
): Promise<void> {
  await tx`
    update regressions set alert_state = ${state}
     where tenant_id = ${tenantId} and id = ${regressionId}`;
}
