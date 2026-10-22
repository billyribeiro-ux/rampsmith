/**
 * Records a scanned page for its tenant (PLAN §9, §11 step 8): one `scan_pages` row per state,
 * findings merged by fingerprint, their occurrences, evidence crops, and the scan's progress, in
 * one transaction scoped by `app.tenant_id`, so row-level security applies to every statement
 * (ADR-006).
 *
 * Idempotent: `scan_pages` is unique per scan, URL, state and viewport, so a job that runs again
 * after a crash records nothing twice.
 */
import { uuidv7 } from '@rampsmith/queue';
import type postgres from 'postgres';
import { fingerprint } from './fingerprint.ts';
import { advance, type Progress } from './pipeline/progress.ts';
import { fixabilityOf } from './pipeline/rank.ts';
import type { PageType, Viewport } from './pipeline/vocab.ts';
import { scrubExcerpt, scrubSelector, scrubUrl } from './scrub.ts';
import type { Impact, Occurrence, PageScan, StateScan } from './scan-page.ts';

export interface PageContext {
  readonly tenantId: string;
  readonly siteId: string;
  readonly scanId: string;
}

/** What the plan knew about the page that the browser cannot tell. */
export interface PageMeta {
  readonly pageType: PageType | null;
  readonly viewport: Viewport;
}

export interface RecordOutcome {
  /** False when this page was already recorded for the scan. */
  readonly recorded: boolean;
  readonly findings: number;
  readonly occurrences: number;
  /** The scan's progress after this page; `undefined` when the scan accepts no more work. */
  readonly progress: Progress | undefined;
}

const RANK: Record<Impact, number> = { minor: 1, moderate: 2, serious: 3, critical: 4 };

/** Occurrence rows kept per finding and state; the finding's count has the rest. */
const MAX_OCCURRENCES = 25;

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

type Kind = 'violation' | 'incomplete' | 'best_practice';

interface Group {
  readonly print: Uint8Array;
  readonly items: Occurrence[];
}

/** Everything is written from scrubbed text (PLAN §19, audit L10), fingerprint included. */
function group(occurrences: readonly Occurrence[]): Group[] {
  const groups = new Map<string, Group>();
  for (const raw of occurrences) {
    const o: Occurrence = {
      ...raw,
      target: scrubSelector(raw.target),
      html: scrubExcerpt(raw.html),
    };
    const print = fingerprint(o.ruleId, o.target, o.section ?? '');
    const key = Buffer.from(print).toString('hex');
    const entry = groups.get(key) ?? { print, items: [] };
    entry.items.push(o);
    groups.set(key, entry);
  }
  return [...groups.values()];
}

/** The fingerprints (hex) of every failure on the page, in any state. */
export function violationPrints(scan: PageScan): Set<string> {
  return new Set(
    scan.states.flatMap((s) =>
      group(s.violations).map((g) => Buffer.from(g.print).toString('hex')),
    ),
  );
}

async function recordGroup(
  tx: postgres.TransactionSql,
  ctx: PageContext,
  state: StateScan,
  meta: PageMeta,
  pageUrl: string,
  entry: Group,
  kind: Kind,
  capturedAt: Date,
): Promise<number> {
  const [first] = entry.items;
  if (first === undefined) return 0;
  const status = kind === 'incomplete' ? 'needs_review' : 'open';
  const fix = fixabilityOf(first.ruleId, 'render');
  const [finding] = await tx<{ id: string }[]>`
    insert into findings (id, tenant_id, site_id, fingerprint, rule_id, criteria, impact, status,
                          first_seen_scan, last_seen_scan, occurrence_count, origin, best_practice,
                          fix_kind, fix_recipe)
    values (${uuidv7()}, ${ctx.tenantId}, ${ctx.siteId}, ${Buffer.from(entry.print)},
            ${first.ruleId}, ${tx.array([...first.criteria])}, ${worst(entry.items)}, ${status},
            ${ctx.scanId}, ${ctx.scanId}, ${entry.items.length}, 'render',
            ${kind === 'best_practice'}, ${fix.kind}, ${fix.recipe})
    on conflict (site_id, fingerprint) do update
       set occurrence_count = case
             when findings.last_seen_scan = excluded.last_seen_scan
             then findings.occurrence_count + excluded.occurrence_count
             else excluded.occurrence_count end,
           last_seen_scan = excluded.last_seen_scan,
           impact = excluded.impact,
           criteria = excluded.criteria,
           status = case
             when excluded.status = 'open' and findings.status in ('fixed', 'needs_review')
               then 'open'
             when excluded.status = 'needs_review' and findings.status = 'fixed'
               then 'needs_review'
             else findings.status end
     where findings.tenant_id = excluded.tenant_id
    returning id`;
  if (finding === undefined) return 0;
  let written = 0;
  for (const o of entry.items.slice(0, MAX_OCCURRENCES)) {
    await tx`
      insert into finding_occurrences
        (finding_id, scan_id, tenant_id, page_url, page_state, target, html_excerpt, captured_at,
         page_type, viewport)
      values (${finding.id}, ${ctx.scanId}, ${ctx.tenantId}, ${pageUrl}, ${state.state},
              ${o.target}, ${o.html}, ${capturedAt}, ${meta.pageType}, ${meta.viewport})`;
    written += 1;
  }
  // The "before" picture: the first crop of a finding that has none yet.
  const crop = entry.items.find((o) => o.crop !== undefined)?.crop;
  if (crop !== undefined && kind === 'violation') {
    await tx`
      insert into evidence (id, tenant_id, scan_id, finding_id, content_type, bytes)
      select ${uuidv7()}, ${ctx.tenantId}, ${ctx.scanId}, ${finding.id}, 'image/png', ${crop}
       where not exists (
         select 1 from evidence where tenant_id = ${ctx.tenantId} and finding_id = ${finding.id})`;
  }
  return written;
}

