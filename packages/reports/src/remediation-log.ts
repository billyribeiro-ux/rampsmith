// The remediation log export (PLAN §16 "Reports"; §5 "What each fix must carry"): every fix,
// the findings it resolves with their WCAG criteria, who approved it and when, and its
// verification result, as CSV for spreadsheets and as versioned JSON (ADR-224).
import { toCsv } from './csv.ts';
import { safeWebUrl, sanitizeText } from './escape.ts';
import { translator, type MessageKey, type Translator } from './i18n.ts';
import {
  quote,
  ReportInputError,
  requireDate,
  requireItems,
  requireLine,
  requireOneOf,
  requireText,
} from './validate.ts';
import {
  FIX_CHANNELS,
  FIX_KINDS,
  FIX_ORIGINS,
  FIX_STATUSES,
  IMPACTS,
  PLATFORMS,
  channelCarries,
  type FixChannel,
  type FixKind,
  type FixOrigin,
  type FixStatus,
  type Impact,
  type Platform,
} from './vocabulary.ts';
import { compareCriteria, isWcag22AaCriterion } from './wcag.ts';

export interface RemediationFinding {
  readonly findingId: string;
  readonly ruleId: string;
  readonly criteria: readonly string[];
  readonly impact: Impact;
  /** One plain-language sentence, such as the rule's summary. */
  readonly summary: string;
}

/** The exact change (PLAN §5): a data diff, or a reference to the code patch. */
export type FixChange =
  | {
      readonly kind: 'data';
      /** The Shopify GID or other resource id the field belongs to. */
      readonly resource: string;
      readonly field: string;
      readonly before: string;
      readonly after: string;
    }
  | {
      readonly kind: 'code';
      /** The pull request URL, or the patch's storage key (`fixes.patch_key`). */
      readonly reference: string;
    };

export type Approver =
  { readonly kind: 'user'; readonly name: string } | { readonly kind: 'system' };

/** One row of `fixes` with its `fix_findings` (PLAN §9). */
export interface RemediationEntry {
  readonly fixId: string;
  readonly kind: FixKind;
  readonly channel: FixChannel;
  readonly origin: FixOrigin;
  /** Required exactly when `origin` is `ai`. */
  readonly model?: string;
  readonly status: FixStatus;
  readonly proposedAt: Date;
  readonly approvedAt: Date | null;
  /** Null exactly when `approvedAt` is null. A user's name is supplied by the caller. */
  readonly approver: Approver | null;
  readonly appliedAt: Date | null;
  readonly change: FixChange;
  /** The verification scan (`fixes.verified_scan`); required for a verified fix. */
  readonly verification?: { readonly scanId: string; readonly at: Date };
  /** The fix this one undoes (`fixes.reverts`). */
  readonly reverts?: string;
  readonly findings: readonly RemediationFinding[];
}

export interface RemediationLogInput {
  readonly locale: string;
  readonly site: { readonly name: string; readonly url: string; readonly platform: Platform };
  readonly generatedAt: Date;
  readonly entries: readonly RemediationEntry[];
}

export type VerificationResult =
  'passed' | 'failed' | 'pending' | 'not_applied' | 'reverted' | 'rejected';

/** What a fix's status says about its verification (PLAN §12 "Verification and undo"). */
export function verificationResult(status: FixStatus): VerificationResult {
  switch (status) {
    case 'verified':
      return 'passed';
    case 'failed':
      return 'failed';
    case 'applied':
      return 'pending';
    case 'proposed':
    case 'approved':
    case 'applying':
      return 'not_applied';
    case 'reverted':
      return 'reverted';
    case 'rejected':
      return 'rejected';
  }
}

/** Longest text a spreadsheet cell holds is 32,767 characters; stay under it. */
export const MAX_CELL = 32_000;
/** Longest before or after value accepted for one data fix. */
const MAX_VALUE = 1_000_000;

interface CheckedEntry extends Omit<RemediationEntry, 'findings'> {
  readonly findings: readonly RemediationFinding[];
  readonly result: VerificationResult;
}

