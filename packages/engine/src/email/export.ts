/**
 * The remediation record attached to the uninstall email (PLAN §19, ADR-277). It is built here,
 * inside the job's tenant transaction, from the same renderer the app's export page uses
 * (`@rampsmith/reports`), so the file in the email and the file in the app are one format.
 *
 * It holds fix and finding data only: no address, no token. Nothing here logs.
 */
// The rules table alone: the package's main entry also loads the browser checks.
import { RULES } from '@rampsmith/a11y-rules/rules';
import type { EmailAttachment } from '@rampsmith/email';
import { remediationLogCsv, ReportInputError, type RemediationEntry } from '@rampsmith/reports';
import type postgres from 'postgres';
import { withTenant } from '../store.ts';

/** Fixes a record may hold; a store with more fails permanently rather than sending part of it. */
const MAX_RECORD_FIXES = 20_000;
const RECORD_FILE_NAME = 'rampsmith-remediation-record.csv';

const GENERIC_FINDING = 'An element on the page fails an accessibility check.';

interface FixRow {
  id: string;
  kind: 'data' | 'code';
  channel: RemediationEntry['channel'];
  origin: RemediationEntry['origin'];
  model: string | null;
  status: RemediationEntry['status'];
  created_at: Date;
  approved_at: Date | null;
  applied_at: Date | null;
  verified_scan: string | null;
  verified_at: Date | null;
  reverts: string | null;
  diff: Record<string, unknown> | null;
  patch_key: string | null;
  findings: { id: string; rule_id: string; criteria: string[]; impact: string }[];
}

export class RecordUnavailableError extends Error {
  readonly code: 'record_too_large' | 'record_invalid';
  constructor(code: 'record_too_large' | 'record_invalid', message: string) {
    super(message);
    this.name = 'RecordUnavailableError';
    this.code = code;
  }
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

function titleOf(ruleId: string): string {
  const known = (RULES as Readonly<Record<string, { summary: string } | undefined>>)[ruleId];
  return known?.summary ?? GENERIC_FINDING;
}

function entryOf(row: FixRow): RemediationEntry {
  const diff = row.diff ?? {};
  return {
    fixId: row.id,
    kind: row.kind,
    channel: row.channel,
    origin: row.origin,
    ...(row.origin === 'ai' ? { model: row.model ?? 'unknown' } : {}),
    status: row.status,
    proposedAt: row.created_at,
    approvedAt: row.approved_at,
    // Shopify does not give the app the staff member's name (the app's own export says the same).
    approver: row.approved_at === null ? null : { kind: 'system' },
    appliedAt: row.applied_at,
    change:
      row.kind === 'data'
        ? {
            kind: 'data',
            resource: text(diff['resource_gid']) || text(diff['resource']),
            field: 'alt',
            before: text(diff['before']),
            after: text(diff['after']),
          }
        : { kind: 'code', reference: row.patch_key ?? '' },
    ...(row.verified_scan !== null && row.verified_at !== null
      ? { verification: { scanId: row.verified_scan, at: row.verified_at } }
      : {}),
    ...(row.reverts === null ? {} : { reverts: row.reverts }),
    findings: row.findings.map((f) => ({
      findingId: f.id,
      ruleId: f.rule_id,
      criteria: f.criteria,
      impact: f.impact as RemediationEntry['findings'][number]['impact'],
      summary: titleOf(f.rule_id),
    })),
  };
}

/** The tenant's remediation record as a CSV attachment. */
export async function remediationRecord(
  sql: postgres.Sql,
  tenantId: string,
  shopId: string,
  now: Date,
): Promise<EmailAttachment> {
  const { rows, site } = await withTenant(sql, tenantId, async (tx) => {
    const [shop] = await tx<{ domain: string; name: string | null }[]>`
      select sh.shop_domain as domain, c.store_name as name
        from shopify_shops sh
        left join shop_contacts c on c.shop_id = sh.id and c.tenant_id = sh.tenant_id
       where sh.tenant_id = ${tenantId} and sh.id = ${shopId}`;
    const fixes = await tx<FixRow[]>`
      select f.id, f.kind, f.channel, f.origin, f.model, f.status, f.created_at, f.approved_at,
             f.applied_at, f.verified_scan, f.verified_at, f.reverts, f.diff, f.patch_key,
             coalesce((select json_agg(json_build_object('id', g.id, 'rule_id', g.rule_id,
                                                         'criteria', g.criteria, 'impact', g.impact)
                                       order by g.id)
                         from fix_findings ff
                         join findings g on g.id = ff.finding_id and g.tenant_id = ff.tenant_id
                        where ff.tenant_id = f.tenant_id and ff.fix_id = f.id), '[]'::json)
               as findings
        from fixes f
       where f.tenant_id = ${tenantId}
       order by f.created_at, f.id
       limit ${MAX_RECORD_FIXES + 1}`;
    return { rows: fixes, site: shop };
  });
  if (rows.length > MAX_RECORD_FIXES) {
    throw new RecordUnavailableError(
      'record_too_large',
      'the record has more fixes than one email holds',
    );
  }
  const domain = site?.domain ?? 'unknown';
  try {
    const csv = remediationLogCsv({
      locale: 'en',
      site: { name: site?.name ?? domain, url: `https://${domain}`, platform: 'shopify' },
      generatedAt: now,
      entries: rows.filter((r) => r.findings.length > 0).map(entryOf),
    });
    return {
      fileName: RECORD_FILE_NAME,
      contentType: 'text/csv',
      data: new TextEncoder().encode(csv),
    };
  } catch (error) {
    if (error instanceof ReportInputError) {
      throw new RecordUnavailableError(
        'record_invalid',
        `a record entry is not valid: ${error.message}`,
      );
    }
    throw error;
  }
}
