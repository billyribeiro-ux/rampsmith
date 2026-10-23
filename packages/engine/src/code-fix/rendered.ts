/**
 * The rendered element of a stored occurrence (ADR-296). The scanner keeps the failing node's
 * scrubbed HTML excerpt and the id of the section wrapper it sat in; the source mapper needs the
 * element's tag, attributes and text and the wrapper above it. This rebuilds exactly that, and
 * nothing it was not given: an excerpt cut short in its start tag yields no element, and the
 * text of an element whose closing tag was cut off is left empty rather than guessed.
 *
 * The excerpt is a stranger's page content. It is only read here, never written anywhere.
 */
import type { RenderedElement, RenderedNode } from '@rampsmith/liquid-patch';

const START_TAG =
  /^\s*<([a-z][a-z0-9-]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/iu;
const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu;

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decode(text: string): string {
  return text.replaceAll(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,6});/giu, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code =
        body[1]?.toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      return Number.isInteger(code) &&
        code > 0 &&
        code <= 0x10ffff &&
        !(code >= 0xd800 && code < 0xe000)
        ? String.fromCodePoint(code)
        : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Elements that never have content or a closing tag. */
const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
]);

/**
 * The ancestors the scanner stored, nearest first, up to the section wrapper. Occurrences stored
 * before the scanner kept them have only the wrapper's id: one stand-in `div` with that id, which
 * is enough to find the section but not to tell elements of one file apart by their parents.
 */
function ancestorsFrom(stored: unknown, sectionId: string | null): RenderedNode[] {
  if (Array.isArray(stored)) {
    const nodes: RenderedNode[] = [];
    for (const item of stored as unknown[]) {
      if (typeof item !== 'object' || item === null) continue;
      const { tag, attributes } = item as { tag?: unknown; attributes?: unknown };
      if (typeof tag !== 'string' || typeof attributes !== 'object' || attributes === null)
        continue;
      const clean: Record<string, string> = {};
      for (const [name, value] of Object.entries(attributes)) {
        if (typeof value === 'string') clean[name] = value;
      }
      nodes.push({ tag, attributes: clean });
    }
    if (nodes.length > 0) return nodes;
  }
  return sectionId === null
    ? []
    : [{ tag: 'div', attributes: { id: sectionId, class: 'shopify-section' } }];
}

/**
 * The element an occurrence describes, or `null` when its excerpt does not start with a
 * complete start tag.
 */
export function renderedElementOf(
  excerpt: string,
  sectionId: string | null,
  ancestors?: unknown,
): RenderedElement | null {
  const match = START_TAG.exec(excerpt);
  if (match === null) return null;
  const tag = (match[1] ?? '').toLowerCase();
  const attributes: Record<string, string> = {};
  for (const attr of (match[2] ?? '').matchAll(ATTRIBUTE)) {
    const name = (attr[1] ?? '').toLowerCase();
    if (name === '' || Object.hasOwn(attributes, name)) continue;
    attributes[name] = decode(attr[2] ?? attr[3] ?? attr[4] ?? '');
  }
  let text = '';
  if (!VOID.has(tag)) {
    const rest = excerpt.slice(match[0].length);
    const close = rest.toLowerCase().lastIndexOf(`</${tag}`);
    if (close !== -1) {
      text = decode(rest.slice(0, close).replaceAll(/<[^>]*>/gu, ' '))
        .replaceAll(/\s+/gu, ' ')
        .trim();
    }
  }
  return { tag, attributes, text, ancestors: ancestorsFrom(ancestors, sectionId) };
}
