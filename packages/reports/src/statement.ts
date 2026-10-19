// The merchant accessibility statement generator (PLAN §5 R1, §3 jobs 5). Structure follows
// the W3C WAI statement guidance and the EU model statement; the wording never claims that a
// store meets WCAG in full and never presents automated results as a complete evaluation
// (ADR-221). It renders a full HTML document, an HTML fragment to publish on the store, and
// plain text, all from one block list, so the three always agree.
import {
  blocksToHtml,
  blocksToText,
  emailLink,
  phoneLink,
  webLink,
  type Block,
  type Inline,
  type Link,
} from './blocks.ts';
import { classifyCoverage, type CoverageInput } from './coverage.ts';
import { reportDocument, type ReportDocument } from './document.ts';
import { markup } from './html.ts';
import { translator, type Locale, type Translator } from './i18n.ts';
import { automationLimitBlock, coverageBlocks } from './sections.ts';
import {
  quote,
  ReportInputError,
  MAX_LINE,
  optionalText,
  requireCount,
  requireDate,
  requireItems,
  requireLine,
  requireOneOf,
  requireText,
} from './validate.ts';
import {
  FINDING_STATUSES,
  IMPACTS,
  PLATFORMS,
  SCAN_STATUSES,
  scanHasResults,
  type FindingStatus,
  type Impact,
  type Platform,
  type ScanStatus,
} from './vocabulary.ts';
import { compareCriteria, isWcag22AaCriterion } from './wcag.ts';

/** A finding from the latest scans, as stored in `findings` (PLAN §9). */
export interface StatementFinding {
  /** One plain-language sentence for shoppers, such as the rule's summary. */
  readonly summary: string;
  readonly criteria: readonly string[];
  readonly impact: Impact;
  readonly status: FindingStatus;
  /** Pages and states that showed it in the latest scan. */
  readonly occurrences: number;
}

/** A barrier the merchant knows about and enters by hand. */
export interface MerchantLimitation {
  readonly description: string;
  readonly reason?: string;
  readonly alternative?: string;
  readonly plannedFixBy?: Date;
}

export interface StatementContact {
  readonly email?: string;
  readonly phone?: string;
  readonly postalAddress?: string;
  /** An absolute https URL, such as the theme app embed's barrier-report form. */
  readonly formUrl?: string;
  /** Written in the statement's language, such as "5 business days". */
  readonly responseTime?: string;
}

export interface StatementInput {
  /** BCP 47 tag of the statement's language, usually the store's primary locale. */
  readonly locale: string;
  /** Who publishes the statement: the merchant's business name. */
  readonly organization: string;
  readonly site: { readonly name: string; readonly url: string; readonly platform: Platform };
  readonly preparedAt: Date;
  readonly reviewedAt?: Date;
  readonly scanFrequency?: 'daily' | 'weekly';
  /** The latest scan with results; omit it before the first scan finishes. */
  readonly latestScan?: {
    readonly status: ScanStatus;
    readonly finishedAt: Date;
    readonly pagesChecked: number;
    readonly checksRun: number;
    readonly checksPassed: number;
  };
  /** Findings of the site. Open and accepted-risk ones are listed as known barriers. */
  readonly findings: readonly StatementFinding[];
  readonly coverage: CoverageInput;
  /** Fixes a verification scan confirmed (PLAN §5, "What each fix must carry"). */
  readonly verifiedFixes?: { readonly count: number; readonly since: Date };
  /** Further measures, in the merchant's words. */
  readonly measures?: readonly string[];
  readonly limitations?: readonly MerchantLimitation[];
  readonly contact: StatementContact;
  /** Browsers and assistive technology the merchant has tested with, in their words. */
  readonly compatibility?: string;
  /** Evaluations besides Rampsmith's automated checks, such as a manual review. */
  readonly otherEvaluations?: readonly { readonly description: string; readonly date?: Date }[];
  /** Where to go when a reply is unsatisfactory, such as a national enforcement body. */
  readonly complaints?: { readonly description: string; readonly url?: string };
}

/**
 * - `not_evaluated`: no scan has results yet.
 * - `known_barriers`: open or accepted-risk findings, failed checks, or merchant-entered
 *   limitations exist; worded after W3C's "partially conformant".
 * - `no_known_barriers`: the latest automated checks found nothing, which never means the
 *   standard is met in full, and the statement says so.
 */
export type StatementStatus = 'not_evaluated' | 'known_barriers' | 'no_known_barriers';

