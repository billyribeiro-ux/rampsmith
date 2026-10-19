// The HTML document every report is printed from (ADR-222, ADR-223). It is self-contained:
// one inline style sheet, inline SVG charts, no scripts, no images, no fonts, and a content
// security policy that refuses every fetch, so a rendered report can make no request at all.
import { createHash } from 'node:crypto';
import { markup, rawHtml, type Html } from './html.ts';

/** Colours meet 4.5:1 for text and 3:1 for chart marks against the white page (ADR-226). */
export const PALETTE = {
  page: '#ffffff',
  text: '#1b1b1b',
  muted: '#4a4a4a',
  rule: '#767676',
  accent: '#0b4f8a',
  critical: '#9b1c1c',
  serious: '#a3470d',
  moderate: '#6b5300',
  minor: '#3d4f63',
} as const;

const CSS = `
@page { size: A4; margin: 18mm 16mm; }
:root { color-scheme: light; }
html { background: ${PALETTE.page}; color: ${PALETTE.text}; }
body { font: 11pt/1.5 system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", "Liberation Sans", Arial, sans-serif; font-variant-ligatures: none; margin: 0 auto; max-width: 46rem; padding: 1.5rem; }
h1 { font-size: 1.7rem; line-height: 1.2; margin: 0 0 0.75rem; }
h2 { font-size: 1.3rem; margin: 2rem 0 0.5rem; break-after: avoid; }
h3 { font-size: 1.05rem; margin: 1.25rem 0 0.4rem; break-after: avoid; }
p, ul, ol { margin: 0 0 0.75rem; }
li { margin-bottom: 0.25rem; }
a { color: ${PALETTE.accent}; text-decoration: underline; }
.meta { color: ${PALETTE.muted}; }
.figures { list-style: none; padding: 0; }
.figures li { border-left: 4px solid ${PALETTE.accent}; padding-left: 0.6rem; margin-bottom: 0.5rem; }
figure { margin: 1rem 0; break-inside: avoid; }
figcaption { font-weight: 600; margin-bottom: 0.4rem; }
svg.chart { display: block; width: 100%; height: auto; max-width: 40rem; }
.chart .axis, .chart .grid { stroke: ${PALETTE.rule}; stroke-width: 1; }
.chart .grid { stroke-dasharray: 2 3; }
.chart .label { fill: ${PALETTE.text}; font-size: 12px; }
.chart .line { fill: none; stroke: ${PALETTE.accent}; stroke-width: 2.5; }
.chart .point { fill: ${PALETTE.accent}; }
.chart .bar-critical { fill: ${PALETTE.critical}; }
.chart .bar-serious { fill: ${PALETTE.serious}; }
.chart .bar-moderate { fill: ${PALETTE.moderate}; }
.chart .bar-minor { fill: ${PALETTE.minor}; }
table { border-collapse: collapse; width: 100%; margin: 0.5rem 0 1rem; font-size: 0.95em; }
caption { text-align: left; font-weight: 600; padding-bottom: 0.3rem; }
th, td { border: 1px solid ${PALETTE.rule}; padding: 0.3rem 0.5rem; text-align: left; vertical-align: top; }
th[scope="col"] { background: #f2f2f2; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
tr { break-inside: avoid; }
`.trim();

const STYLE_HASH = createHash('sha256').update(CSS).digest('base64');

/** No fetch of any kind; only this file's own style sheet, matched by its hash. */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  `style-src 'sha256-${STYLE_HASH}'`,
  "img-src 'none'",
  "font-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const KEY = Symbol('ReportDocument');

/**
 * A complete report document. Only this package's renderers can create one; it is frozen and
 * its fields are private, so `ReportDocument.is` cannot be satisfied by a look-alike object,
 * an `Object.create(ReportDocument.prototype)`, or a document whose HTML was swapped.
 */
export class ReportDocument {
  readonly #lang: string;
  readonly #title: string;
  readonly #html: string;

  constructor(key: symbol, lang: string, title: string, markup: string) {
    if (key !== KEY) {
      throw new TypeError('report documents are created only by this package');
    }
    this.#lang = lang;
    this.#title = title;
    this.#html = markup;
    Object.freeze(this);
  }

  static is(value: unknown): value is ReportDocument {
    return typeof value === 'object' && value !== null && #html in value;
  }

  get lang(): string {
    return this.#lang;
  }

  get title(): string {
    return this.#title;
  }

  get html(): string {
    return this.#html;
  }
}

// Frozen, so no one can override the getters or `is` for a genuine document.
Object.freeze(ReportDocument.prototype);
Object.freeze(ReportDocument);

export function reportDocument(options: {
  readonly lang: string;
  readonly title: string;
  readonly body: Html;
}): ReportDocument {
  const page = markup`<!doctype html>
<html lang="${options.lang}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${options.title}</title>
<style>${rawHtml(CSS)}</style>
</head>
<body>
<main>
${options.body}
</main>
</body>
</html>
`;
  return new ReportDocument(KEY, options.lang, options.title, page.toString());
}
