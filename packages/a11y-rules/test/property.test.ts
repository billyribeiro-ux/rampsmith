// Property tests: hostile or random input never throws, never hangs, and always yields
// well-formed findings whose offsets point into the input.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PARSE_LIMITS, parseRichText } from '../src/data/html.ts';
import { auditMediaAlt } from '../src/data/media-alt.ts';
import { auditMenu, type MenuItemInput } from '../src/data/menu.ts';
import { auditRichText, type RichTextAudit } from '../src/data/rich-text.ts';
import { RULES } from '../src/rules.ts';

const TAGS = [
  'a',
  'abbr',
  'b',
  'body',
  'br',
  'button',
  'caption',
  'col',
  'colgroup',
  'div',
  'em',
  'font',
  'form',
  'frameset',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'head',
  'hr',
  'html',
  'i',
  'iframe',
  'img',
  'input',
  'li',
  'math',
  'noscript',
  'ol',
  'option',
  'p',
  'plaintext',
  'script',
  'select',
  'span',
  'strong',
  'style',
  'svg',
  'table',
  'tbody',
  'td',
  'template',
  'textarea',
  'th',
  'title',
  'tr',
  'u',
  'ul',
  'xmp',
  'mglyph',
  'foreignObject',
  'desc',
];
const ATTRS = [
  'href',
  'alt',
  'src',
  'style',
  'role',
  'aria-level',
  'aria-label',
  'aria-labelledby',
  'aria-hidden',
  'hidden',
  'id',
  'color',
  'title',
  'type',
  'xlink:href',
  'xmlns',
];
const ATTR_VALUES = fc.oneof(
  fc.constantFrom(
    'color:red',
    'color: #c00; font-weight: bold',
    'display:none',
    'IMG_0001.jpg',
    'heading',
    'presentation',
    'columnheader',
    'true',
    '4',
    'x',
    '',
    'click here',
    '/cart',
    'a"b',
    "a'b",
    'url("a;b")',
    '/* x',
    '&amp;',
    '&#x0;',
    '\u0000',
    '\r\n',
  ),
  fc.string({ unit: 'binary', maxLength: 40 }),
);

const caseOf = (tag: string, upper: boolean): string => (upper ? tag.toUpperCase() : tag);
const attribute = fc
  .tuple(fc.constantFrom(...ATTRS), ATTR_VALUES, fc.constantFrom('"', "'", ''))
  .map(([name, value, q]) =>
    q === '' ? ` ${name}=${value.replace(/[\s>]/g, '')}` : ` ${name}=${q}${value}${q}`,
  );
const openTag = fc
  .tuple(
    fc.constantFrom(...TAGS),
    fc.boolean(),
    fc.array(attribute, { maxLength: 4 }),
    fc.boolean(),
  )
  .map(
    ([tag, upper, attrs, selfClose]) =>
      `<${caseOf(tag, upper)}${attrs.join('')}${selfClose ? '/' : ''}>`,
  );
const closeTag = fc
  .tuple(fc.constantFrom(...TAGS), fc.boolean())
  .map(([tag, upper]) => `</${caseOf(tag, upper)}>`);
const text = fc.string({ unit: 'binary', maxLength: 30 });
const junk = fc.constantFrom(
  '<',
  '>',
  '&',
  '&amp;',
  '&#128512;',
  '<!--',
  '-->',
  '<![CDATA[',
  ']]>',
  '</',
  '<!doctype html>',
  '\r\n',
  '\r',
  '\u0000',
  '"',
  "'",
  '=',
  '/>',
  '<?xml?>',
  '\uD800',
  '\uDFFF',
  'click here',
);
const token = fc.oneof(
  { weight: 4, arbitrary: openTag },
  { weight: 3, arbitrary: closeTag },
  { weight: 3, arbitrary: text },
  { weight: 2, arbitrary: junk },
);
const htmlish = fc.array(token, { maxLength: 80 }).map((parts) => parts.join(''));

const DATA_RULES = new Set(
  Object.values(RULES)
    .filter((rule) => rule.audit === 'data')
    .map((rule) => rule.id),
);

function audit(html: string): RichTextAudit {
  return auditRichText({ resource: 'r', field: 'f', html }, { locale: 'en' });
}

function assertWellFormed(html: string, result: RichTextAudit): void {
  expect(['audited', 'not_audited']).toContain(result.status);
  if (result.status === 'not_audited') {
    expect(result.findings).toEqual([]);
    return;
  }
  let previous = -1;
  for (const f of result.findings) {
    expect(DATA_RULES.has(f.ruleId)).toBe(true);
    expect(f.criteria.length).toBeGreaterThan(0);
    const { start, end } = f.location;
    expect(Number.isInteger(start) && Number.isInteger(end)).toBe(true);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThanOrEqual(start);
    expect(end).toBeLessThanOrEqual(html.length);
    expect(start).toBeGreaterThanOrEqual(previous);
    previous = start;
    if (f.data?.['approximateLocation'] !== true) expect(html.charAt(start)).toBe('<');
  }
}

