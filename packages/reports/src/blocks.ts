// A small document model that renders to both HTML and plain text, so the accessibility
// statement's two formats always say the same thing (ADR-222). Links exist only as `Link`
// values built from validated input, so no `href` can carry a script or a local file.
import { mailtoHref, safeWebUrl, sanitizeText, telHref } from './escape.ts';
import { markup, join, type Html } from './html.ts';

const KEY = Symbol('Link');

export class Link {
  readonly href: string;
  readonly label: string;

  constructor(key: symbol, href: string, label: string) {
    if (key !== KEY) {
      throw new TypeError('links are created only by webLink, emailLink and phoneLink');
    }
    this.href = href;
    this.label = sanitizeText(label);
  }
}

/** A link to an absolute https or http URL; `undefined` for anything else. */
export function webLink(url: string, label?: string): Link | undefined {
  const href = safeWebUrl(url);
  return href === undefined ? undefined : new Link(KEY, href, label ?? href);
}

export function emailLink(email: string): Link | undefined {
  const href = mailtoHref(email);
  return href === undefined ? undefined : new Link(KEY, href, email);
}

export function phoneLink(phone: string): Link | undefined {
  const href = telHref(phone);
  return href === undefined ? undefined : new Link(KEY, href, phone);
}

export type Inline = string | Link;

export type Block =
  | { readonly kind: 'heading'; readonly level: 2 | 3; readonly content: readonly Inline[] }
  | { readonly kind: 'paragraph'; readonly content: readonly Inline[]; readonly meta?: boolean }
  | { readonly kind: 'list'; readonly items: readonly (readonly Inline[])[] }
  /** Markup with no plain-text form of its own, such as a chart; `text` stands in for it. */
  | { readonly kind: 'markup'; readonly html: Html; readonly text: string };

function inlineHtml(content: readonly Inline[]): Html {
  return join(
    content.map((part) =>
      part instanceof Link ? markup`<a href="${part.href}">${part.label}</a>` : markup`${part}`,
    ),
  );
}

function inlineText(content: readonly Inline[]): string {
  return content
    .map((part) => {
      if (!(part instanceof Link)) return sanitizeText(part);
      // An email address or phone number is its own label; a web link shows its URL.
      return /^(?:mailto|tel):/u.test(part.href) || part.label === part.href
        ? part.label
        : `${part.label} (${part.href})`;
    })
    .join('');
}

export function blocksToHtml(blocks: readonly Block[]): Html {
  return join(
    blocks.map((block) => {
      switch (block.kind) {
        case 'heading':
          return block.level === 2
            ? markup`<h2>${inlineHtml(block.content)}</h2>\n`
            : markup`<h3>${inlineHtml(block.content)}</h3>\n`;
        case 'paragraph':
          return block.meta === true
            ? markup`<p class="meta">${inlineHtml(block.content)}</p>\n`
            : markup`<p>${inlineHtml(block.content)}</p>\n`;
        case 'list':
          return markup`<ul>\n${block.items.map((item) => markup`<li>${inlineHtml(item)}</li>\n`)}</ul>\n`;
        case 'markup':
          return markup`${block.html}\n`;
      }
    }),
  );
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** How many user-perceived characters a line has, for underlining it. */
function width(line: string): number {
  return Array.from(graphemes.segment(line)).length;
}

/**
 * Plain text: headings underlined, a blank line between blocks, list items as "- ".
 * Lines are not wrapped, so email clients and editors can wrap them to their own width.
 */
export function blocksToText(title: string, blocks: readonly Block[]): string {
  const out: string[] = [title, '='.repeat(Math.max(3, width(title)))];
  for (const block of blocks) {
    out.push('');
    switch (block.kind) {
      case 'heading': {
        const line = inlineText(block.content);
        out.push(line, (block.level === 2 ? '-' : '~').repeat(Math.max(3, width(line))));
        break;
      }
      case 'paragraph':
        out.push(inlineText(block.content));
        break;
      case 'list':
        out.push(...block.items.map((item) => `- ${inlineText(item).replaceAll('\n', '\n  ')}`));
        break;
      case 'markup':
        out.push(sanitizeText(block.text));
        break;
    }
  }
  return `${out.join('\n')}\n`;
}
