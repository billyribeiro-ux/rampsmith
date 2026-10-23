/**
 * `verify.scan@1` (ADR-035, ADR-036, ADR-073): after a fix is applied, re-audits the re-read
 * store data and rescans the affected pages, then records whether the finding is gone and
 * whether anything new appeared (PLAN §5, "What each fix must carry"). A fix is `verified`
 * only when both hold; otherwise it keeps its status, records why, and the finding is reopened,
 * so the app can offer the undo. The verification scan's findings enter the site's findings,
 * but the scan is never finalised (that would close every finding on pages it did not load).
 */
import { JobFailure } from '@rampsmith/queue';
import { uuidv7 } from '@rampsmith/queue';
import { auditBatch } from '../pipeline/audit.ts';
import { readInput } from '../pipeline/inputs.ts';
import {
  AUDITED_KINDS,
  parseBatch,
  parseShop,
  type AuditedKind,
  type Batch,
} from '../pipeline/snapshot.ts';
import type { PageType } from '../pipeline/vocab.ts';
import { recordPage, violationPrints, withTenant } from '../store.ts';
import { onSiteUrl, scanThroughEgress, type EngineDeps } from '../worker.ts';
import { parsePayload, requireTenant, type JobHandler } from './payload.ts';

function permanent(code: string, message: string): JobFailure {
  return new JobFailure('permanent', { code, message });
}

interface FixFinding {
  id: string;
  rule_id: string;
  fingerprint: Buffer;
  origin: 'render' | 'data';
  resource: string | null;
}

/** Which batch a `verify` input holds: its `kind` member, else the shape of its items. */
function inferKind(payload: unknown): AuditedKind | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const record = payload as Record<string, unknown>;
  const named = record['kind'] ?? record['source_kind'];
  if (typeof named === 'string' && (AUDITED_KINDS as readonly string[]).includes(named)) {
    return named as AuditedKind;
  }
  const first = Array.isArray(record['items']) ? (record['items'][0] as unknown) : undefined;
  if (typeof first !== 'object' || first === null) return undefined;
  const item = first as Record<string, unknown>;
  if ('media' in item) return 'products';
  if ('blog_handle' in item || 'blogHandle' in item || 'blog' in item) return 'articles';
  if ('items' in item) return 'menus';
  if ('body' in item) return 'pages';
  if ('description_html' in item || 'descriptionHtml' in item) return 'collections';
  return undefined;
}

/** Every resource id the batch names: owners, media and menu items. */
function knownResources(batch: Batch): Set<string> {
  const ids = new Set<string>();
  for (const p of batch.products) {
    ids.add(p.id);
    for (const m of p.media) ids.add(m.id);
  }
  for (const c of batch.collections) ids.add(c.id);
  for (const p of batch.pages) ids.add(p.id);
  for (const a of batch.articles) ids.add(a.id);
  const walk = (items: Batch['menus'][number]['items']): void => {
    for (const i of items) {
      ids.add(i.resource);
      walk(i.items);
    }
  };
  for (const m of batch.menus) {
    ids.add(m.id);
    walk(m.items);
  }
  return ids;
}

type VerifyVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: 'verify_finding_remains' | 'verify_new_findings' | 'verify_unreadable';
    };

/** The verdict from what was checked. Pure, so the rule is tested without a browser. */
function verdictOf(facts: {
  readonly remaining: number;
  readonly unverifiable: number;
  readonly fresh: number;
}): VerifyVerdict {
  if (facts.unverifiable > 0) return { ok: false, code: 'verify_unreadable' };
  if (facts.remaining > 0) return { ok: false, code: 'verify_finding_remains' };
  if (facts.fresh > 0) return { ok: false, code: 'verify_new_findings' };
  return { ok: true };
}