export interface RenderedStatement {
  readonly status: StatementStatus;
  readonly locale: Locale;
  /** True when the requested locale had no catalog and English was used. */
  readonly fallback: boolean;
  /** A complete document, for preview and for printing to PDF. */
  readonly document: ReportDocument;
  /** The statement's sections from h2 down, to publish inside a store page. */
  readonly fragment: string;
  readonly text: string;
}

/** Most known barriers listed one by one; the rest are counted. */
export const MAX_LISTED_BARRIERS = 50;

const BARRIER_STATUSES: ReadonlySet<FindingStatus> = new Set(['open', 'accepted_risk']);

export function statementStatus(input: {
  readonly latestScan?: StatementInput['latestScan'];
  readonly findings: readonly Pick<StatementFinding, 'status'>[];
  readonly limitations?: readonly unknown[];
}): StatementStatus {
  const scan = input.latestScan;
  if (scan === undefined || !scanHasResults(scan.status)) {
    return 'not_evaluated';
  }
  const barriers =
    input.findings.some((f) => BARRIER_STATUSES.has(f.status)) ||
    (input.limitations?.length ?? 0) > 0 ||
    scan.checksPassed < scan.checksRun;
  return barriers ? 'known_barriers' : 'no_known_barriers';
}

interface Barrier {
  readonly summary: string;
  readonly criteria: readonly string[];
  readonly impact: Impact;
  occurrences: number;
}

/**
 * Merges findings that read the same to a shopper, most severe and most frequent first.
 * Ties keep the input order, which callers set by the published priority score (PLAN §11).
 */
function barriers(findings: readonly StatementFinding[]): Barrier[] {
  const merged = new Map<string, Barrier>();
  findings.forEach((f, i) => {
    const field = `findings[${String(i)}]`;
    requireOneOf(`${field}.status`, f.status, FINDING_STATUSES);
    requireOneOf(`${field}.impact`, f.impact, IMPACTS);
    requireCount(`${field}.occurrences`, f.occurrences);
    const criteria = [...new Set(f.criteria)].sort(compareCriteria);
    for (const id of criteria) {
      if (!isWcag22AaCriterion(id)) {
        throw new ReportInputError(
          `${field}.criteria`,
          `${quote(id)} is not a WCAG 2.2 A or AA criterion`,
        );
      }
    }
    const summary = requireText(`${field}.summary`, f.summary, 500);
    if (!BARRIER_STATUSES.has(f.status)) return;
    const key = `${summary}\u0000${criteria.join(',')}`;
    const existing = merged.get(key);
    if (existing === undefined) {
      merged.set(key, { summary, criteria, impact: f.impact, occurrences: f.occurrences });
    } else {
      existing.occurrences += f.occurrences;
      if (IMPACTS.indexOf(f.impact) > IMPACTS.indexOf(existing.impact)) {
        merged.set(key, { ...existing, impact: f.impact });
      }
    }
  });
  return [...merged.values()].sort(
    (a, b) =>
      IMPACTS.indexOf(b.impact) - IMPACTS.indexOf(a.impact) || b.occurrences - a.occurrences,
  );
}

function contactItems(t: Translator, contact: StatementContact): Inline[][] {
  const items: Inline[][] = [];
  const need = <T>(field: string, value: T | undefined): T => {
    if (value === undefined) throw new ReportInputError(field, 'is not a valid value');
    return value;
  };
  if (contact.email !== undefined) {
    const email: Link = need('contact.email', emailLink(contact.email.trim()));
    items.push(t.rich('statement_feedback_email', { email }));
  }
  if (contact.phone !== undefined) {
    const phone = requireLine('contact.phone', contact.phone, 40);
    items.push(
      t.rich('statement_feedback_phone', { phone: need('contact.phone', phoneLink(phone)) }),
    );
  }
  if (contact.postalAddress !== undefined) {
    const address = requireText('contact.postalAddress', contact.postalAddress, 500);
    items.push(t.rich('statement_feedback_post', { address: address.replaceAll('\n', ', ') }));
  }
  if (contact.formUrl !== undefined) {
    const form = need(
      'contact.formUrl',
      webLink(contact.formUrl, t.text('statement_feedback_form_link')),
    );
    items.push(t.rich('statement_feedback_form', { form }));
  }
  if (items.length === 0) {
    throw new ReportInputError(
      'contact',
      'needs at least one of email, phone, postalAddress or formUrl',
    );
  }
  return items;
}