describe('auditRichText on generated input', () => {
  it('never throws and always returns well-formed findings (tag soup)', () => {
    fc.assert(
      fc.property(htmlish, (html) => {
        const result = audit(html);
        assertWellFormed(html, result);
        expect(audit(html)).toEqual(result);
      }),
      { numRuns: 600 },
    );
  });

  it('never throws on arbitrary strings, including lone surrogates and NUL', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 2_000 }), (html) => {
        assertWellFormed(html, audit(html));
      }),
      { numRuns: 400 },
    );
  });

  it('finishes quickly on long repetitions of hostile patterns', () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(openTag, closeTag, junk), { minLength: 1, maxLength: 4 }),
        fc.integer({ min: 1_000, max: 20_000 }),
        (parts, times) => {
          const unit = parts.join('');
          const html = unit.repeat(
            Math.max(1, Math.min(times, Math.floor(200_000 / Math.max(1, unit.length)))),
          );
          const started = performance.now();
          const result = audit(html);
          expect(performance.now() - started).toBeLessThan(10_000);
          assertWellFormed(html, result);
        },
      ),
      { numRuns: 25 },
    );
  });
});

describe('incremental parsing (audit H2)', () => {
  type Node = Parameters<typeof dump>[0];
  function dump(node: {
    nodeName: string;
    childNodes?: readonly unknown[];
    sourceCodeLocation?: { startOffset: number; endOffset: number } | null;
    value?: string;
    attrs?: readonly { name: string; value: string }[];
  }): string {
    const loc = node.sourceCodeLocation;
    const own = `${node.nodeName}${loc ? `@${String(loc.startOffset)}-${String(loc.endOffset)}` : ''}${
      node.value === undefined ? '' : JSON.stringify(node.value)
    }${node.attrs === undefined ? '' : JSON.stringify(node.attrs)}`;
    const children = (node.childNodes ?? []) as Node[];
    return `${own}(${children.map(dump).join(',')})`;
  }

  it('builds the same tree and offsets whatever the chunk size', () => {
    fc.assert(
      fc.property(htmlish, fc.integer({ min: 1, max: 9 }), (html, chunk) => {
        const whole = parseRichText(html, DEFAULT_PARSE_LIMITS, undefined, 1_000_000);
        const pieces = parseRichText(html, DEFAULT_PARSE_LIMITS, undefined, chunk);
        expect(pieces.ok).toBe(whole.ok);
        if (whole.ok && pieces.ok) expect(dump(pieces.fragment)).toBe(dump(whole.fragment));
      }),
      { numRuns: 400 },
    );
  });
});

describe('auditMediaAlt and auditMenu on generated input', () => {
  it('auditMediaAlt never throws and locates the whole alt value', () => {
    fc.assert(
      fc.property(
        fc.option(fc.string({ unit: 'binary', maxLength: 200 })),
        fc.option(fc.string({ unit: 'binary', maxLength: 200 })),
        (alt, fileName) => {
          const findings = auditMediaAlt({ resource: 'r', alt, fileName });
          expect(findings.length).toBeLessThanOrEqual(1);
          for (const f of findings) {
            expect(f.location).toEqual({
              resource: 'r',
              field: 'alt',
              start: 0,
              end: (alt ?? '').length,
            });
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it('auditMenu never throws on arbitrary trees', () => {
    const tree = fc.letrec<{ item: MenuItemInput }>((tie) => ({
      item: fc.record({
        resource: fc.string({ maxLength: 8 }),
        title: fc.string({ unit: 'binary', maxLength: 12 }),
        url: fc.option(fc.constantFrom('/a', '/b', '/a/', '')),
        items: fc.oneof(
          { maxDepth: 4, depthIdentifier: 'menu' },
          fc.constant([]),
          fc.array(tie('item'), { maxLength: 3 }),
        ),
      }),
    }));
    fc.assert(
      fc.property(fc.array(tree.item, { maxLength: 6 }), (items) => {
        for (const f of auditMenu({ resource: 'm', items })) {
          expect(['rs-menu-item-label-empty', 'rs-menu-item-label-duplicate']).toContain(f.ruleId);
          expect(f.location.start).toBe(0);
        }
      }),
      { numRuns: 300 },
    );
  });
});
