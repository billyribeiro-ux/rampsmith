// Prints every report document to PDF in Chromium and proves each PDF is tagged, has a
// document outline that follows the headings, carries its title and language, and tags its
// headings, lists, tables and charts (PLAN §16). Then feeds the isolated printer hostile
// markup directly, to prove the page can reach neither the network nor local files.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDocument, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  renderPdf,
  renderStatement,
  renderSummary,
  ReportRenderError,
  type ReportDocument,
} from '../src/index.ts';
import { CONTENT_SECURITY_POLICY } from '../src/document.ts';
import { printIsolated, type PdfBrowser, type PdfContext } from '../src/pdf.ts';
import { launch } from './support/browser.ts';
import { hostileStatement, hostileSummary } from './support/hostile.ts';
import { outputs } from './support/outputs.ts';

interface Node {
  readonly role?: string;
  readonly alt?: string;
  readonly children?: readonly Node[];
}

interface OutlineItem {
  readonly title: string;
  readonly items: readonly OutlineItem[];
}

let browser: Browser;
let server: Server;
let origin = '';
const hits: string[] = [];
const secretDir = mkdtempSync(join(tmpdir(), 'reports-secret-'));
const secretFile = join(secretDir, 'secret.txt');
const SECRET = 'LOCAL-FILE-CONTENT-MUST-NOT-REACH-A-REPORT';

