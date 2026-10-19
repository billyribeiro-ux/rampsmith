/** Helpers shared by the test files. */
import { createEmailRenderer, type EmailRenderer, type RenderedEmail } from '../src/index.ts';
import { allFixtures, SETTINGS } from './fixtures.ts';

export const renderer: EmailRenderer = createEmailRenderer(SETTINGS);

export interface RenderedFixture {
  readonly kind: string;
  readonly name: string;
  readonly input: unknown;
  readonly email: RenderedEmail;
}

/** Every fixture rendered with the test settings. */
export function renderAll(r: EmailRenderer = renderer): RenderedFixture[] {
  return allFixtures().map(([kind, name, input]) => ({
    kind,
    name,
    input,
    email: r.renderUnknown(kind, input),
  }));
}

const ENTITIES: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#39);/gu, (entity) => ENTITIES[entity] ?? entity);
}

/** The text a reader sees in the HTML body: no head, no hidden preview text, no tags. */
export function visibleHtmlText(html: string): string {
  const body = html
    .replace(/<head>[\s\S]*?<\/head>/u, '')
    .replace(/<div style="display:none[^"]*">[\s\S]*?<\/div>/u, '')
    .replace(/<!--[\s\S]*?-->/gu, '')
    .replace(/<br>/gu, ' ')
    .replace(/<[^>]+>/gu, ' ');
  return decodeEntities(body).replace(/\s+/gu, ' ').trim();
}

/** Every `href` value in the HTML, decoded. */
export function hrefs(html: string): string[] {
  return [...html.matchAll(/\shref="([^"]*)"/gu)].map((m) => decodeEntities(m[1] ?? ''));
}

interface Tag {
  readonly name: string;
  readonly closing: boolean;
  readonly attributes: ReadonlyMap<string, string>;
}

const TAG = /<(\/?)([a-z][a-z0-9]*)((?: [a-z][a-z-]*="[^"<>]*")*)>/gu;
const ATTRIBUTE = / ([a-z][a-z-]*)="([^"<>]*)"/gu;

/**
 * Splits the HTML into tags and text, and throws when anything is neither: an unquoted or
 * malformed attribute, a stray "<", ">" or quote in text. The renderer escapes every input, so
 * text between tags can never hold those characters.
 */
function tokenize(html: string): { tags: Tag[]; text: string[] } {
  const body = html.replace(/^<!doctype html>\n/u, '').replace(/<!--[\s\S]*?-->/gu, '');
  const tags: Tag[] = [];
  const text: string[] = [];
  let last = 0;
  for (const match of body.matchAll(TAG)) {
    text.push(body.slice(last, match.index));
    const attributes = new Map<string, string>();
    for (const attr of (match[3] ?? '').matchAll(ATTRIBUTE)) {
      attributes.set(attr[1] ?? '', decodeEntities(attr[2] ?? ''));
    }
    tags.push({ name: match[2] ?? '', closing: match[1] === '/', attributes });
    last = match.index + match[0].length;
  }
  text.push(body.slice(last));
  for (const segment of text) {
    if (/[<>"]/u.test(segment)) {
      throw new Error(`markup outside a well-formed tag: ${segment.slice(0, 80)}`);
    }
  }
  return { tags, text };
}

/** Tag names used in the HTML. */
export function tagNames(html: string): Set<string> {
  return new Set(tokenize(html).tags.map((t) => t.name));
}

/** Attribute names used in the HTML. */
export function attributeNames(html: string): Set<string> {
  return new Set(tokenize(html).tags.flatMap((t) => [...t.attributes.keys()]));
}
