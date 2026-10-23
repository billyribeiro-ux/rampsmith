/**
 * `createEmailRenderer(settings).render(kind, input)`: validates the input, writes the copy in
 * the recipient's language, adds the footer and headers the email's category requires
 * (ADR-191), and returns the plain-text and HTML versions.
 */
import { inspect } from 'node:util';
import type { EmailDocument, Footer, FooterLink } from './document.ts';
import { Catalog, resolveLocale } from './i18n.ts';
import { EMAIL_KINDS, isEmailKind, TEMPLATES, type EmailInput, type EmailKind } from './kinds.ts';
import { mailtoLink, type SafeUrl } from './links.ts';
import { renderHtml } from './render-html.ts';
import { renderText } from './render-text.ts';
import { singleLine } from './sanitize.ts';
import { InputError, type Schema } from './schema.ts';
import { resolveSettings, type EmailSettings } from './settings.ts';
import {
  isSubscribed,
  type Category,
  type CommonOutput,
  type Content,
  type TemplateEnv,
} from './template.ts';
import { BASE_LOCALE, SHIPPED_CATALOGS, Translator } from './translator.ts';

/**
 * Shown in marketing email, where the law requires the postal address, until the founder sets
 * it (LAUNCH.md C, row 7). Other categories leave the address out until then (ADR-191).
 */
export const POSTAL_ADDRESS_PLACEHOLDER = '[Postal address not set: EMAIL_POSTAL_ADDRESS]';

/**
 * Why a rendered email must not be sent yet. `guardSender` refuses any email with a problem.
 * - `postal-address-missing`: a marketing email needs the postal address and none is set.
 * - `unsubscribe-not-https`: RFC 8058 needs an HTTPS unsubscribe link (local development).
 */
export type SendProblem = 'postal-address-missing' | 'unsubscribe-not-https';

const CONSTRUCT = Symbol('RenderedEmail');

interface RenderedFields {
  readonly kind: EmailKind;
  readonly category: Category;
  readonly lang: string;
  readonly subject: string;
  readonly preheader: string;
  readonly text: string;
  readonly html: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly problems: readonly SendProblem[];
}

/**
 * A rendered email. Its bodies and headers may hold a sign-in token or an unsubscribe link,
 * and its subject may hold a store name, so logging it (`JSON.stringify`, `util.inspect`,
 * pino) shows only the kind, category, language, problems and sizes. Those fields are also
 * non-enumerable, so spreading or `Object.entries` does not copy them by accident.
 */
export class RenderedEmail implements RenderedFields {
  readonly #rendered = true;
  readonly kind: EmailKind;
  readonly category: Category;
  readonly lang: string;
  declare readonly subject: string;
  declare readonly preheader: string;
  declare readonly text: string;
  declare readonly html: string;
  declare readonly headers: Readonly<Record<string, string>>;
  readonly problems: readonly SendProblem[];

  constructor(token: symbol, fields: RenderedFields) {
    if (token !== CONSTRUCT) {
      throw new TypeError('RenderedEmail is created by render() only');
    }
    this.kind = fields.kind;
    this.category = fields.category;
    this.lang = fields.lang;
    const hidden = (value: unknown): PropertyDescriptor => ({ value, enumerable: false });
    Object.defineProperties(this, {
      subject: hidden(fields.subject),
      preheader: hidden(fields.preheader),
      text: hidden(fields.text),
      html: hidden(fields.html),
      headers: hidden(Object.freeze({ ...fields.headers })),
    });
    this.problems = Object.freeze([...fields.problems]);
    Object.freeze(this);
  }

  /** Whether `value` came from `render`, so a sender never sends hand-built content. */
  static isRendered(value: unknown): value is RenderedEmail {
    return typeof value === 'object' && value !== null && #rendered in value;
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return {
      kind: this.kind,
      category: this.category,
      lang: this.lang,
      problems: this.problems,
      headerNames: Object.keys(this.headers),
      textLength: this.text.length,
      htmlLength: this.html.length,
    };
  }

  [inspect.custom](): Readonly<Record<string, unknown>> {
    return this.toJSON();
  }
}

/** Catalog JSON by locale tag, for adding languages or testing with a pseudo-locale. */
export type CatalogSources = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

export interface RendererOptions {
  /** Catalogs to use instead of the shipped ones; must include the base locale, `en`. */
  readonly catalogs?: CatalogSources;
}

export interface EmailRenderer {
  /** Renders one email. Throws {@link InputError} when the input does not validate. */
  render<K extends EmailKind>(kind: K, input: EmailInput<K>): RenderedEmail;
  /** The same, for a kind and input read from JSON, such as an `email.send` job payload. */
  renderUnknown(kind: string, input: unknown): RenderedEmail;
}