beforeAll(async () => {
  writeFileSync(secretFile, SECRET);
  server = createServer((req, res) => {
    hits.push(req.url ?? '');
    res.end('reached');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  browser = await launch();
});

afterAll(async () => {
  await Promise.all(tasks.map((t) => t.destroy()));
  await browser.close();
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
  rmSync(secretDir, { recursive: true, force: true });
});

const tasks: { destroy(): Promise<void> }[] = [];

async function open(pdf: Uint8Array): Promise<PDFDocumentProxy> {
  const task = getDocument({ data: new Uint8Array(pdf), disableFontFace: true });
  tasks.push(task);
  return task.promise;
}

/** The catalog dictionary, which Chromium's Skia PDF backend writes uncompressed. */
function catalog(pdf: Uint8Array): string {
  const text = Buffer.from(pdf).toString('latin1');
  const at = text.indexOf('/Type /Catalog');
  expect(at, 'catalog').toBeGreaterThan(-1);
  return text.slice(at, text.indexOf('endobj', at));
}

function roles(node: Node | null, out: Node[] = []): Node[] {
  if (node === null) return out;
  out.push(node);
  for (const child of node.children ?? []) roles(child, out);
  return out;
}

function titles(items: readonly OutlineItem[] | null, depth = 0): string[] {
  return (items ?? []).flatMap((i) => [
    `${'  '.repeat(depth)}${i.title}`,
    ...titles(i.items, depth + 1),
  ]);
}

function headings(html: string): string[] {
  return [...html.matchAll(/<h([1-3])>(.*?)<\/h\1>/gu)].map(
    (m) =>
      `${'  '.repeat(Number(m[1]) - 1)}${(m[2] ?? '').replaceAll('&#39;', "'").replaceAll('&quot;', '"').replaceAll('&amp;', '&')}`,
  );
}

async function allText(doc: PDFDocumentProxy): Promise<string> {
  const parts: string[] = [];
  for (let n = 1; n <= doc.numPages; n += 1) {
    const content = await (await doc.getPage(n)).getTextContent();
    parts.push(content.items.map((i) => ('str' in i ? i.str : '')).join(' '));
  }
  return parts.join('\n').replace(/\s+/gu, ' ');
}

const documents = outputs().filter(
  (o): o is typeof o & { document: ReportDocument } => o.document !== undefined,
);

describe('every report prints to a tagged PDF with an outline', () => {
  it('covers every report document', () => {
    expect(documents.map((d) => d.name)).toEqual([
      'statement-known-barriers.html',
      'statement-no-known-barriers.html',
      'statement-not-evaluated.html',
      'summary.html',
      'summary-no-scans.html',
      'summary-one-scan.html',
    ]);
  });

  it.each(documents.map((d) => [d.name, d.document] as const))('%s', async (_name, document) => {
    const pdf = await renderPdf(document, browser);
    expect(Buffer.from(pdf.subarray(0, 5)).toString('latin1')).toBe('%PDF-');

    // Tagged: MarkInfo /Marked true, a structure tree, the language, the title shown.
    const cat = catalog(pdf);
    expect(cat).toMatch(/\/MarkInfo <<\/Type \/MarkInfo\s*\/Marked true>>/u);
    expect(cat).toContain('/StructTreeRoot');
    expect(cat).toContain('/Outlines');
    expect(cat).toContain('/DisplayDocTitle true');
    expect(cat).toContain('/Lang (en)');

    const doc = await open(pdf);
    const { info } = (await doc.getMetadata()) as { info: { Title?: string; Language?: string } };
    expect(info.Title).toBe(document.title);
    expect(info.Language).toBe('en');

    // The outline is the document's headings, nested by level.
    const outline = (await doc.getOutline()) as readonly OutlineItem[] | null;
    expect(titles(outline)).toEqual(headings(document.html));

    // Structure: headings, lists and tables are tagged as such on the pages they print on.
    const nodes: Node[] = [];
    for (let n = 1; n <= doc.numPages; n += 1) {
      roles((await (await doc.getPage(n)).getStructTree()) as Node | null, nodes);
    }
    const found = new Set(nodes.map((n) => n.role));
    for (const role of ['Document', 'H1', 'H2', 'P', 'L', 'LI']) {
      expect(found, role).toContain(role);
    }
    if (document.html.includes('<table>')) {
      for (const role of ['Table', 'TR', 'TH', 'TD', 'Caption']) {
        expect(found, role).toContain(role);
      }
    }
    // Each chart is a Figure whose alternative text is its caption plus its text summary.
    const charts = (document.html.match(/<svg class="chart"/gu) ?? []).length;
    const figures = nodes.filter((n) => n.role === 'Figure' && n.alt !== undefined);
    expect(figures).toHaveLength(charts);
    for (const f of figures) {
      expect(f.alt).toMatch(/(Line|Bar) chart of /u);
    }
    // The text is real text, in reading order, not an image of it.
    // Lines wrap at different points with different fonts, so compare without whitespace.
    const text = (await allText(doc)).replace(/\s/gu, '');
    expect(text).toContain(document.title.replace(/\s/gu, ''));
    expect(text).toContain('Deque,themakeroftheaxe-coreengine');
  });

  it('prints on Letter paper when asked', async () => {
    const document = documents[0]?.document;
    if (document === undefined) throw new Error('fixture');
    const doc = await open(await renderPdf(document, browser, { format: 'Letter' }));
    const [, , width, height] = (await doc.getPage(1)).view;
    expect([Math.round(width ?? 0), Math.round(height ?? 0)]).toEqual([612, 792]);
  });

  it('refuses anything but a document this package rendered', async () => {
    const forged = { lang: 'en', title: 't', html: '<p>x</p>' } as unknown as ReportDocument;
    await expect(renderPdf(forged, browser)).rejects.toThrow(TypeError);
  });
});

describe('hostile merchant data reaches the PDF only as text', () => {
  it.each([
    ['the statement', () => renderStatement(hostileStatement(origin)).document],
    ['the summary', () => renderSummary(hostileSummary(origin)).document],
  ])('%s prints, fetches nothing, and shows the markup as text', async (_what, build) => {
    const before = hits.length;
    const doc = await open(await renderPdf(build(), browser));
    const text = await allText(doc);
    expect(hits.slice(before)).toEqual([]);
    // Text extraction splits lines at wrap points (and drops the colon at a wrap after the
    // host), so compare the pieces without whitespace.
    const compact = text.replace(/\s/gu, '');
    expect(compact).toContain('<imgsrc="http://127.0.0.1');
    expect(compact).toContain('/escaped-img">');
    expect(compact).toContain('<iframesrc="file:///etc/hostname"></iframe>');
    expect(text).not.toContain(SECRET);
  });
});

describe('the print is isolated from the network and from local files', () => {
  const page = (body: string, head = ''): string =>
    `<!doctype html><html lang="en"><head><title>Hostile</title>${head}</head><body><h1>Hostile</h1>${body}</body></html>`;

  it.each([
    ['an image', () => page(`<img src="${origin}/img" alt="">`)],
    ['a style sheet', () => page('', `<link rel="stylesheet" href="${origin}/css">`)],
    [
      'a CSS import and background',
      () =>
        page(
          '',
          `<style>@import url(${origin}/import); body { background: url(${origin}/bg); }</style>`,
        ),
    ],
    ['an iframe', () => page(`<iframe src="${origin}/frame" title="x"></iframe>`)],
    ['an SVG image', () => page(`<svg><image href="${origin}/svg"/></svg>`)],
    [
      'a local file in an iframe',
      () => page(`<iframe src="file://${secretFile}" title="x"></iframe>`),
    ],
    ['a local file as an object', () => page(`<object data="file://${secretFile}"></object>`)],
    ['a local file as an image', () => page(`<img src="file://${secretFile}" alt="">`)],
    [
      'a font',
      () =>
        page(
          '',
          `<style>@font-face { font-family: x; src: url(${origin}/font); } h1 { font-family: x; }</style>`,
        ),
    ],
  ])('refuses %s, and nothing is fetched', async (_what, build) => {
    const before = hits.length;
    await expect(printIsolated(build(), 'en', browser)).rejects.toThrow(ReportRenderError);
    expect(hits.slice(before)).toEqual([]);
  });

  it('refuses a meta refresh that navigates away', async () => {
    const before = hits.length;
    const markup = page(
      '<p>x</p>',
      `<meta http-equiv="refresh" content="0;url=${origin}/refresh">`,
    );
    await expect(printIsolated(markup, 'en', browser)).rejects.toThrow(ReportRenderError);
    expect(hits.slice(before)).toEqual([]);
  });

  it('runs no script, even one the CSP would not catch', async () => {
    const before = hits.length;
    const pdf = await printIsolated(
      page(
        `<p id="p">static</p><script>document.getElementById('p').textContent = 'SCRIPT RAN'</script>`,
      ),
      'en',
      browser,
    );
    const doc = await open(pdf);
    const text = await allText(doc);
    expect(text).toContain('static');
    expect(text).not.toContain('SCRIPT RAN');
    expect(hits.slice(before)).toEqual([]);
  });

  it('never reports the URL it refused, which could carry merchant data', async () => {
    const error = await printIsolated(
      page(`<img src="${origin}/customer@example.com" alt="">`),
      'en',
      browser,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReportRenderError);
    expect(String(error)).not.toContain('customer@example.com');
    expect(String(error)).not.toContain(origin);
  });

  it('stops a print that runs past its time limit', async () => {
    const huge = page(`<table>${'<tr><td>cell</td></tr>'.repeat(60_000)}</table>`);
    await expect(printIsolated(huge, 'en', browser, { timeoutMs: 50 })).rejects.toThrow(
      /printing took longer than 50 ms/u,
    );
  });

  it('the server is reachable when asked directly, so the zero-hit checks are meaningful', async () => {
    const response = await fetch(`${origin}/direct`);
    expect(await response.text()).toBe('reached');
    expect(hits.at(-1)).toBe('/direct');
  });
});

describe('each isolation layer holds with the others turned off', () => {
  type Layer = 'csp' | 'offline' | 'proxy' | 'route';

  /** A browser that keeps only `keep` of the printer's layers. */
  function only(keep: Layer): PdfBrowser {
    return {
      async newContext(options) {
        const { offline, proxy, ...rest } = options;
        const context = await browser.newContext({
          ...rest,
          bypassCSP: keep !== 'csp',
          ...(keep === 'offline' ? { offline } : {}),
          ...(keep === 'proxy' ? { proxy } : {}),
        });
        if (keep === 'route') return context;
        const unrouted: PdfContext = {
          route: () => Promise.resolve(),
          newPage: () => context.newPage(),
          close: () => context.close(),
        };
        return unrouted;
      },
    };
  }

  const csp = `<meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}">`;
  const vectors = (): [string, string][] => [
    ['an image', `<img src="${origin}/layer-img" alt="">`],
    ['a style sheet', `<link rel="stylesheet" href="${origin}/layer-css">`],
    [
      'a font',
      `<style>@font-face { font-family: x; src: url(${origin}/layer-font); } p { font-family: x; }</style>`,
    ],
    ['an iframe', `<iframe src="${origin}/layer-frame" title="x"></iframe>`],
    ['a prefetch', `<link rel="prefetch" href="${origin}/layer-prefetch">`],
  ];

  async function attempt(keep: Layer, vector: string): Promise<string[]> {
    const before = hits.length;
    const markup = `<!doctype html><html lang="en"><head><title>Layer</title>${keep === 'csp' ? csp : ''}${vector}</head><body><p>Layer test</p></body></html>`;
    await printIsolated(markup, 'en', only(keep), { timeoutMs: 15_000 }).catch(() => undefined);
    // Give a stray connection time to arrive before counting.
    await new Promise((resolve) => setTimeout(resolve, 200));
    return hits.slice(before);
  }

  it.each(['csp', 'offline', 'proxy'] as const)('%s alone stops every vector', async (keep) => {
    for (const [what, vector] of vectors()) {
      expect(await attempt(keep, vector), `${keep}: ${what}`).toEqual([]);
    }
  });

  it('routing alone stops every vector but a prefetch, which the other layers stop', async () => {
    for (const [what, vector] of vectors().filter(([w]) => w !== 'a prefetch')) {
      expect(await attempt('route', vector), `route: ${what}`).toEqual([]);
    }
  });
});

describe('failures are ReportRenderErrors that name the step, never the data', () => {
  it('wraps a browser error without its message', async () => {
    const failing: PdfBrowser = {
      newContext: () =>
        Promise.resolve({
          route: () => Promise.resolve(),
          newPage: () => Promise.reject(new Error('Browser logs: customer@example.com')),
          close: () => Promise.resolve(),
        }),
    };
    const error = await printIsolated('<p>x</p>', 'en', failing).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReportRenderError);
    expect(String(error)).toBe('ReportRenderError: the browser failed while printing (Error)');
  });

  it('applies the deadline to opening the context, and closes a context that opens late', async () => {
    let closed = 0;
    let open: ((context: PdfContext) => void) | undefined;
    const slow: PdfBrowser = {
      newContext: () =>
        new Promise<PdfContext>((resolve) => {
          open = resolve;
        }),
    };
    await expect(printIsolated('<p>x</p>', 'en', slow, { timeoutMs: 50 })).rejects.toThrow(
      'printing took longer than 50 ms',
    );
    open?.({
      route: () => Promise.resolve(),
      newPage: () => Promise.reject(new Error('never used')),
      close: () => {
        closed += 1;
        return Promise.resolve();
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closed).toBe(1);
  });
});
