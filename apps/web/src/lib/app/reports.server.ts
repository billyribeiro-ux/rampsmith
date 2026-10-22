/**
 * Maps the api's view models onto the inputs of `@rampsmith/reports`, so the remediation log
 * export and the statement preview are produced by the same code that renders the stored
 * reports (ADR-091). Pure functions; the routes do the fetching.
 */
import type { RemediationEntry, StatementFinding, StatementInput } from '@rampsmith/reports';
import type { FindingSummary, FixSummary, Overview, StatementContent } from './types.ts';

export function remediationEntry(fix: FixSummary): RemediationEntry {
  const approver =
    fix.approved_at === null
      ? null
      : fix.approver_name === null
        ? ({ kind: 'system' } as const)
        : ({ kind: 'user', name: fix.approver_name } as const);
  return {
    fixId: fix.id,
    kind: fix.kind,
    channel: fix.channel,
    origin: fix.origin,
    ...(fix.origin === 'ai' ? { model: fix.model ?? 'unknown' } : {}),
    status: fix.status,
    proposedAt: new Date(fix.proposed_at),
    approvedAt: fix.approved_at === null ? null : new Date(fix.approved_at),
    approver,
    appliedAt: fix.applied_at === null ? null : new Date(fix.applied_at),
    change: {
      kind: 'data',
      resource: fix.change.resource_gid,
      field: fix.change.field,
      before: fix.change.before ?? '',
      after: fix.change.after,
    },
    ...(fix.verified_at !== null && fix.verified_scan !== null
      ? { verification: { scanId: fix.verified_scan, at: new Date(fix.verified_at) } }
      : {}),
    ...(fix.reverts === null ? {} : { reverts: fix.reverts }),
    findings: fix.findings.map((f) => ({
      findingId: f.id,
      ruleId: f.rule_id,
      criteria: f.criteria,
      impact: f.impact,
      summary: f.title,
    })),
  };
}

/** Only log entries that were ever approved or applied matter to an auditor; keep all. */
export function remediationEntries(fixes: readonly FixSummary[]): RemediationEntry[] {
  return fixes.map(remediationEntry);
}

function statementFinding(finding: FindingSummary): StatementFinding {
  return {
    summary: finding.title,
    criteria: finding.criteria,
    impact: finding.impact,
    status: finding.status,
    occurrences: finding.occurrence_count,
  };
}

const optional = (value: string): string | undefined => {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

/** Builds the renderer's input from the overview, the findings and the merchant's words. */
export function statementInput(options: {
  readonly overview: Overview;
  readonly findings: readonly FindingSummary[];
  readonly content: StatementContent;
  readonly locale: string;
  readonly now: Date;
}): StatementInput {
  const { overview, findings, content, locale, now } = options;
  const scan = overview.latest_scan;
  const done =
    scan !== null &&
    scan.finished_at !== null &&
    scan.status !== 'queued' &&
    scan.status !== 'running';
  const coverage = scan?.coverage ?? null;
  const email = optional(content.contact.email);
  const phone = optional(content.contact.phone);
  const postalAddress = optional(content.contact.postal_address);
  const formUrl = optional(content.contact.form_url);
  const responseTime = optional(content.contact.response_time);
  const compatibility = optional(content.compatibility);
  return {
    locale,
    organization: content.organization.trim() || (overview.shop.name ?? overview.shop.domain),
    site: {
      name: overview.shop.name ?? overview.shop.domain,
      url: `https://${overview.shop.domain}`,
      platform: 'shopify',
    },
    preparedAt: now,
    ...(overview.entitlements.scan_cadence === 'monthly'
      ? {}
      : {
          scanFrequency:
            overview.entitlements.scan_cadence === 'daily'
              ? ('daily' as const)
              : ('weekly' as const),
        }),
    ...(done
      ? {
          latestScan: {
            status: scan.status,
            finishedAt: new Date(scan.finished_at),
            pagesChecked: scan.pages_done,
            checksRun: scan.checks_run,
            checksPassed: scan.checks_passed,
          },
        }
      : {}),
    findings: findings.map(statementFinding),
    coverage: {
      automated: coverage?.automated ?? [],
      partial: coverage?.partial ?? [],
      rulesetVersion: scan?.ruleset_version ?? 'none',
      ...(coverage?.review_queue === null || coverage === null
        ? {}
        : { reviewQueue: coverage.review_queue }),
    },
    measures: content.measures.map((m) => m.trim()).filter((m) => m !== ''),
    limitations: content.limitations
      .filter((l) => l.description.trim() !== '')
      .map((l) => ({
        description: l.description.trim(),
        ...(optional(l.reason) === undefined ? {} : { reason: l.reason.trim() }),
        ...(optional(l.alternative) === undefined ? {} : { alternative: l.alternative.trim() }),
      })),
    contact: {
      ...(email === undefined ? {} : { email }),
      ...(phone === undefined ? {} : { phone }),
      ...(postalAddress === undefined ? {} : { postalAddress }),
      ...(formUrl === undefined ? {} : { formUrl }),
      ...(responseTime === undefined ? {} : { responseTime }),
    },
    ...(compatibility === undefined ? {} : { compatibility }),
  };
}
