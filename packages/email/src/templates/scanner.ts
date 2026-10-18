/**
 * The free scanner's two emails (PLAN §16): the double opt-in confirmation, then the full
 * report. Anyone can type any address into the form, so the confirmation carries nothing the
 * requester chose, not even the scanned host (ADR-193): it cannot be used to put someone
 * else's words in a Rampsmith email. The report goes only to a confirmed address and names
 * the host in its ASCII form.
 */
import { hostname, instant, int, link, list, object, label, optional } from '../schema.ts';
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
  impactRows,
  impacts,
  msg,
  paragraph,
  value,
} from '../template.ts';

export const scannerConfirm = defineTemplate({
  category: 'security',
  schema: object({
    ...COMMON,
    /** The confirmation page, on the site origin; it asks for a click before confirming. */
    confirmUrl: link(['site']),
    expiresInHours: int(1, 168),
  }),
  build(input, t) {
    return {
      subject: t.text('scanner_confirm_subject'),
      preheader: t.text('scanner_confirm_preheader'),
      title: t.text('scanner_confirm_title'),
      blocks: [
        paragraph(msg(t, 'scanner_confirm_intro')),
        paragraph(msg(t, 'scanner_confirm_nothing_else')),
        action(t, t.text('scanner_confirm_button'), input.confirmUrl, true),
        paragraph(msg(t, 'common_link_expiry_hours', { hours: input.expiresInHours })),
        paragraph(msg(t, 'scanner_confirm_not_you')),
      ],
      reason: msg(t, 'scanner_confirm_reason'),
    };
  },
});

export const scannerReport = defineTemplate({
  category: 'marketing',
  schema: object({
    ...COMMON,
    scannedHost: hostname(),
    scannedAt: instant(),
    pagesChecked: int(1, 100),
    checks: checks(),
    issues: impacts(),
    /** The most frequent failure types, already in the recipient's language. */
    topIssues: list(object({ title: label(120), count: int(1, 1_000_000) }), { max: 10 }),
    /** The private, unlisted report page. */
    reportUrl: link(['site', 'app']),
    reportExpiresAt: instant(),
    /** Optional page explaining how Rampsmith fixes these issues. */
    learnMoreUrl: optional(link(['site'])),
    /** Stops every further email to this address (RFC 8058 one-click). */
    unsubscribeUrl: link(['site', 'app']),
  }),
  build(input, t) {
    const host = input.scannedHost;
    const blocks = [
      paragraph(
        msg(t, 'scanner_report_intro', {
          host,
          pages: input.pagesChecked,
          date: t.date(input.scannedAt),
        }),
      ),
      heading(msg(t, 'common_summary_heading')),
      facts([
        checksRow(t, input.checks),
        {
          label: msg(t, 'common_pages_checked_label'),
          value: value(t.number(input.pagesChecked)),
        },
      ]),
      heading(msg(t, 'common_issues_by_impact_heading')),
      facts(impactRows(t, input.issues)),
    ];
    if (input.topIssues.length > 0) {
      blocks.push(
        heading(msg(t, 'scanner_report_top_heading')),
        bullets(
          input.topIssues.map((issue) =>
            msg(t, 'scanner_report_top_item', { title: issue.title, count: issue.count }),
          ),
        ),
      );
    }
    blocks.push(
      action(t, t.text('scanner_report_button'), input.reportUrl, false),
      paragraph(msg(t, 'scanner_report_expiry', { date: t.date(input.reportExpiresAt) })),
    );
    if (input.learnMoreUrl !== undefined) {
      blocks.push(
        paragraph(
          msg(t, 'scanner_report_learn_more', {
            link: { text: t.text('scanner_report_learn_more_link'), href: input.learnMoreUrl },
          }),
        ),
      );
    }
    blocks.push(automatedChecksNote(t));
    return {
      subject: t.text('scanner_report_subject', { host }),
      preheader: t.text('scanner_report_preheader', {
        passed: input.checks.passed,
        total: input.checks.total,
      }),
      title: t.text('scanner_report_title', { host }),
      blocks,
      reason: msg(t, 'scanner_report_reason'),
      subscription: { unsubscribe: input.unsubscribeUrl },
    };
  },
});
