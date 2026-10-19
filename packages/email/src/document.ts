/**
 * The structured form every template produces. Both renderers read it, so the plain-text and
 * HTML versions of an email always say the same thing, and escaping happens in one place.
 */
import type { Direction } from './i18n.ts';
import type { SafeUrl } from './links.ts';

/**
 * A run of text. `isolate` marks a value that came from an input (a store or agency name), so
 * the HTML renderer isolates its direction; `href` makes the run a link.
 */
export interface Inline {
  readonly text: string;
  readonly href?: SafeUrl;
  readonly isolate?: boolean;
}

export type Rich = readonly Inline[];

export type Block =
  /** A paragraph of copy. */
  | { readonly type: 'paragraph'; readonly content: Rich }
  /** A section heading under the email's title. */
  | { readonly type: 'heading'; readonly content: Rich }
  /** A bulleted list. */
  | { readonly type: 'list'; readonly items: readonly Rich[] }
  /** Label and value pairs, rendered as a table with row headers. */
  | {
      readonly type: 'facts';
      readonly rows: readonly { readonly label: Rich; readonly value: Rich }[];
    }
  /**
   * The email's main link, drawn as a button. With `fallback`, the address follows in full
   * for readers whose client breaks the button or who open it in another browser.
   */
  | {
      readonly type: 'action';
      readonly label: string;
      readonly href: SafeUrl;
      readonly fallback: Rich | null;
    }
  /** A one-time code to type somewhere else, shown large in monospace. */
  | { readonly type: 'code'; readonly label: Rich; readonly code: string }
  /** A boxed aside, such as the automated-checks disclaimer. */
  | { readonly type: 'note'; readonly paragraphs: readonly Rich[] }
  /** Paragraphs an operator wrote; blank lines separate paragraphs, line breaks are kept. */
  | { readonly type: 'prose'; readonly text: string };

export interface FooterLink {
  readonly label: string;
  readonly href: SafeUrl;
}

export interface Footer {
  /** Why the recipient got this email (CAN-SPAM, GDPR transparency). */
  readonly reason: Rich;
  /** Preference and unsubscribe links, where the email type has them. */
  readonly links: readonly FooterLink[];
  /** How to reach support. */
  readonly support: Rich;
  /** The sender's name and postal address lines, where the email type carries them. */
  readonly sender: readonly string[] | null;
}

export interface EmailDocument {
  readonly lang: string;
  readonly dir: Direction;
  readonly subject: string;
  readonly preheader: string;
  readonly brand: string;
  readonly title: string;
  readonly blocks: readonly Block[];
  readonly footer: Footer;
}

/** Plain text of a rich run, links included as their text. */
export function plain(content: Rich): string {
  return content.map((part) => part.text).join('');
}