function pageRow(
  scan: PageScan,
  state: PageState | 'default',
  s: StateScan | undefined,
  meta: PageMeta,
) {
  return {
    state,
    status: scan.status,
    duration: Math.round(s?.durationMs ?? scan.durationMs),
    result: s?.result ?? null,
    violations: s?.violations.length ?? 0,
    rulesRun: s?.rulesRun ?? [],
    checksRun: s?.checksRun ?? 0,
    checksPassed: s?.checksPassed ?? 0,
    meta,
  };
}
type PageState = StateScan['state'];

export function recordPage(
  sql: postgres.Sql,
  ctx: PageContext,
  scan: PageScan,
  meta: PageMeta = { pageType: null, viewport: 'desktop' },
  capturedAt: Date = new Date(),
): Promise<RecordOutcome> {
  return withTenant(sql, ctx.tenantId, async (tx) => {
    const rows =
      scan.blocked === undefined
        ? scan.states.map((s) => pageRow(scan, s.state, s, meta))
        : [pageRow(scan, 'default', undefined, meta)];
    const pageUrl = scrubUrl(scan.finalUrl);
    let inserted = 0;
    let findings = 0;
    let occurrences = 0;
    let checksRun = 0;
    let checksPassed = 0;
    for (const row of rows) {
      const state = scan.states.find((s) => s.state === row.state);
      const [page] = await tx<{ id: string }[]>`
        insert into scan_pages
          (id, tenant_id, scan_id, url, page_state, http_status, duration_ms, blocked_reason,
           violations, page_type, viewport, state_outcome, rules_run, checks_run, checks_passed)
        values (${uuidv7()}, ${ctx.tenantId}, ${ctx.scanId}, ${scan.url}, ${row.state},
                ${row.status}, ${row.duration}, ${scan.blocked ?? null}, ${row.violations},
                ${meta.pageType}, ${meta.viewport}, ${row.result},
                ${tx.array([...new Set(row.rulesRun)])}, ${row.checksRun}, ${row.checksPassed})
        on conflict (scan_id, url, page_state, viewport) do nothing
        returning id`;
      if (page === undefined || state === undefined) {
        if (page !== undefined) inserted += 1;
        continue;
      }
      inserted += 1;
      checksRun += row.checksRun;
      checksPassed += row.checksPassed;
      const kinds: [Kind, readonly Occurrence[]][] = [
        ['violation', state.violations],
        ['incomplete', state.incomplete],
        ['best_practice', state.bestPractice],
      ];
      for (const [kind, list] of kinds) {
        for (const entry of group(list)) {
          findings += 1;
          occurrences += await recordGroup(tx, ctx, state, meta, pageUrl, entry, kind, capturedAt);
        }
      }
    }
    if (inserted === 0)
      return { recorded: false, findings: 0, occurrences: 0, progress: undefined };
    const progress = await advance(tx, ctx.tenantId, ctx.scanId, {
      pages: 1,
      checksRun,
      checksPassed,
    });
    return { recorded: true, findings, occurrences, progress };
  });
}

/**
 * Records that a page could not be loaded and will not be tried again, so the scan can finish
 * without it (the scan ends `partial`).
 */
export function recordFailure(
  sql: postgres.Sql,
  ctx: PageContext,
  url: string,
  meta: PageMeta,
): Promise<RecordOutcome> {
  return withTenant(sql, ctx.tenantId, async (tx) => {
    const [page] = await tx<{ id: string }[]>`
      insert into scan_pages
        (id, tenant_id, scan_id, url, page_state, duration_ms, page_type, viewport, state_outcome)
      values (${uuidv7()}, ${ctx.tenantId}, ${ctx.scanId}, ${url}, 'default', 0, ${meta.pageType},
              ${meta.viewport}, 'error')
      on conflict (scan_id, url, page_state, viewport) do nothing
      returning id`;
    if (page === undefined)
      return { recorded: false, findings: 0, occurrences: 0, progress: undefined };
    const progress = await advance(tx, ctx.tenantId, ctx.scanId, { pages: 1 });
    return { recorded: true, findings: 0, occurrences: 0, progress };
  });
}
