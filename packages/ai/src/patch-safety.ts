/**
 * The allowlist an AI-proposed patch must stay inside (PLAN §12; ADR-213; security audit
 * HIGH-1). Instead of looking for dangerous spellings in the edit text, the whole span is
 * compared before and after the edits: Liquid is masked out and checked construct by
 * construct against an allowlist, the masked HTML is parsed (parse5) and compared element by
 * element, and visible text must not change. Entities, case tricks, split tokens and filters
 * that build markup cannot get past a comparison of what the browser would actually see.
 *
 * What a patch may do: add, change or remove ARIA attributes (`aria-*`), `role`, `tabindex`
 * (-1 or 0), `hidden`, `id`, `for`, `lang`, `alt` and a button's `type`; add a `span` with the
 * class `visually-hidden` or `sr-only`; add Liquid output that is a translation key
 * (`{{ 'key' | t }}`), an id (`{{ block.id }}`, `{{ forloop.index }}`) or an escaped variable
 * (`{{ product.title | escape }}`); and add `if`, `elsif`, `else`, `endif`, `unless` and
 * `endunless` tags with plain conditions. Nothing else.
 */
import { createHash, randomBytes } from 'node:crypto';
import { ErrorCodes, parseFragment, type DefaultTreeAdapterTypes } from 'parse5';
import { containsInvisible } from './untrusted.ts';

type Node = DefaultTreeAdapterTypes.ChildNode;
type Element = DefaultTreeAdapterTypes.Element;