/** The view of a template `render` needs once the kind is known at runtime. */
interface AnyTemplate {
  readonly category: Category;
  readonly schema: Schema<unknown, CommonOutput>;
  build(input: CommonOutput, t: Translator, env: TemplateEnv): Content;
}

/**
 * Creates a renderer for one deployment. Settings and catalogs are checked here, so a bad
 * address or a broken translation fails at startup, not when an email is due.
 */
export function createEmailRenderer(
  settings: EmailSettings,
  options: RendererOptions = {},
): EmailRenderer {
  const resolved = resolveSettings(settings);
  const catalogs = new Map(
    Object.entries(options.catalogs ?? SHIPPED_CATALOGS).map(([locale, json]) => [
      locale,
      new Catalog(locale, json),
    ]),
  );
  const maybeBase = catalogs.get(BASE_LOCALE);
  if (maybeBase === undefined) {
    throw new TypeError(`the catalogs must include the base locale "${BASE_LOCALE}"`);
  }
  const base: Catalog = maybeBase;
  const available = new Set(catalogs.keys());
  const supportHref: SafeUrl = mailtoLink(resolved.supportAddress);
  const env: TemplateEnv = { support: { text: resolved.supportAddress, href: supportHref } };
  const ctx = { origins: resolved.origins };

  function renderUnknown(kind: string, input: unknown): RenderedEmail {
    if (!isEmailKind(kind)) {
      throw new InputError('kind', `must be one of: ${EMAIL_KINDS.join(', ')}`);
    }
    // Each entry of TEMPLATES pairs a schema with a build function for that schema's output,
    // so the parsed value always fits the build function of the same entry.
    const template = TEMPLATES[kind] as unknown as AnyTemplate;
    const parsed = template.schema.parse(input, 'input', ctx);
    const locale = resolveLocale(parsed.locale, available, BASE_LOCALE);
    const t = new Translator(
      catalogs.get(locale.catalog) ?? base,
      base,
      locale.tag,
      parsed.timeZone ?? 'UTC',
    );
    const content = template.build(parsed, t, env);
    const subscribed = isSubscribed(template.category);
    if (subscribed !== (content.subscription !== undefined)) {
      throw new TypeError(`${kind}: subscription links must be given exactly for subscribed kinds`);
    }

    const links: FooterLink[] = [];
    const headers: Record<string, string> = {};
    const problems: SendProblem[] = [];
    if (content.subscription !== undefined) {
      const { unsubscribe, preferences, oneClick } = content.subscription;
      const postTo = oneClick ?? unsubscribe;
      if (preferences !== undefined) {
        links.push({ label: t.text('footer_preferences'), href: preferences });
      }
      links.push({
        label: t.text(
          template.category === 'marketing'
            ? 'footer_unsubscribe_marketing'
            : 'footer_unsubscribe_notification',
        ),
        href: unsubscribe,
      });
      headers['List-Unsubscribe'] = `<${postTo}>`;
      headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
      if (!postTo.startsWith('https://') || !unsubscribe.startsWith('https://')) {
        problems.push('unsubscribe-not-https');
      }
    }

    // CAN-SPAM and CASL require the postal address in commercial messages only, so a missing
    // address blocks marketing email and never a security notice or a data-deletion notice.
    let sender: string[] | null = null;
    if (template.category !== 'security') {
      sender = [t.text('footer_sender_name')];
      if (resolved.postalAddress !== null) {
        sender.push(...resolved.postalAddress.split('\n'));
      } else if (template.category === 'marketing') {
        sender.push(POSTAL_ADDRESS_PLACEHOLDER);
        problems.push('postal-address-missing');
      }
    }

    const footer: Footer = {
      reason: content.reason,
      links,
      support: t.rich('footer_support', { address: env.support }),
      sender,
    };
    const doc: EmailDocument = {
      lang: t.lang,
      dir: t.dir,
      subject: singleLine(content.subject),
      preheader: singleLine(content.preheader),
      brand: t.text('brand_name'),
      title: singleLine(content.title),
      blocks: content.blocks,
      footer,
    };
    return new RenderedEmail(CONSTRUCT, {
      kind,
      category: template.category,
      lang: doc.lang,
      subject: doc.subject,
      preheader: doc.preheader,
      text: renderText(doc),
      html: renderHtml(doc),
      headers,
      problems,
    });
  }

  return {
    render: (kind, input) => renderUnknown(kind, input),
    renderUnknown,
  };
}
