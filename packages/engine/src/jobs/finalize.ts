/**
 * `scan.finalize@1` (ADR-035, ADR-036, ADR-072): runs once every planned page and data input is
 * done. It closes the findings the scan did not see again and could have seen, ranks the open
 * findings (PLAN §11 priority score), writes the coverage disclosure (ADR-225) and ends the
 * scan. Running it again changes nothing.
 */
import { RULESET_VERSION } from '../ruleset.ts';
import { AXE_VERSION } from '../scan-page.ts';
import { RULES } from '@rampsmith/a11y-rules';
import axe from 'axe-core';
import { JobFailure } from '@rampsmith/queue';
import type postgres from 'postgres';
import { progressOf } from '../pipeline/progress.ts';
import { rank, type Impact, type Rankable } from '../pipeline/rank.ts';
import { PAGE_TYPES, type PageType } from '../pipeline/vocab.ts';
import { scrubUrl } from '../scrub.ts';
import { criteriaFromTags } from '../wcag.ts';
import { queueScanEmails } from '../email/triggers.ts';
import { withTenant } from '../store.ts';
import { parsePayload, requireTenant, type JobHandler } from './payload.ts';

function permanent(code: string, message: string): JobFailure {
  return new JobFailure('permanent', { code, message });
}

/** The custom browser checks and the rules each one can report (a11y-rules ADR-114). */
const CHECK_RULES: Readonly<Record<string, readonly string[]>> = {
  'rs-check-keyboard': ['rs-keyboard-trap', 'rs-focus-indicator-missing', 'rs-focus-stop-hidden'],
  'rs-check-focus-obscured': ['rs-focus-obscured'],
  'rs-check-reflow': ['rs-reflow-horizontal-scroll'],
  'rs-check-text-spacing': ['rs-text-spacing-clipped', 'rs-text-spacing-overlap'],
  'rs-check-media-autoplay': ['rs-media-autoplay-audio'],
};

const AXE_CRITERIA: ReadonlyMap<string, readonly string[]> = new Map(
  axe.getRules().map((r) => [r.ruleId, criteriaFromTags(r.tags)] as const),
);