function checkEntry(entry: RemediationEntry, index: number): CheckedEntry {
  const f = `entries[${String(index)}]`;
  const fixId = requireLine(`${f}.fixId`, entry.fixId, 100);
  const kind = requireOneOf(`${f}.kind`, entry.kind, FIX_KINDS);
  const channel = requireOneOf(`${f}.channel`, entry.channel, FIX_CHANNELS);
  if (!channelCarries(channel, kind)) {
    throw new ReportInputError(`${f}.channel`, `a ${kind} fix cannot ship through ${channel}`);
  }
  const origin = requireOneOf(`${f}.origin`, entry.origin, FIX_ORIGINS);
  if ((origin === 'ai') !== (entry.model !== undefined)) {
    throw new ReportInputError(
      `${f}.model`,
      'an AI fix must name its model, and only an AI fix may',
    );
  }
  const model = entry.model === undefined ? undefined : requireLine(`${f}.model`, entry.model, 100);
  const status = requireOneOf(`${f}.status`, entry.status, FIX_STATUSES);
  const proposedAt = requireDate(`${f}.proposedAt`, entry.proposedAt);
  if ((entry.approver === null) !== (entry.approvedAt === null)) {
    throw new ReportInputError(`${f}.approver`, 'must be set exactly when approvedAt is set');
  }
  const approvedAt =
    entry.approvedAt === null ? null : requireDate(`${f}.approvedAt`, entry.approvedAt);
  // Rebuilt field by field, so nothing beyond the kind and the name reaches the export.
  let approver: Approver | null = null;
  if (entry.approver !== null) {
    requireOneOf(`${f}.approver.kind`, entry.approver.kind, ['user', 'system']);
    approver =
      entry.approver.kind === 'system'
        ? { kind: 'system' }
        : { kind: 'user', name: requireLine(`${f}.approver.name`, entry.approver.name) };
  }
  const appliedAt =
    entry.appliedAt === null ? null : requireDate(`${f}.appliedAt`, entry.appliedAt);
  if (entry.change.kind !== kind) {
    throw new ReportInputError(`${f}.change`, `a ${kind} fix needs a ${kind} change`);
  }
  const change: FixChange =
    entry.change.kind === 'data'
      ? {
          kind: 'data',
          resource: requireLine(`${f}.change.resource`, entry.change.resource, 500),
          field: requireLine(`${f}.change.field`, entry.change.field, 100),
          before: limited(`${f}.change.before`, entry.change.before),
          after: limited(`${f}.change.after`, entry.change.after),
        }
      : {
          kind: 'code',
          reference: requireLine(`${f}.change.reference`, entry.change.reference, 2_000),
        };
  if (status === 'verified' && entry.verification === undefined) {
    throw new ReportInputError(
      `${f}.verification`,
      'a verified fix must name its verification scan',
    );
  }
  const verification =
    entry.verification === undefined
      ? undefined
      : {
          scanId: requireLine(`${f}.verification.scanId`, entry.verification.scanId, 100),
          at: requireDate(`${f}.verification.at`, entry.verification.at),
        };
  const reverts =
    entry.reverts === undefined ? undefined : requireLine(`${f}.reverts`, entry.reverts, 100);
  if (entry.findings.length === 0) {
    throw new ReportInputError(`${f}.findings`, 'a fix resolves at least one finding');
  }
  const findings = requireItems(`${f}.findings`, entry.findings, 1_000).map((x, j) => {
    const g = `${f}.findings[${String(j)}]`;
    const criteria = [...new Set(x.criteria)].sort(compareCriteria);
    for (const id of criteria) {
      if (!isWcag22AaCriterion(id)) {
        throw new ReportInputError(
          `${g}.criteria`,
          `${quote(id)} is not a WCAG 2.2 A or AA criterion`,
        );
      }
    }
    return {
      findingId: requireLine(`${g}.findingId`, x.findingId, 100),
      ruleId: requireLine(`${g}.ruleId`, x.ruleId, 100),
      criteria,
      impact: requireOneOf(`${g}.impact`, x.impact, IMPACTS),
      summary: requireText(`${g}.summary`, x.summary, 500),
    };
  });
  return {
    fixId,
    kind,
    channel,
    origin,
    ...(model === undefined ? {} : { model }),
    status,
    proposedAt,
    approvedAt,
    approver,
    appliedAt,
    change,
    ...(verification === undefined ? {} : { verification }),
    ...(reverts === undefined ? {} : { reverts }),
    findings,
    result: verificationResult(status),
  };
}

/** A data value may legitimately be empty (an image with no alt text), but not oversized. */
function limited(field: string, value: string): string {
  const clean = sanitizeText(value);
  if (clean.length > MAX_VALUE) {
    throw new ReportInputError(field, `must be at most ${String(MAX_VALUE)} characters`);
  }
  return clean;
}

