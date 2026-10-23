/**
 * The emails the pipeline queues when something finishes (ADR-279): the first scan's results, the
 * weekly rescan's summary and a fix's verification. Each runs inside the transaction of the job
 * that finished the work, so the email is queued if and only if the work is recorded, and each
 * has a message key built from what caused it, so a retried job queues nothing twice (the queue
 * deduplicates the job; the sender's ledger deduplicates the send).
 *
 * Whether the merchant wants the mail is not decided here. The mailer holds the suppression list
 * and the opt-outs (ADR-275) and drops a refused message with a recorded reason; this module
 * only avoids queueing mail that could never be sent (no contact, nothing to report).
 *
 * Nothing here reads or writes the owner's address.
 */
import { enqueue } from '@rampsmith/queue';
import axe from 'axe-core';
import { RULES } from '@rampsmith/a11y-rules';
import type postgres from 'postgres';

type Tx = postgres.TransactionSql;

type Impacts = Readonly<Record<'critical' | 'serious' | 'moderate' | 'minor', number>>;

interface StoreContact {
  readonly shopId: string;
  readonly storeName: string;
  /** A canonical BCP 47 tag, or absent. */
  readonly locale: string | undefined;
}

/** The shop of a site and what its emails say about it, or `undefined` when no email can go. */
async function contactOfSite(
  tx: Tx,
  tenantId: string,
  siteId: string,
): Promise<StoreContact | undefined> {
  const [row] = await tx<{ shop_id: string; store_name: string; locale: string | null }[]>`
    select c.shop_id, c.store_name, c.locale
      from shopify_shops sh
      join shop_contacts c on c.shop_id = sh.id and c.tenant_id = sh.tenant_id
     where sh.tenant_id = ${tenantId} and sh.site_id = ${siteId} and sh.status = 'installed'`;
  if (row === undefined) return undefined;
  return {
    shopId: row.shop_id,
    storeName: row.store_name.slice(0, 100),
    locale: canonicalLocale(row.locale),
  };
}

function canonicalLocale(text: string | null): string | undefined {
  if (text === null || text.length > 35) return undefined;
  try {
    const [canonical] = Intl.getCanonicalLocales(text);
    return canonical === undefined ? undefined : new Intl.Locale(canonical).baseName;
  } catch {
    return undefined;
  }
}

/** Queues one `email.send@1`; `false` when the message key was queued before. */
async function queueEmail(
  tx: Tx,
  tenantId: string,
  contact: StoreContact,
  template: string,
  input: Record<string, unknown>,
  messageKey: string,
): Promise<boolean> {
  const created = await enqueue(tx, {
    queue: 'email.send',
    payloadSchema: 'email.send@1',
    payload: {
      template,
      recipient: { kind: 'shop_owner', shop_id: contact.shopId },
      input: { ...input, ...(contact.locale === undefined ? {} : { locale: contact.locale }) },
      message_key: messageKey,
    },
    tenantId,
    idempotencyKey: `email.send:${messageKey}`,
    maxAttempts: 24,
  });
  return created.created;
}

/** The finished scan's check totals, or `undefined` when it ran none. */
async function checksOf(
  tx: Tx,
  tenantId: string,
  scanId: string,
): Promise<{ passed: number; total: number } | undefined> {
  const [row] = await tx<{ run: number; passed: number }[]>`
    select checks_run as run, checks_passed as passed from scans
     where tenant_id = ${tenantId} and id = ${scanId}`;
  if (row === undefined || row.run < 1) return undefined;
  return { passed: Math.min(row.passed, row.run), total: row.run };
}

/** Open findings by impact, best practices left out (the same count the app shows). */
async function openImpacts(tx: Tx, tenantId: string, siteId: string): Promise<Impacts> {
  const rows = await tx<{ impact: keyof Impacts; n: number }[]>`
    select impact, count(*)::int as n from findings
     where tenant_id = ${tenantId} and site_id = ${siteId} and status = 'open' and not best_practice
     group by impact`;
  const counts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const r of rows) counts[r.impact] = r.n;
  return counts;
}

async function proposedFixes(tx: Tx, tenantId: string, siteId: string): Promise<number> {
  const [row] = await tx<{ n: number }[]>`
    select count(*)::int as n from fixes
     where tenant_id = ${tenantId} and site_id = ${siteId} and kind = 'data' and status = 'proposed'`;
  return row?.n ?? 0;
}

function iso(date: Date): string {
  return date.toISOString().replace(/\.\d+Z$/u, 'Z');
}

/**
 * After a scan was finalised. The first finished scan of a site sends `first_scan_complete`; a
 * later scheduled one (the weekly rescan) sends `weekly_summary`. A manual rescan sends neither:
 * the merchant is looking at the app. Returns what was queued, for the caller's log line.
 */