/** WCAG criteria the rules that ran cover, sorted. */
function criteriaCovered(rulesRun: readonly string[]): string[] {
  const criteria = new Set<string>();
  for (const id of rulesRun) {
    for (const c of AXE_CRITERIA.get(id) ?? []) criteria.add(c);
    for (const ruleId of CHECK_RULES[id] ?? []) {
      const meta = (RULES as Readonly<Record<string, { criteria: readonly string[] } | undefined>>)[
        ruleId
      ];
      for (const c of meta?.criteria ?? []) criteria.add(c);
    }
    const custom = (RULES as Readonly<Record<string, { criteria: readonly string[] } | undefined>>)[
      id
    ];
    for (const c of custom?.criteria ?? []) criteria.add(c);
  }
  return [...criteria].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

type CoverageDocument = Record<string, unknown>;

export interface FinalizeDeps {
  readonly sql: postgres.Sql;
}

interface OpenFinding {
  id: string;
  rule_id: string;
  impact: Impact;
  origin: 'render' | 'data';
  on_purchase_path: boolean;
  page_types: PageType[];
  fix_kind: string | null;
}

export function scanFinalizeHandler(deps: FinalizeDeps): JobHandler {
  return async (job) => {
    const payload = parsePayload(job, 'scan.finalize@1');
    const tenantId = requireTenant(job);
    await withTenant(deps.sql, tenantId, async (tx) => {
      const [scan] = await tx<
        {
          status: string;
          trigger: string;
          finalized_at: Date | null;
          coverage: CoverageDocument | null;
        }[]
      >`
        select status, trigger, finalized_at, coverage from scans
         where tenant_id = ${tenantId} and id = ${payload.scan_id} and site_id = ${payload.site_id}
         for update`;
      if (scan === undefined) throw permanent('scan_not_found', 'no such scan for this tenant');
      if (scan.finalized_at !== null) return;
      // A verification scan loads a few pages; finalising it would close the rest (ADR-073).
      if (scan.trigger === 'verify') return;
      const progress = await progressOf(tx, tenantId, payload.scan_id);
      if (progress?.complete !== true) return; // enqueued early; the last piece of work enqueues it again

      // Pages: what loaded, what a challenge or a closed storefront stopped, what failed.
      const pages = await tx<
        {
          url: string;
          viewport: string;
          page_state: string;
          page_type: PageType | null;
          blocked_reason: string | null;
          state_outcome: string | null;
          rules_run: string[];
        }[]
      >`
        select url, viewport, page_state, page_type, blocked_reason, state_outcome, rules_run
          from scan_pages where tenant_id = ${tenantId} and scan_id = ${payload.scan_id}`;
      const defaults = pages.filter((p) => p.page_state === 'default');
      const loaded = defaults.filter(
        (p) => p.blocked_reason === null && p.state_outcome === 'opened',
      );
      const blocked = defaults.filter((p) => p.blocked_reason !== null);
      const failed = defaults.filter(
        (p) => p.blocked_reason === null && p.state_outcome === 'error',
      );
      const loadedTypes = new Set(
        loaded.flatMap((p) => (p.page_type === null ? [] : [p.page_type])),
      );
      const openedStates = new Set(
        pages
          .filter((p) => p.state_outcome === 'opened' && p.blocked_reason === null)
          .map((p) => `${scrubUrl(p.url)}\u001f${p.page_state}`),
      );

      // Close what the scan could have seen again and did not.
      const closable = await tx<{ id: string; seen: string[] }[]>`
        select f.id,
               array_agg(o.page_url || chr(31) || o.page_state) as seen
          from findings f
          join finding_occurrences o
            on o.finding_id = f.id and o.tenant_id = f.tenant_id and o.scan_id = f.last_seen_scan
         where f.tenant_id = ${tenantId} and f.site_id = ${payload.site_id}
           and f.origin = 'render' and f.status in ('open', 'needs_review')
           and f.last_seen_scan <> ${payload.scan_id} and o.page_type is not null
         group by f.id`;
      const gone = closable
        .filter((f) => f.seen.length > 0 && f.seen.every((key) => openedStates.has(key)))
        .map((f) => f.id);
      let resolved = gone.length;
      if (gone.length > 0) {
        await tx`
          update findings set status = 'fixed'
           where tenant_id = ${tenantId} and id in ${tx(gone)}`;
      }
      if (progress.inputsPlanned > 0) {
        // The data audit read every resource, so a data finding it did not see again is fixed.
        const fixed = await tx`
          update findings set status = 'fixed'
           where tenant_id = ${tenantId} and site_id = ${payload.site_id} and origin = 'data'
             and status in ('open', 'needs_review') and last_seen_scan <> ${payload.scan_id}`;
        resolved += fixed.count;
      }

      // Rank the open findings.
      const open = await tx<OpenFinding[]>`
        select f.id, f.rule_id, f.impact, f.origin, f.on_purchase_path, f.fix_kind,
               coalesce(array_remove(array_agg(distinct o.page_type), null), '{}') as page_types
          from findings f
          left join finding_occurrences o
            on o.finding_id = f.id and o.tenant_id = f.tenant_id and o.scan_id = f.last_seen_scan
         where f.tenant_id = ${tenantId} and f.site_id = ${payload.site_id}
           and f.status = 'open' and not f.best_practice
         group by f.id`;
      const everywhere = Math.max(1, Math.min(loadedTypes.size, PAGE_TYPES.length));
      const rankables: Rankable[] = open.map((f) => {
        // A menu shows on every template; other store data shows on one.
        const global = f.rule_id.startsWith('rs-menu-');
        return {
          id: f.id,
          ruleId: f.rule_id,
          impact: f.impact,
          pageTypes: f.page_types,
          templates: f.origin === 'data' ? (global ? everywhere : 1) : f.page_types.length,
          origin: f.origin,
          onPurchasePath: f.on_purchase_path,
        };
      });
      const ranked = rank(rankables);
      for (let i = 0; i < ranked.length; i += 500) {
        const chunk = ranked.slice(i, i + 500).map((r) => ({
          id: r.id,
          score: r.score,
          templates: r.templatesAffected,
          purchase: r.onPurchasePath,
          kind: r.fix.kind,
          recipe: r.fix.recipe,
        }));
        await tx`
          update findings f
             set priority_score = v.score,
                 templates_affected = v.templates,
                 on_purchase_path = v.purchase,
                 fix_kind = v.kind,
                 fix_recipe = v.recipe
            from jsonb_to_recordset(${tx.json(chunk)}) as v(
                   id uuid, score numeric, templates int, purchase boolean, kind text, recipe text)
           where f.tenant_id = ${tenantId} and f.id = v.id`;
      }

      // Coverage disclosure (ADR-225): the rules that ran, the criteria they cover, the queue.
      const rulesRun = [...new Set(pages.flatMap((p) => p.rules_run))].sort();
      const [queue] = await tx<{ n: number }[]>`
        select count(*)::int as n from findings
         where tenant_id = ${tenantId} and site_id = ${payload.site_id} and status = 'needs_review'`;
      const states: Record<string, Record<string, number>> = {};
      for (const p of pages) {
        if (p.page_state === 'default' || p.state_outcome === null) continue;
        const entry = (states[p.page_state] ??= {});
        entry[p.state_outcome] = (entry[p.state_outcome] ?? 0) + 1;
      }
      const coverage: CoverageDocument = {
        ...(scan.coverage ?? {}),
        version: 1,
        ruleset: {
          axe: AXE_VERSION,
          custom: Object.values(RULES)
            .map((r) => r.id)
            .sort(),
        },
        rules_run: rulesRun,
        criteria_tested: criteriaCovered(rulesRun),
        review_queue: queue?.n ?? 0,
        pages: {
          planned: progress.pagesPlanned,
          loaded: loaded.length,
          blocked: blocked.length,
          failed: failed.length,
          blocked_reasons: [
            ...new Set(
              blocked.flatMap((p) => (p.blocked_reason === null ? [] : [p.blocked_reason])),
            ),
          ],
        },
        states,
      };
      const status =
        loaded.length === 0 && progress.pagesPlanned > 0
          ? 'failed'
          : blocked.length + failed.length > 0
            ? 'partial'
            : 'succeeded';
      const errorCode =
        status === 'failed'
          ? blocked.length > 0
            ? `blocked_${blocked[0]?.blocked_reason ?? 'unknown'}`
            : 'no_pages_loaded'
          : null;
      await tx`
        update scans
           set status = ${status}, error_code = ${errorCode}, ruleset_version = ${RULESET_VERSION},
               coverage = ${tx.json(coverage as postgres.JSONValue)},
               finished_at = now(), finalized_at = now(),
               storefront_password_ct = null, storefront_password_key_id = null
         where tenant_id = ${tenantId} and id = ${payload.scan_id}`;
      // The scan's results go to the merchant: the first scan's, and each weekly rescan's
      // (ADR-279). Queued in this transaction, so a retried finalize cannot queue them twice.
      await queueScanEmails(tx, {
        tenantId,
        siteId: payload.site_id,
        scanId: payload.scan_id,
        trigger: scan.trigger,
        status,
        pagesChecked: new Set(loaded.map((p) => scrubUrl(p.url))).size,
        resolved,
        now: new Date(),
      });
    });
  };
}
