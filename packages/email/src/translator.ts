import en from '../messages/en.json' with { type: 'json' };
import type { Inline, Rich } from './document.ts';
import { directionOf, type Catalog, type Direction, type MessageParams } from './i18n.ts';
import type { SafeUrl } from './links.ts';

/** Every message id in the base catalog. */
export type MessageKey = Exclude<keyof typeof en, '$schema'>;

/** The language every email can fall back to; the base catalog holds every message. */
export const BASE_LOCALE = 'en';

/** The catalogs that ship. Adding a language: add `messages/<tag>.json` here and to project.inlang. */
export const SHIPPED_CATALOGS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  en,
};

/** A placeholder value rendered as a link. */
interface LinkParam {
  readonly text: string;
  readonly href: SafeUrl;
}

export type RichParams = Readonly<Record<string, string | number | LinkParam>>;

/** Formats copy for one email in one locale and time zone. */
export class Translator {
  readonly lang: string;
  readonly dir: Direction;
  readonly #catalog: Catalog;
  readonly #base: Catalog;
  readonly #timeZone: string;

  constructor(catalog: Catalog, base: Catalog, lang: string, timeZone: string) {
    this.#catalog = catalog;
    this.#base = base;
    this.lang = lang;
    this.dir = directionOf(lang);
    this.#timeZone = timeZone;
  }

  #source(key: MessageKey): Catalog {
    return this.#catalog.has(key) ? this.#catalog : this.#base;
  }

  /** A message as one string, for subjects, titles and labels. */
  text(key: MessageKey, params: MessageParams = {}): string {
    return this.#source(key)
      .formatParts(key, params, this.lang)
      .map((part) => part.text)
      .join('');
  }

  /**
   * A message as rich text: every placeholder value is isolated for direction, and a
   * placeholder given a {@link LinkParam} becomes a link.
   */
  rich(key: MessageKey, params: RichParams = {}): Rich {
    const flat: Record<string, string | number> = {};
    const links = new Map<string, SafeUrl>();
    for (const [name, value] of Object.entries(params)) {
      if (typeof value === 'object') {
        flat[name] = value.text;
        links.set(name, value.href);
      } else {
        flat[name] = value;
      }
    }
    return this.#source(key)
      .formatParts(key, flat, this.lang)
      .map((part): Inline => {
        if (!('variable' in part)) {
          return { text: part.text };
        }
        const href = links.get(part.variable);
        return href === undefined
          ? { text: part.text, isolate: true }
          : { text: part.text, href, isolate: true };
      });
  }

  number(value: number): string {
    return new Intl.NumberFormat(this.lang).format(value);
  }

  /** A calendar date, such as "October 17, 2026", in the email's time zone. */
  date(value: Date): string {
    return new Intl.DateTimeFormat(this.lang, {
      dateStyle: 'long',
      timeZone: this.#timeZone,
    }).format(value);
  }

  /** A date and time with its zone, such as "October 17, 2026 at 2:05 PM UTC". */
  dateTime(value: Date): string {
    return new Intl.DateTimeFormat(this.lang, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
      timeZone: this.#timeZone,
    }).format(value);
  }
}
