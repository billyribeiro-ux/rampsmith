/**
 * Notifications about one store: welcome after install, scan results, regressions and shopper
 * barrier reports (PLAN §5, §14, §19). Each is a `notification`: the recipient can switch it
 * off, and it links to the embedded app in the merchant's Shopify admin.
 */
import {
  count,
  criterion,
  instant,
  int,
  label,
  link,
  list,
  object,
  oneOf,
  optional,
} from '../schema.ts';
import {
  action,
  automatedChecksNote,
  bullets,
  checks,
  checksRow,
  COMMON,
  defineTemplate,
  facts,
  heading,
  IMPACT_LEVELS,
  impactLabel,
  impactRows,
  impacts,
  msg,
  paragraph,
  SUBSCRIPTION,
  value,
} from '../template.ts';

/** Store names in Shopify can be long; emails show at most this many characters. */
export const STORE_NAME_MAX = 100;

/** A link into Rampsmith: the embedded app in Shopify admin, or the standalone dashboard. */
function appLink() {
  return link(['shopifyAdmin', 'app']);
}

export const welcome = defineTemplate({
  category: 'notification',
  schema: object({
    ...COMMON,
    ...SUBSCRIPTION,
    storeName: label(STORE_NAME_MAX),
    appUrl: appLink(),
  }),
  build(input, t) {
    const store = input.storeName;
    return {
      subject: t.text('welcome_subject'),
      preheader: t.text('welcome_preheader', { store }),
      title: t.text('welcome_title'),
      blocks: [
        paragraph(msg(t, 'welcome_intro', { store })),
        heading(msg(t, 'welcome_next_heading')),
        bullets([
          msg(t, 'welcome_next_scan'),
          msg(t, 'welcome_next_results'),
          msg(t, 'welcome_next_approval'),
        ]),
        action(t, t.text('common_open_rampsmith'), input.appUrl, false),
        automatedChecksNote(t),
      ],
      reason: msg(t, 'common_reason_store', { store }),
      subscription: {
        unsubscribe: input.unsubscribeUrl,
        preferences: input.preferencesUrl,
        oneClick: input.oneClickUrl,
      },
    };
  },
});

export const firstScanComplete = defineTemplate({
  category: 'notification',
  schema: object({
    ...COMMON,
    ...SUBSCRIPTION,
    storeName: label(STORE_NAME_MAX),
    completedAt: instant(),
    pagesChecked: int(1, 100_000),
    checks: checks(),
    issues: impacts(),
    /** Proposed fixes waiting for approval. */
    fixesReady: count(),
    findingsUrl: appLink(),
  }),
  build(input, t) {
    const store = input.storeName;
    return {
      subject: t.text('first_scan_subject', { store }),
      preheader: t.text('first_scan_preheader', {
        store,
        passed: input.checks.passed,
        total: input.checks.total,
      }),
      title: t.text('first_scan_title'),
      blocks: [
        paragraph(
          msg(t, 'first_scan_intro', {
            store,
            date: t.date(input.completedAt),
            pages: input.pagesChecked,
          }),
        ),
        heading(msg(t, 'common_summary_heading')),
        facts([checksRow(t, input.checks)]),
        heading(msg(t, 'common_issues_by_impact_heading')),
        facts(impactRows(t, input.issues)),
        paragraph(msg(t, 'first_scan_fixes_ready', { count: input.fixesReady })),
        action(t, t.text('first_scan_button'), input.findingsUrl, false),
        automatedChecksNote(t),
      ],
      reason: msg(t, 'common_reason_store', { store }),
      subscription: {
        unsubscribe: input.unsubscribeUrl,
        preferences: input.preferencesUrl,
        oneClick: input.oneClickUrl,
      },
    };
  },
});