function checkLog(input: RemediationLogInput): {
  readonly t: Translator;
  readonly site: { readonly name: string; readonly url: string; readonly platform: Platform };
  readonly generatedAt: Date;
  readonly entries: readonly CheckedEntry[];
} {
  const url = safeWebUrl(input.site.url);
  if (url === undefined) {
    throw new ReportInputError('site.url', 'must be an absolute https or http URL');
  }
  const entries = requireItems('entries', input.entries, 100_000)
    .map(checkEntry)
    .sort(
      (a, b) =>
        a.proposedAt.getTime() - b.proposedAt.getTime() ||
        (a.fixId < b.fixId ? -1 : a.fixId > b.fixId ? 1 : 0),
    );
  return {
    t: translator(input.locale),
    site: {
      name: requireLine('site.name', input.site.name),
      url,
      platform: requireOneOf('site.platform', input.site.platform, PLATFORMS),
    },
    generatedAt: requireDate('generatedAt', input.generatedAt),
    entries,
  };
}

/** UTC timestamps to the second, such as `2026-10-01T11:00:05Z`. */
function iso(date: Date | null | undefined): string {
  return date === null || date === undefined ? '' : date.toISOString().replace(/\.\d{3}Z$/u, 'Z');
}

function cell(value: string): string {
  return value.length > MAX_CELL ? `${value.slice(0, MAX_CELL - 1)}…` : value;
}

const COLUMNS: readonly MessageKey[] = [
  'log_column_fix_id',
  'log_column_kind',
  'log_column_channel',
  'log_column_origin',
  'log_column_model',
  'log_column_status',
  'log_column_rule',
  'log_column_finding_id',
  'log_column_criteria',
  'log_column_impact',
  'log_column_finding',
  'log_column_change',
  'log_column_before',
  'log_column_after',
  'log_column_proposed_at',
  'log_column_approved_by',
  'log_column_approved_at',
  'log_column_applied_at',
  'log_column_verification',
  'log_column_verification_scan',
  'log_column_verified_at',
  'log_column_reverts',
];

/**
 * CSV, one row per finding a fix resolves, oldest fix first. Labels are in the requested
 * language; timestamps are ISO 8601 in UTC so every spreadsheet reads them the same way.
 */
export function remediationLogCsv(input: RemediationLogInput): string {
  const { t, entries } = checkLog(input);
  const rows = entries.flatMap((e) =>
    e.findings.map((finding) => {
      const change =
        e.change.kind === 'data'
          ? t.text('label_change_data', { resource: e.change.resource, field: e.change.field })
          : t.text('label_change_code', { reference: e.change.reference });
      return [
        e.fixId,
        t.text(`label_kind_${e.kind}`),
        t.text(`label_channel_${e.channel}`),
        t.text(`label_origin_${e.origin}`),
        e.model ?? '',
        t.text(`label_status_${e.status}`),
        finding.ruleId,
        finding.findingId,
        finding.criteria.join('; '),
        t.text(`label_impact_${finding.impact}`),
        finding.summary,
        change,
        e.change.kind === 'data' ? e.change.before : '',
        e.change.kind === 'data' ? e.change.after : '',
        iso(e.proposedAt),
        e.approver === null
          ? ''
          : e.approver.kind === 'system'
            ? t.text('label_approver_system')
            : e.approver.name,
        iso(e.approvedAt),
        iso(e.appliedAt),
        t.text(`label_verification_${e.result}`),
        e.verification?.scanId ?? '',
        iso(e.verification?.at),
        e.reverts ?? '',
      ].map(cell);
    }),
  );
  return toCsv(
    COLUMNS.map((k) => t.text(k)),
    rows,
  );
}

/**
 * JSON, version 1: enum values as stored (PLAN §9), timestamps in ISO 8601 UTC. `<`, `>`,
 * `&`, U+2028 and U+2029 are written as escapes, so the file is also safe to embed in HTML.
 */
export function remediationLogJson(input: RemediationLogInput): string {
  const { site, generatedAt, entries } = checkLog(input);
  const record = {
    format: 'rampsmith.remediation-log',
    version: 1,
    generatedAt: iso(generatedAt),
    site,
    entries: entries.map((e) => ({
      fixId: e.fixId,
      kind: e.kind,
      channel: e.channel,
      origin: e.origin,
      model: e.model ?? null,
      status: e.status,
      proposedAt: iso(e.proposedAt),
      approvedAt: e.approvedAt === null ? null : iso(e.approvedAt),
      approvedBy: e.approver,
      appliedAt: e.appliedAt === null ? null : iso(e.appliedAt),
      change: e.change,
      verification: {
        result: e.result,
        scanId: e.verification?.scanId ?? null,
        verifiedAt: e.verification === undefined ? null : iso(e.verification.at),
      },
      reverts: e.reverts ?? null,
      findings: e.findings,
    })),
  };
  return `${JSON.stringify(record, null, 2).replace(
    /[<>&\u2028\u2029]/gu,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )}\n`;
}