export function verifyScanHandler(deps: EngineDeps): JobHandler {
  return async (job) => {
    const payload = parsePayload(job, 'verify.scan@1');
    const tenantId = requireTenant(job);
    const ctx = { tenantId, siteId: payload.site_id, scanId: payload.scan_id };

    // 1. What the fix claims to fix.
    const loaded = await withTenant(deps.sql, tenantId, async (tx) => {
      const [fix] = await tx<{ id: string; verified_scan: string | null; status: string }[]>`
        select id, verified_scan, status from fixes
         where tenant_id = ${tenantId} and id = ${payload.fix_id} and site_id = ${payload.site_id}`;
      if (fix === undefined) throw permanent('fix_not_found', 'no such fix for this tenant');
      const [scan] = await tx<{ trigger: string }[]>`
        select trigger from scans
         where tenant_id = ${tenantId} and id = ${payload.scan_id} and site_id = ${payload.site_id}`;
      if (scan === undefined) throw permanent('scan_not_found', 'no such scan for this tenant');
      const findings = await tx<FixFinding[]>`
        select f.id, f.rule_id, f.fingerprint, f.origin,
               f.source_location ->> 'resource' as resource
          from fix_findings ff
          join findings f on f.id = ff.finding_id and f.tenant_id = ff.tenant_id
         where ff.tenant_id = ${tenantId} and ff.fix_id = ${payload.fix_id}`;
      const [snapshot] = await tx<{ after_value: unknown }[]>`
        select after_value from data_fix_snapshots
         where tenant_id = ${tenantId} and fix_id = ${payload.fix_id}`;
      const [site] = await tx<{ primary_locale: string }[]>`
        select primary_locale from sites where tenant_id = ${tenantId} and id = ${payload.site_id}`;
      return { fix, findings, after: snapshot?.after_value, locale: site?.primary_locale ?? 'en' };
    });
    if (loaded.fix.verified_scan === payload.scan_id) return; // an earlier attempt finished
    if (loaded.findings.length === 0) {
      throw permanent('fix_without_findings', 'the fix resolves no finding');
    }

    // 2. The data side: re-audit the re-read store data.
    const gone = new Set<string>(); // finding ids confirmed gone
    let unverifiable = 0;
    let freshData = 0;
    if (payload.input_id !== undefined && payload.input_id !== null) {
      const inputId = payload.input_id;
      const data = await withTenant(deps.sql, tenantId, async (tx) => {
        const input = await readInput(tx, tenantId, inputId);
        if (input === undefined) throw permanent('input_not_found', 'no such input');
        const [shop] = await tx<{ payload: unknown }[]>`
          select payload from scan_inputs
           where tenant_id = ${tenantId} and scan_id = ${input.scanId} and kind = 'shop'
           order by seq desc limit 1`;
        const kind = inferKind(input.payload);
        if (kind === undefined) return undefined;
        const batch = parseBatch(kind, input.payload);
        const audit = auditBatch(
          kind,
          batch,
          parseShop(shop?.payload, loaded.locale).primaryLocale,
        );
        const prints = audit.items.map((i) => Buffer.from(i.fingerprint).toString('hex'));
        const known =
          prints.length === 0
            ? []
            : await tx<{ fp: string }[]>`
          select encode(fingerprint, 'hex') as fp from findings
           where tenant_id = ${tenantId} and site_id = ${payload.site_id}
             and fingerprint in ${tx(audit.items.map((i) => Buffer.from(i.fingerprint)))}`;
        return {
          present: knownResources(batch),
          prints: new Set(prints),
          fresh: prints.filter((p) => !known.some((k) => k.fp === p)).length,
        };
      });
      if (data === undefined) {
        unverifiable += loaded.findings.filter((f) => f.origin === 'data').length;
      } else {
        freshData = data.fresh;
        for (const f of loaded.findings.filter((x) => x.origin === 'data')) {
          if (f.resource === null || !data.present.has(f.resource)) unverifiable += 1;
          else if (!data.prints.has(f.fingerprint.toString('hex'))) gone.add(f.id);
        }
      }
    } else {
      unverifiable += loaded.findings.filter((f) => f.origin === 'data').length;
    }

    // 3. The render side: rescan the affected pages.
    const afterAlt =
      typeof loaded.after === 'string'
        ? loaded.after
        : typeof loaded.after === 'object' && loaded.after !== null
          ? (loaded.after as Record<string, unknown>)['alt']
          : undefined;
    const cropSelector =
      typeof afterAlt === 'string' && afterAlt !== ''
        ? `img[alt="${cssString(afterAlt)}"]`
        : undefined;
    let freshRender = 0;
    let afterCrop: Buffer | undefined;
    const pageResults: { url: string; blocked: boolean }[] = [];
    const renderPrints = new Set<string>();
    for (const url of payload.urls) {
      const target = await onSiteUrl(deps.sql, tenantId, payload.site_id, payload.scan_id, url);
      const result = await scanThroughEgress(deps, {
        ...ctx,
        target,
        viewport: 'desktop',
        states: ['default'],
        deep: false,
        ...(cropSelector === undefined ? {} : { cropSelectors: [cropSelector] }),
      }).catch((error: unknown) => {
        throw new JobFailure('retryable', {
          code: 'page_load_failed',
          message: error instanceof Error ? error.message.slice(0, 200) : 'page load failed',
        });
      });
      pageResults.push({ url: target.href, blocked: result.blocked !== undefined });
      if (result.blocked === undefined) {
        const prints = violationPrints(result);
        const known =
          prints.size === 0
            ? []
            : await withTenant(
                deps.sql,
                tenantId,
                (tx) =>
                  tx<{ fp: string }[]>`
            select encode(fingerprint, 'hex') as fp from findings
             where tenant_id = ${tenantId} and site_id = ${payload.site_id}
               and fingerprint in ${tx([...prints].map((p) => Buffer.from(p, 'hex')))}`,
              );
        freshRender += [...prints].filter((p) => !known.some((k) => k.fp === p)).length;
        for (const p of prints) renderPrints.add(p);
        if (cropSelector !== undefined && afterCrop === undefined)
          afterCrop = result.crops[cropSelector];
      }
      await recordPage(
        deps.sql,
        ctx,
        { ...result, url: target.href },
        { pageType: pageTypeOf(target), viewport: 'desktop' },
      );
    }
    const allLoaded = pageResults.every((p) => !p.blocked);
    for (const f of loaded.findings.filter((x) => x.origin === 'render')) {
      if (!allLoaded) unverifiable += 1;
      else if (!renderPrints.has(f.fingerprint.toString('hex'))) gone.add(f.id);
    }

    // 4. The verdict.
    const remaining = loaded.findings.filter((f) => !gone.has(f.id)).length - unverifiable;
    const verdict = verdictOf({
      remaining: Math.max(0, remaining),
      unverifiable,
      fresh: freshData + freshRender,
    });
    await withTenant(deps.sql, tenantId, async (tx) => {
      // A verification only counts while the fix is still in the shop. An undo that committed
      // while the pages were being scanned (or one that commits right after this check, which
      // waits for this row lock) must not find its reopened findings closed again (lane A
      // audit L3). The scan itself is still finished below.
      const [current] = await tx<{ status: string }[]>`
        select status from fixes
         where tenant_id = ${tenantId} and id = ${payload.fix_id} for update`;
      const inShop = current?.status === 'applied' || current?.status === 'verified';
      let afterId: string | null = null;
      if (inShop && afterCrop !== undefined && verdict.ok) {
        const [first] = loaded.findings;
        afterId = uuidv7();
        await tx`
          insert into evidence (id, tenant_id, scan_id, finding_id, content_type, bytes)
          values (${afterId}, ${tenantId}, ${payload.scan_id}, ${first?.id ?? null}, 'image/png',
                  ${afterCrop})`;
      }
      if (inShop && gone.size > 0) {
        await tx`
          update findings set status = 'fixed'
           where tenant_id = ${tenantId} and id in ${tx([...gone])}
             and status in ('open', 'needs_review')`;
      }
      const stillOpen = loaded.findings.filter((f) => !gone.has(f.id)).map((f) => f.id);
      if (inShop && stillOpen.length > 0 && !verdict.ok) {
        await tx`
          update findings set status = 'open'
           where tenant_id = ${tenantId} and id in ${tx(stillOpen)} and status = 'fixed'`;
      }
      if (inShop) {
        await tx`
        update fixes
           set verified_scan = ${payload.scan_id},
               before_evidence_id = coalesce(before_evidence_id, (
                 select e.id from evidence e
                  where e.tenant_id = ${tenantId} and e.finding_id = ${loaded.findings[0]?.id ?? null}
                    and e.scan_id <> ${payload.scan_id}
                  order by e.created_at limit 1)),
               after_evidence_id = coalesce(${afterId}, after_evidence_id),
               verified_at = ${verdict.ok ? new Date() : null},
               status = case when ${verdict.ok} and status = 'applied' then 'verified' else status end,
               error_code = ${verdict.ok ? null : verdict.code}
         where tenant_id = ${tenantId} and id = ${payload.fix_id}`;
      }
      await tx`
        update scans
           set status = ${verdict.ok || pageResults.every((p) => !p.blocked) ? 'succeeded' : 'partial'},
               finished_at = now(), finalized_at = now(),
               started_at = coalesce(started_at, now())
         where tenant_id = ${tenantId} and id = ${payload.scan_id}
           and status in ('queued', 'running')`;
    });
  };
}

/** Escapes `text` for a double-quoted CSS attribute value. */
function cssString(text: string): string {
  return text.replaceAll(/[\\"]/g, '\\$&').replaceAll('\n', '\\a ');
}

function pageTypeOf(url: URL): PageType | null {
  const first = url.pathname.split('/').find(Boolean);
  switch (first) {
    case undefined:
      return 'home';
    case 'products':
      return 'product';
    case 'collections':
      return 'collection';
    case 'pages':
      return 'page';
    case 'blogs':
      return 'article';
    case 'cart':
      return 'cart';
    case 'search':
      return 'search';
    case 'account':
      return 'login';
    default:
      return null;
  }
}