export const weeklySummary = defineTemplate({
  category: 'notification',
  schema: object({
    ...COMMON,
    ...SUBSCRIPTION,
    storeName: label(STORE_NAME_MAX),
    /** The end of the week summarised. */
    periodEnd: instant(),
    checks: checks(),
    /** Last week's result, when there was one. */
    previousChecks: optional(checks()),
    newIssues: count(),
    resolvedIssues: count(),
    openIssues: impacts(),
    fixesAwaitingApproval: count(),
    nextScanAt: instant(),
    dashboardUrl: appLink(),
  }),
  build(input, t) {
    const store = input.storeName;
    const rows = [checksRow(t, input.checks)];
    if (input.previousChecks !== undefined) {
      rows.push({
        label: msg(t, 'weekly_previous_label'),
        value: msg(t, 'common_checks_value', {
          passed: input.previousChecks.passed,
          total: input.previousChecks.total,
        }),
      });
    }
    rows.push(
      { label: msg(t, 'weekly_new_label'), value: value(t.number(input.newIssues)) },
      { label: msg(t, 'weekly_resolved_label'), value: value(t.number(input.resolvedIssues)) },
      {
        label: msg(t, 'weekly_awaiting_label'),
        value: value(t.number(input.fixesAwaitingApproval)),
      },
      { label: msg(t, 'weekly_next_scan_label'), value: value(t.date(input.nextScanAt)) },
    );
    return {
      subject: t.text('weekly_subject', { store }),
      preheader: t.text('weekly_preheader', {
        store,
        passed: input.checks.passed,
        total: input.checks.total,
      }),
      title: t.text('weekly_title'),
      blocks: [
        paragraph(msg(t, 'weekly_intro', { store, date: t.date(input.periodEnd) })),
        heading(msg(t, 'common_summary_heading')),
        facts(rows),
        heading(msg(t, 'weekly_open_heading')),
        facts(impactRows(t, input.openIssues)),
        action(t, t.text('common_open_rampsmith'), input.dashboardUrl, false),
        automatedChecksNote(t),
      ],
      reason: msg(t, 'common_reason_store', { store }),
      subscription: {
        unsubscribe: input.unsubscribeUrl,
        preferences: input.preferencesUrl,
        oneClick: input.oneClickUrl,
      },
    };
  },
});

const CAUSES = ['theme_published', 'code_merged', 'product_updated', 'unknown'] as const;

export const regressionAlert = defineTemplate({
  category: 'notification',
  schema: object({
    ...COMMON,
    ...SUBSCRIPTION,
    storeName: label(STORE_NAME_MAX),
    detectedAt: instant(),
    /** The new failures, most severe first; the rest are counted in `moreIssues`. */
    issues: list(
      object({ title: label(120), criterion: criterion(), impact: oneOf(IMPACT_LEVELS) }),
      { min: 1, max: 10 },
    ),
    moreIssues: count(),
    cause: oneOf(CAUSES),
    /** The theme name or short commit hash the cause names. */
    causeLabel: optional(label(80)),
    findingsUrl: appLink(),
  }),
  build(input, t) {
    const store = input.storeName;
    const total = input.issues.length + input.moreIssues;
    const causeLabel = input.causeLabel ?? '';
    const cause =
      input.cause === 'theme_published' && causeLabel !== ''
        ? msg(t, 'regression_cause_theme', { theme: causeLabel })
        : input.cause === 'code_merged' && causeLabel !== ''
          ? msg(t, 'regression_cause_commit', { commit: causeLabel })
          : input.cause === 'product_updated'
            ? msg(t, 'regression_cause_product')
            : msg(t, 'regression_cause_unknown');
    const blocks = [
      paragraph(
        msg(t, 'regression_intro', { store, date: t.date(input.detectedAt), count: total }),
      ),
      paragraph(cause),
      heading(msg(t, 'regression_list_heading')),
      bullets(
        input.issues.map((issue) =>
          msg(t, 'common_issue_item', {
            title: issue.title,
            criterion: issue.criterion,
            impact: impactLabel(t, issue.impact),
          }),
        ),
      ),
    ];
    if (input.moreIssues > 0) {
      blocks.push(paragraph(msg(t, 'common_more_items', { count: input.moreIssues })));
    }
    blocks.push(action(t, t.text('regression_button'), input.findingsUrl, false));
    return {
      subject: t.text('regression_subject', { store, count: total }),
      preheader: t.text('regression_preheader'),
      title: t.text('regression_title'),
      blocks,
      reason: msg(t, 'common_reason_store', { store }),
      subscription: {
        unsubscribe: input.unsubscribeUrl,
        preferences: input.preferencesUrl,
        oneClick: input.oneClickUrl,
      },
    };
  },
});

/**
 * A shopper used the storefront form (PLAN §14, §19). The report itself stays in Rampsmith:
 * the email carries neither the shopper's message nor their contact details.
 */
export const barrierReportReceived = defineTemplate({
  category: 'notification',
  schema: object({
    ...COMMON,
    ...SUBSCRIPTION,
    storeName: label(STORE_NAME_MAX),
    receivedAt: instant(),
    reportsUrl: appLink(),
  }),
  build(input, t) {
    const store = input.storeName;
    return {
      subject: t.text('barrier_subject', { store }),
      preheader: t.text('barrier_preheader'),
      title: t.text('barrier_title'),
      blocks: [
        paragraph(msg(t, 'barrier_intro', { store, date: t.date(input.receivedAt) })),
        paragraph(msg(t, 'barrier_privacy')),
        action(t, t.text('barrier_button'), input.reportsUrl, false),
      ],
      reason: msg(t, 'common_reason_store', { store }),
      subscription: {
        unsubscribe: input.unsubscribeUrl,
        preferences: input.preferencesUrl,
        oneClick: input.oneClickUrl,
      },
    };
  },
});
