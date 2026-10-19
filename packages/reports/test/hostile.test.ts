// Hostile merchant data in every free-text field of every report. The HTML must contain only
// the package's own elements and attributes, every link must point where it validated to, and
// the plain text, CSV and JSON must carry the input as inert text.
import { describe, expect, it } from 'vitest';
import {
  remediationLogCsv,
  remediationLogJson,
  renderStatement,
  renderSummary,
} from '../src/index.ts';
import { remediationInput, statementInput, summaryInput } from './fixtures.ts';
import {
  hostileRemediation,
  hostileStatement,
  HOSTILE,
  hostileSummary,
} from './support/hostile.ts';

const ELEMENTS = new Set([
  'html',
  'head',
  'meta',
  'title',
  'style',
  'body',
  'main',
  'h1',
  'h2',
  'h3',
  'p',
  'ul',
  'li',
  'a',
  'figure',
  'figcaption',
  'svg',
  'line',
  'text',
  'polyline',
  'circle',
  'rect',
  'table',
  'caption',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
]);
const ATTRIBUTES = new Set([
  'lang',
  'charset',
  'http-equiv',
  'content',
  'name',
  'href',
  'class',
  'id',
  'role',
  'aria-labelledby',
  'viewbox',
  'xmlns',
  'focusable',
  'x',
  'y',
  'x1',
  'x2',
  'y1',
  'y2',
  'cx',
  'cy',
  'r',
  'width',
  'height',
  'points',
  'text-anchor',
  'transform',
  'scope',
]);

// eslint-disable-next-line no-control-regex -- asserting that control characters are gone
const UNSAFE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u202A-\u202E\u2066-\u2069]/u;

/** Every element and attribute name in the markup, outside the style sheet. */
function inventory(html: string): {
  elements: Set<string>;
  attributes: Set<string>;
  hrefs: string[];
} {
  const body = html.replace(/<style>[\s\S]*?<\/style>/u, '<style></style>');
  const elements = new Set<string>();
  const attributes = new Set<string>();
  for (const tag of body.matchAll(/<([a-zA-Z][\w-]*)([^>]*)>/gu)) {
    elements.add((tag[1] ?? '').toLowerCase());
    // Values are always double-quoted and escaped, so a value cannot hide an attribute.
    for (const attr of (tag[2] ?? '').matchAll(/\s([^\s=/>"]+)(?:="[^"]*")?/gu)) {
      attributes.add((attr[1] ?? '').toLowerCase());
    }
  }
  const hrefs = [...body.matchAll(/href="([^"]*)"/gu)].map((m) => m[1] ?? '');
  return { elements, attributes, hrefs };
}

function expectInert(html: string): void {
  const { elements, attributes, hrefs } = inventory(html);
  expect([...elements].filter((e) => !ELEMENTS.has(e))).toEqual([]);
  expect([...attributes].filter((a) => !ATTRIBUTES.has(a))).toEqual([]);
  for (const href of hrefs) {
    expect(href, href).toMatch(/^(?:https?:\/\/|mailto:|tel:\+?\d+$)/u);
  }
  // No tag outside the allowlist, so no <script>; and no "<" left unescaped in text.
  expect(html.replace(/<style>[\s\S]*?<\/style>/u, '')).not.toMatch(/<(?![a-z/!])/iu);
}

describe('hostile input in the statement', () => {
  const out = renderStatement(hostileStatement());

  it("renders only the package's own markup", () => {
    expectInert(out.document.html);
    expectInert(out.fragment);
  });

  it('keeps the hostile text as visible, escaped text', () => {
    expect(out.document.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(out.document.html).toContain('&lt;/title&gt;&lt;script&gt;');
    expect(out.text).toContain('<img src=x onerror=alert(1)>');
  });

  it('strips control and bidirectional override characters', () => {
    expect(out.text).not.toMatch(UNSAFE);
    expect(out.document.html).not.toMatch(/[\u202A-\u202E\u2066-\u2069]/u);
  });

  it('puts the title and language only where they belong', () => {
    expect(out.document.html.match(/<title>/gu)).toHaveLength(1);
    expect(out.document.html.match(/<html /gu)).toHaveLength(1);
    expect(out.document.html).toContain('<html lang="en">');
  });

  it('has the same structure as the ordinary statement', () => {
    const plain = renderStatement(statementInput());
    const tags = (html: string): string[] =>
      [...html.matchAll(/<(h[1-3]|ul|table)\b/gu)].map((m) => m[1] ?? '');
    expect(tags(out.document.html)).toEqual(tags(plain.document.html));
  });
});

describe('hostile input in the summary and the log', () => {
  it("renders only the package's own markup in the summary", () => {
    const html = renderSummary(hostileSummary()).document.html;
    expectInert(html);
    expect(html).toContain('&lt;svg onload=alert(1)&gt;');
    expect(html).toBe(html.replace(/\u202E/gu, ''));
    expect(renderSummary(summaryInput()).document.html).not.toContain('onload');
  });

  it('writes the log as inert CSV and JSON', () => {
    const csv = remediationLogCsv(hostileRemediation());
    for (const line of csv.slice(1).split('\r\n').slice(1, -1)) {
      for (const cell of line.match(/"(?:[^"]|"")*"/gu) ?? []) {
        expect(cell, cell).not.toMatch(/^"\s*[=+\-@＝＋－＠]/u);
      }
    }
    const json = remediationLogJson(hostileRemediation());
    expect(json).not.toMatch(/[<>&\u2028\u2029]/u);
    const parsed = JSON.parse(json) as { entries: { approvedBy: { name: string } }[] };
    expect(parsed.entries[0]?.approvedBy.name).toBe(HOSTILE.formula);
    expect(remediationLogCsv(remediationInput())).not.toContain("'=");
  });
});