export async function queueScanEmails(
  tx: Tx,
  ctx: {
    readonly tenantId: string;
    readonly siteId: string;
    readonly scanId: string;
    readonly trigger: string;
    readonly status: string;
    readonly pagesChecked: number;
    readonly resolved: number;
    readonly now: Date;
  },
): Promise<'first_scan_complete' | 'weekly_summary' | null> {
  if (ctx.status !== 'succeeded' && ctx.status !== 'partial') return null;
  const contact = await contactOfSite(tx, ctx.tenantId, ctx.siteId);
  if (contact === undefined) return null;
  const checks = await checksOf(tx, ctx.tenantId, ctx.scanId);
  if (checks === undefined) return null;

  const [earlier] = await tx<{ id: string; run: number; passed: number }[]>`
    select id, checks_run as run, checks_passed as passed from scans
     where tenant_id = ${ctx.tenantId} and site_id = ${ctx.siteId} and id <> ${ctx.scanId}
       and trigger in ('manual', 'scheduled', 'webhook') and finalized_at is not null and status in ('succeeded', 'partial')
       and checks_run > 0
     order by finalized_at desc limit 1`;

  if (earlier === undefined) {
    const queued = await queueEmail(
      tx,
      ctx.tenantId,
      contact,
      'first_scan_complete',
      {
        storeName: contact.storeName,
        completedAt: iso(ctx.now),
        pagesChecked: Math.min(100_000, Math.max(1, ctx.pagesChecked)),
        checks,
        issues: await openImpacts(tx, ctx.tenantId, ctx.siteId),
        fixesReady: await proposedFixes(tx, ctx.tenantId, ctx.siteId),
      },
      `first-scan-complete:${ctx.siteId}`,
    );
    return queued ? 'first_scan_complete' : null;
  }
  if (ctx.trigger !== 'scheduled') return null;

  const [fresh] = await tx<{ n: number }[]>`
    select count(*)::int as n from findings
     where tenant_id = ${ctx.tenantId} and site_id = ${ctx.siteId} and first_seen_scan = ${ctx.scanId}
       and status = 'open' and not best_practice`;
  const queued = await queueEmail(
    tx,
    ctx.tenantId,
    contact,
    'weekly_summary',
    {
      storeName: contact.storeName,
      periodEnd: iso(ctx.now),
      checks,
      previousChecks: {
        passed: Math.min(earlier.passed, earlier.run),
        total: earlier.run,
      },
      newIssues: fresh?.n ?? 0,
      resolvedIssues: ctx.resolved,
      openIssues: await openImpacts(tx, ctx.tenantId, ctx.siteId),
      fixesAwaitingApproval: await proposedFixes(tx, ctx.tenantId, ctx.siteId),
      nextScanAt: iso(new Date(ctx.now.getTime() + 7 * 24 * 3_600_000)),
    },
    `weekly-summary:${ctx.scanId}`,
  );
  return queued ? 'weekly_summary' : null;
}

/** A short title for a finding's rule: our catalog's sentence, else axe's own help text. */
export function ruleTitle(ruleId: string): string {
  const custom = (RULES as Readonly<Record<string, { summary: string } | undefined>>)[ruleId];
  const text =
    custom?.summary ?? axe.getRules().find((r) => r.ruleId === ruleId)?.description ?? ruleId;
  return text.length <= 120 ? text : `${text.slice(0, 117)}...`;
}

/**
 * After a fix was verified, or re-checked and found to fail: one `fix_verified` email for the
 * fix. `criteria` are the WCAG criteria of the findings the fix resolves.
 */
export async function queueFixVerified(
  tx: Tx,
  ctx: {
    readonly tenantId: string;
    readonly siteId: string;
    readonly fixId: string;
    readonly verified: boolean;
    readonly title: string;
    readonly criterion: string;
    readonly now: Date;
  },
): Promise<boolean> {
  const contact = await contactOfSite(tx, ctx.tenantId, ctx.siteId);
  if (contact === undefined) return false;
  const item = [{ title: ctx.title.slice(0, 120), criterion: ctx.criterion }];
  return queueEmail(
    tx,
    ctx.tenantId,
    contact,
    'fix_verified',
    {
      storeName: contact.storeName,
      verifiedAt: iso(ctx.now),
      verified: ctx.verified ? item : [],
      moreVerified: 0,
      notVerified: ctx.verified ? [] : item,
      moreNotVerified: 0,
    },
    // The verdict is in the key: a fix that failed and later passed is two different facts.
    `fix-${ctx.verified ? 'verified' : 'unverified'}:${ctx.fixId}`,
  );
}