const ALLOWED_LIQUID: readonly RegExp[] = [
  /^\{\{-?\s*'[A-Za-z0-9_.-]{1,100}'\s*\|\s*t\s*-?\}\}$/u,
  /^\{\{-?\s*[a-z_][a-z0-9_]*(?:\.[a-z0-9_]+){0,4}\s*\|\s*escape\s*-?\}\}$/u,
  /^\{\{-?\s*(?:[a-z_][a-z0-9_]*\.){1,3}id\s*-?\}\}$/u,
  /^\{\{-?\s*forloop\.index0?\s*-?\}\}$/u,
  /^\{%-?\s*(?:if|elsif|unless)\s+[a-z0-9_.\s'"=!<>-]{1,200}?-?%\}$/u,
  /^\{%-?\s*(?:else|endif|endunless)\s*-?%\}$/u,
];

const ALLOWED_ATTRIBUTE = /^(?:aria-[a-z]+|role|tabindex|hidden|id|for|lang|alt|type)$/u;
const SPAN_CLASSES = new Set(['visually-hidden', 'sr-only', 'visually-hidden--inline']);

function normalizeLiquid(construct: string): string {
  return construct.replace(/\s+/gu, ' ');
}

export function isAllowedLiquid(construct: string): boolean {
  const normalized = normalizeLiquid(construct);
  return ALLOWED_LIQUID.some((pattern) => pattern.test(normalized));
}

interface Masked {
  readonly html: string;
  readonly constructs: readonly string[];
}

/**
 * Replaces every Liquid construct with a space-padded placeholder, in one linear pass.
 * Returns `null` for an unterminated construct.
 */
function maskLiquid(text: string, token: string): Masked | null {
  const constructs: string[] = [];
  let html = '';
  let at = 0;
  for (;;) {
    const output = text.indexOf('{{', at);
    const tag = text.indexOf('{%', at);
    const start = output === -1 ? tag : tag === -1 ? output : Math.min(output, tag);
    if (start === -1) {
      return { html: html + text.slice(at), constructs };
    }
    const close = text.startsWith('{{', start) ? '}}' : '%}';
    const end = text.indexOf(close, start + 2);
    if (end === -1) {
      return null;
    }
    const construct = text.slice(start, end + 2);
    constructs.push(construct);
    // Named by content, not position, so an unchanged construct keeps its placeholder.
    const id = createHash('sha256').update(normalizeLiquid(construct)).digest('hex').slice(0, 12);
    html += `${text.slice(at, start)} ${token}${id}x `;
    at = end + 2;
  }
}

/**
 * Parse errors by code. A duplicate of an allowlisted attribute (an ARIA state set in both
 * branches of an `if`) is expected and not counted; any other duplicate is, because the parser
 * keeps only the first copy and the second would escape the attribute check.
 */
function errorCounts(html: string): Map<string, number> {
  const counts = new Map<string, number>();
  parseFragment(html, {
    sourceCodeLocationInfo: true,
    onParseError: (error) => {
      if (error.code === ErrorCodes.duplicateAttribute) {
        // parse5 reports the duplicate at the end of its name.
        const before = html.slice(Math.max(0, error.startOffset - 128), error.startOffset);
        const name = /[^\s"'<>/=]+$/u.exec(before)?.[0].toLowerCase() ?? '';
        if (ALLOWED_ATTRIBUTE.test(name)) {
          return;
        }
      }
      counts.set(error.code, (counts.get(error.code) ?? 0) + 1);
    },
  });
  return counts;
}

function elements(html: string): Element[] {
  const out: Element[] = [];
  const stack: Node[] = [...parseFragment(html).childNodes].reverse();
  while (stack.length > 0) {
    const node = stack.pop();
    if (node !== undefined && 'tagName' in node) {
      out.push(node);
      const children = node.tagName === 'template' ? [] : node.childNodes;
      for (let i = children.length - 1; i >= 0; i -= 1) {
        const child = children[i];
        if (child !== undefined) {
          stack.push(child);
        }
      }
    }
  }
  return out;
}

function textContent(html: string, placeholder: RegExp): string {
  let out = '';
  const stack: Node[] = [...parseFragment(html).childNodes].reverse();
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) {
      continue;
    }
    if (node.nodeName === '#text') {
      out += (node as DefaultTreeAdapterTypes.TextNode).value;
    } else if ('tagName' in node && node.tagName !== 'template') {
      for (let i = node.childNodes.length - 1; i >= 0; i -= 1) {
        const child = node.childNodes[i];
        if (child !== undefined) {
          stack.push(child);
        }
      }
    }
  }
  return out.replace(placeholder, ' ').replace(/\s+/gu, ' ').trim();
}

function multisetDifference(a: readonly string[], b: readonly string[]): string[] {
  const remaining = new Map<string, number>();
  for (const x of b) {
    remaining.set(x, (remaining.get(x) ?? 0) + 1);
  }
  const out: string[] = [];
  for (const x of a) {
    const n = remaining.get(x) ?? 0;
    if (n > 0) {
      remaining.set(x, n - 1);
    } else {
      out.push(x);
    }
  }
  return out;
}

function attributeValueAllowed(name: string, value: string, placeholder: RegExp): boolean {
  if (containsInvisible(value)) {
    return false;
  }
  const bare = value.replace(placeholder, '').trim();
  switch (name) {
    case 'tabindex':
      return bare === '-1' || bare === '0';
    case 'type':
      return ['button', 'submit', 'reset'].includes(bare);
    case 'role':
      return /^[a-z]+(?: [a-z]+)*$/u.test(bare);
    default:
      return true;
  }
}

/**
 * Every way the patched span leaves the allowlist; an empty list means the patch may go to a
 * developer for review.
 */
export function patchViolations(original: string, patched: string): string[] {
  const token = `lq${randomBytes(6).toString('hex')}n`;
  const placeholder = new RegExp(`${token}[0-9a-f]{12}x`, 'gu');
  const exact = new RegExp(`^${token}[0-9a-f]{12}x$`, 'u');
  const isPlaceholder = (name: string) => exact.test(name);
  const before = maskLiquid(original, token);
  const after = maskLiquid(patched, token);
  if (before === null || after === null) {
    return ['unterminated_liquid'];
  }
  const violations = new Set<string>();
  const added = multisetDifference(
    after.constructs.map(normalizeLiquid),
    before.constructs.map(normalizeLiquid),
  );
  const removed = multisetDifference(
    before.constructs.map(normalizeLiquid),
    after.constructs.map(normalizeLiquid),
  );
  if ([...added, ...removed].some((c) => !isAllowedLiquid(c))) {
    violations.add('forbidden_liquid');
  }
  const errorsBefore = errorCounts(before.html);
  for (const [code, n] of errorCounts(after.html)) {
    if (n > (errorsBefore.get(code) ?? 0)) {
      violations.add('html_parse_error');
    }
  }
  const was = elements(before.html);
  const now = elements(after.html);
  let i = 0;
  for (const element of now) {
    const counterpart = was[i];
    if (counterpart?.tagName === element.tagName) {
      i += 1;
      const names = new Set([...counterpart.attrs, ...element.attrs].map((a) => a.name));
      for (const name of names) {
        if (isPlaceholder(name)) {
          continue;
        }
        const old = counterpart.attrs.find((a) => a.name === name)?.value;
        const value = element.attrs.find((a) => a.name === name)?.value;
        if (old === value) {
          continue;
        }
        if (!ALLOWED_ATTRIBUTE.test(name)) {
          violations.add('forbidden_attribute');
        } else if (value !== undefined && !attributeValueAllowed(name, value, placeholder)) {
          violations.add('forbidden_attribute_value');
        }
      }
    } else if (element.tagName === 'span') {
      for (const a of element.attrs) {
        if (isPlaceholder(a.name)) {
          continue;
        }
        if (a.name === 'class') {
          if (
            !a.value
              .split(/\s+/u)
              .filter((c) => c !== '')
              .every((c) => SPAN_CLASSES.has(c))
          ) {
            violations.add('forbidden_attribute_value');
          }
        } else if (!ALLOWED_ATTRIBUTE.test(a.name)) {
          violations.add('forbidden_attribute');
        } else if (!attributeValueAllowed(a.name, a.value, placeholder)) {
          violations.add('forbidden_attribute_value');
        }
      }
    } else {
      violations.add('forbidden_element');
    }
  }
  if (i !== was.length) {
    violations.add('removed_element');
  }
  if (textContent(before.html, placeholder) !== textContent(after.html, placeholder)) {
    violations.add('changed_text');
  }
  return [...violations];
}
