/**
 * What a template is, the fields every email shares, and the building blocks templates use.
 */
import type { Block, Rich } from './document.ts';
import type { SafeUrl } from './links.ts';
import {
  count,
  int,
  link,
  localeTag,
  object,
  optional,
  refine,
  timeZone,
  type OutputOf,
  type Schema,
} from './schema.ts';
import type { MessageKey, RichParams, Translator } from './translator.ts';

/**
 * Why an email is sent, which decides what its footer must carry (ADR-191):
 * - `security`: sign-in links, address confirmation, one-time codes. No unsubscribe (a person
 *   cannot opt out of signing in) and no postal address; says why it arrived.
 * - `transactional`: notices about the account, plan, data or security that the recipient
 *   cannot opt out of, such as a data-deletion confirmation. Postal address, no unsubscribe.
 * - `notification`: product notifications the recipient can switch off. Preferences and
 *   one-click unsubscribe (RFC 8058) plus the postal address.
 * - `marketing`: anything with promotional content. Unsubscribe and postal address required
 *   by CAN-SPAM, CASL and ePrivacy Article 13.
 */
export type Category = 'security' | 'transactional' | 'notification' | 'marketing';

export const CATEGORIES: readonly Category[] = [
  'security',
  'transactional',
  'notification',
  'marketing',
];

/** Categories whose emails carry unsubscribe links and headers. */
export function isSubscribed(category: Category): boolean {
  return category === 'notification' || category === 'marketing';
}

/** Values every template may read besides its input. */
export interface TemplateEnv {
  /** The support inbox as a link, for copy that names it. */
  readonly support: { readonly text: string; readonly href: SafeUrl };
}

export interface Content {
  readonly subject: string;
  readonly preheader: string;
  readonly title: string;
  readonly blocks: readonly Block[];
  /** Why the recipient got this email. */
  readonly reason: Rich;
  /** Required for `notification` and `marketing` emails. */
  readonly subscription?: {
    readonly unsubscribe: SafeUrl;
    readonly preferences?: SafeUrl;
    /** The address of the RFC 8058 POST in `List-Unsubscribe`; `unsubscribe` when absent. */
    readonly oneClick?: SafeUrl | undefined;
  };
}

/** Output every input schema shares (see {@link COMMON}). */
export interface CommonOutput {
  readonly locale?: string;
  readonly timeZone?: string;
}

export interface Template<S extends Schema<unknown, CommonOutput>> {
  readonly category: Category;
  readonly schema: S;
  build(input: OutputOf<S>, t: Translator, env: TemplateEnv): Content;
}

export function defineTemplate<S extends Schema<unknown, CommonOutput>>(
  template: Template<S>,
): Template<S> {
  return template;
}

/** Fields every email accepts: the recipient's language and time zone. */
export const COMMON = {
  /** BCP 47 tag; falls back to English when no catalog matches. */
  locale: optional(localeTag()),
  /** IANA zone for dates and times; UTC when absent. */
  timeZone: optional(timeZone()),
} as const;

/** Fields every subscribed (`notification`) email needs. */
export const SUBSCRIPTION = {
  /** One-click unsubscribe endpoint for this notification type (RFC 8058). */
  unsubscribeUrl: link(['app']),
  /** The recipient's email preferences page. */
  preferencesUrl: link(['app']),
  /** Where mail clients POST the one-click unsubscribe (RFC 8058); `unsubscribeUrl` when absent. */
  oneClickUrl: optional(link(['oneClick'])),
} as const;

/** Automated WCAG check totals; `passed` never exceeds `total`. */
export function checks() {
  return refine(
    object({ passed: count(), total: int(1, 1_000_000_000) }),
    (value) => value.passed <= value.total,
    'passed',
    'must not exceed total',
  );
}

/** Open issues by axe-core impact level. */
export function impacts() {
  return object({ critical: count(), serious: count(), moderate: count(), minor: count() });
}

export const IMPACT_LEVELS = ['critical', 'serious', 'moderate', 'minor'] as const;
export type Impact = (typeof IMPACT_LEVELS)[number];

const IMPACT_KEYS: Readonly<Record<Impact, MessageKey>> = {
  critical: 'impact_critical',
  serious: 'impact_serious',
  moderate: 'impact_moderate',
  minor: 'impact_minor',
};

export function impactLabel(t: Translator, impact: Impact): string {
  return t.text(IMPACT_KEYS[impact]);
}

// Building blocks ----------------------------------------------------------------------------

export function paragraph(content: Rich): Block {
  return { type: 'paragraph', content };
}

export function heading(content: Rich): Block {
  return { type: 'heading', content };
}

export function bullets(items: readonly Rich[]): Block {
  return { type: 'list', items };
}

export function facts(rows: readonly { readonly label: Rich; readonly value: Rich }[]): Block {
  return { type: 'facts', rows };
}

/** The main link. With `fallback`, the full address follows for clients that break buttons. */
export function action(t: Translator, label: string, href: SafeUrl, fallback: boolean): Block {
  return {
    type: 'action',
    label,
    href,
    fallback: fallback ? t.rich('common_button_fallback') : null,
  };
}

/** Plain text run for a message, for facts labels and list items. */
export function msg(t: Translator, key: MessageKey, params?: RichParams): Rich {
  return t.rich(key, params);
}

/** A text run that is a value, not copy (a number, a date). */
export function value(text: string): Rich {
  return [{ text, isolate: true }];
}

/** "Passes N of M automated WCAG 2.2 AA checks" as a facts row. */
export function checksRow(
  t: Translator,
  result: { readonly passed: number; readonly total: number },
): { readonly label: Rich; readonly value: Rich } {
  return {
    label: msg(t, 'common_checks_label'),
    value: msg(t, 'common_checks_value', { passed: result.passed, total: result.total }),
  };
}

/** Rows of open issues by impact. */
export function impactRows(
  t: Translator,
  counts: Readonly<Record<Impact, number>>,
): { readonly label: Rich; readonly value: Rich }[] {
  return IMPACT_LEVELS.map((impact) => ({
    label: [{ text: impactLabel(t, impact) }],
    value: value(t.number(counts[impact])),
  }));
}

/**
 * The disclaimer every scan result carries (PLAN §3): automated checks find only part of all
 * issues, with the axe-core figure.
 */
export function automatedChecksNote(t: Translator): Block {
  return {
    type: 'note',
    paragraphs: [msg(t, 'common_automated_note'), msg(t, 'common_automated_source')],
  };
}