export function renderStatement(input: StatementInput): RenderedStatement {
  const t = translator(input.locale);
  const organization = requireLine('organization', input.organization);
  const site = requireLine('site.name', input.site.name);
  const platform = requireOneOf('site.platform', input.site.platform, PLATFORMS);
  const siteUrl = webLink(input.site.url);
  if (siteUrl === undefined) {
    throw new ReportInputError('site.url', 'must be an absolute https or http URL');
  }
  const preparedAt = requireDate('preparedAt', input.preparedAt);
  const coverage = classifyCoverage(input.coverage);
  requireItems('findings', input.findings);
  const scan = input.latestScan;
  if (scan !== undefined) {
    requireOneOf('latestScan.status', scan.status, SCAN_STATUSES);
    requireDate('latestScan.finishedAt', scan.finishedAt);
    requireCount('latestScan.pagesChecked', scan.pagesChecked);
    requireCount('latestScan.checksRun', scan.checksRun);
    requireCount('latestScan.checksPassed', scan.checksPassed);
    if (scan.checksPassed > scan.checksRun) {
      throw new ReportInputError('latestScan.checksPassed', 'cannot exceed checksRun');
    }
  }
  const limitations = requireItems('limitations', input.limitations ?? [], 100).map((l, i) => ({
    description: requireText(`limitations[${String(i)}].description`, l.description, 1_000),
    reason: optionalText(`limitations[${String(i)}].reason`, l.reason, 1_000),
    alternative: optionalText(`limitations[${String(i)}].alternative`, l.alternative, 1_000),
    plannedFixBy:
      l.plannedFixBy === undefined
        ? undefined
        : requireDate(`limitations[${String(i)}].plannedFixBy`, l.plannedFixBy),
  }));
  const found = barriers(input.findings);
  const status = statementStatus({ ...input, limitations });
  /** The latest scan, when it has results this statement may report. */
  const evaluated = status === 'not_evaluated' ? undefined : scan;

  const blocks: Block[] = [];
  const p = (...content: Inline[]): void => {
    blocks.push({ kind: 'paragraph', content });
  };
  const h = (level: 2 | 3, value: string): void => {
    blocks.push({ kind: 'heading', level, content: [value] });
  };

  p(t.text('statement_intro', { organization, site }));
  p(...t.rich('statement_scope', { site, url: siteUrl }));

  // Measures (W3C "Measures to support accessibility").
  h(2, t.text('statement_measures_heading'));
  const measures: Inline[][] = [];
  if (input.scanFrequency !== undefined) {
    const frequency = requireOneOf('scanFrequency', input.scanFrequency, ['daily', 'weekly']);
    measures.push([
      t.text(
        frequency === 'daily' ? 'statement_measure_scans_daily' : 'statement_measure_scans_weekly',
        { site },
      ),
    ]);
  }
  measures.push([t.text('statement_measure_source')]);
  if (input.verifiedFixes !== undefined && input.verifiedFixes.count > 0) {
    measures.push([
      t.text('statement_measure_fixed', {
        count: requireCount('verifiedFixes.count', input.verifiedFixes.count),
        date: t.date(requireDate('verifiedFixes.since', input.verifiedFixes.since)),
      }),
    ]);
  }
  requireItems('measures', input.measures ?? [], 50).forEach((m, i) => {
    measures.push([requireText(`measures[${String(i)}]`, m, 1_000)]);
  });
  blocks.push({ kind: 'list', items: measures });

  // Status (W3C "Conformance status"; EU "Compliance status"), without either word.
  h(2, t.text('statement_status_heading'));
  p(t.text('statement_standard'));
  switch (status) {
    case 'not_evaluated':
      p(t.text('statement_status_not_evaluated', { site }));
      break;
    case 'known_barriers':
      p(t.text('statement_status_known_barriers', { site }));
      break;
    case 'no_known_barriers':
      p(
        t.text('statement_status_no_known_barriers', {
          site,
          date: t.date(evaluated?.finishedAt ?? preparedAt),
        }),
      );
      break;
  }
  if (evaluated !== undefined) {
    p(
      t.text('statement_checks_passed', {
        site,
        date: t.date(evaluated.finishedAt),
        passed: evaluated.checksPassed,
        total: evaluated.checksRun,
      }),
    );
    if (evaluated.status === 'partial') {
      p(t.text('statement_scan_partial'));
    }
  }
  blocks.push(automationLimitBlock(t));

  // Known limitations (W3C "Limitations and alternatives"; EU "Non-accessible content").
  h(2, t.text('statement_limitations_heading'));
  if (evaluated === undefined && limitations.length === 0) {
    p(t.text('statement_limitations_unknown', { site }));
  } else if (found.length === 0 && limitations.length === 0) {
    p(t.text('statement_limitations_none', { site }));
  } else {
    p(t.text('statement_limitations_intro', { site }));
    const items: Inline[][] = [];
    for (const l of limitations) {
      const parts = [l.description];
      if (l.reason !== undefined)
        parts.push(t.text('statement_limitation_reason', { reason: l.reason }));
      if (l.alternative !== undefined) {
        parts.push(t.text('statement_limitation_alternative', { alternative: l.alternative }));
      }
      if (l.plannedFixBy !== undefined) {
        parts.push(t.text('statement_limitation_planned', { date: t.date(l.plannedFixBy) }));
      }
      items.push([parts.join(' ')]);
    }
    for (const b of found.slice(0, MAX_LISTED_BARRIERS)) {
      const parts = [b.summary];
      if (b.criteria.length > 0) {
        parts.push(
          t.text('statement_limitation_criteria', {
            count: b.criteria.length,
            criteria: t.list(b.criteria),
          }),
        );
      }
      parts.push(t.text('statement_limitation_places', { count: b.occurrences }));
      items.push([parts.join(' ')]);
    }
    blocks.push({ kind: 'list', items });
    if (found.length > MAX_LISTED_BARRIERS) {
      p(t.text('statement_limitations_more', { count: found.length - MAX_LISTED_BARRIERS }));
    }
  }
  p(
    t.text(
      platform === 'shopify' ? 'statement_third_party_shopify' : 'statement_third_party_generic',
    ),
  );

  // Feedback (W3C "Feedback"; EU "Feedback and contact information").
  h(2, t.text('statement_feedback_heading'));
  p(t.text('statement_feedback_intro', { site }));
  blocks.push({ kind: 'list', items: contactItems(t, input.contact) });
  const responseTime = optionalText('contact.responseTime', input.contact.responseTime, MAX_LINE);
  if (responseTime !== undefined) {
    p(t.text('statement_feedback_response', { responseTime }));
  }

  // Technical information (W3C "Technical specifications" and "Compatibility").
  h(2, t.text('statement_technical_heading'));
  p(t.text('statement_technical', { site }));
  const compatibility = optionalText('compatibility', input.compatibility, 1_000);
  if (compatibility !== undefined) p(compatibility);

  // How we checked (W3C "Assessment approach"; EU "Preparation ... method used").
  h(2, t.text('statement_assessment_heading'));
  if (evaluated !== undefined) {
    p(
      t.text('statement_assessment_automated', {
        site,
        date: t.date(evaluated.finishedAt),
        pages: evaluated.pagesChecked,
      }),
    );
  } else {
    p(t.text('statement_assessment_none', { site }));
  }
  const others = requireItems('otherEvaluations', input.otherEvaluations ?? [], 20).map((e, i) => {
    const description = requireText(
      `otherEvaluations[${String(i)}].description`,
      e.description,
      1_000,
    );
    return e.date === undefined
      ? description
      : t.text('statement_assessment_other_dated', {
          description,
          date: t.date(requireDate(`otherEvaluations[${String(i)}].date`, e.date)),
        });
  });
  if (others.length > 0) {
    blocks.push({ kind: 'list', items: others.map((o) => [o]) });
  }
  blocks.push(...coverageBlocks(t, coverage, false));

  // Formal complaints (W3C) and enforcement procedure (EU), when the merchant gives one.
  if (input.complaints !== undefined) {
    h(2, t.text('statement_complaints_heading'));
    p(requireText('complaints.description', input.complaints.description, 1_000));
    if (input.complaints.url !== undefined) {
      const link = webLink(input.complaints.url);
      if (link === undefined) {
        throw new ReportInputError('complaints.url', 'must be an absolute https or http URL');
      }
      p(...t.rich('statement_complaints_link', { link }));
    }
  }

  // Date of the statement (W3C; EU "Preparation of this accessibility statement").
  const dates = [t.text('statement_prepared', { date: t.date(preparedAt) })];
  if (input.reviewedAt !== undefined) {
    dates.push(
      t.text('statement_reviewed', { date: t.date(requireDate('reviewedAt', input.reviewedAt)) }),
    );
  }
  blocks.push({ kind: 'paragraph', meta: true, content: [dates.join(' ')] });

  const title = t.text('statement_title', { site });
  const body = blocksToHtml(blocks);
  return {
    status,
    locale: t.locale,
    fallback: t.fallback,
    document: reportDocument({
      lang: t.locale,
      title,
      body: markup`<h1>${title}</h1>\n${body}`,
    }),
    fragment: body.toString(),
    text: blocksToText(title, blocks),
  };
}
