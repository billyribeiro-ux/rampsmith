// Renders each page of a theme, serves it to Chromium through request interception (nothing
// leaves the process), runs axe-core 4.14.0 restricted to the scanner's tags (PLAN §11,
// step 4), and compares the result nodes with the golden occurrences (ADR-204).
import { crc32, deflateSync } from 'node:zlib';
import axe, { type AxeResults, type RunOptions } from 'axe-core';
import { chromium, type Browser, type Route } from 'playwright-core';
import type { RenderedElement } from '@rampsmith/liquid-patch';
import type { GoldenFile, Impact, Outcome } from '../golden.ts';
import type { ThemeEntry } from '../manifest.ts';
import {
  ASSET_PREFIX,
  FILES_PREFIX,
  type PageSpec,
  type ThemeRenderer,
} from '../render/renderer.ts';
import {
  comparePage,
  type AxeNode,
  type PageComparison,
  type ResolvedOccurrence,
} from './compare.ts';
import type { SnapshotNode } from './snapshot.ts';

export const ORIGIN = 'http://storefront.corpus.test';

function extraArgs(): string[] {
  const raw = process.env['CHROMIUM_ARGS'];
  if (raw === undefined || raw.trim() === '') return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every((a): a is string => typeof a === 'string')) {
    throw new Error('CHROMIUM_ARGS must be a JSON array of strings');
  }
  return parsed;
}

/**
 * Launches Chromium: the build bundled with playwright-core 1.64.1 by default (installed by
 * scripts/ensure-chromium.ts); CHROMIUM_EXECUTABLE_PATH and CHROMIUM_ARGS point at another
 * build where that download is blocked (docs/ENVIRONMENT.md), as in packages/a11y-rules.
 */
export async function launchChromium(): Promise<Browser> {
  const executablePath = process.env['CHROMIUM_EXECUTABLE_PATH'];
  return chromium.launch({
    headless: true,
    args: extraArgs(),
    ...(executablePath === undefined || executablePath === '' ? {} : { executablePath }),
  });
}

/** A one-pixel grey PNG, served for every image URL so no binary fixture is committed. */
function pixelPng(): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(0, 9);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, 0xb4]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const PIXEL = pixelPng();

async function serve(
  route: Route,
  renderer: ThemeRenderer,
  spec: PageSpec,
  html: string,
): Promise<void> {
  const url = new URL(route.request().url());
  if (url.origin !== ORIGIN) {
    await route.abort('blockedbyclient');
    return;
  }
  if (`${url.pathname}${url.search}` === spec.path || url.pathname === spec.path) {
    await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
    return;
  }
  if (url.pathname.startsWith(ASSET_PREFIX)) {
    const asset = renderer.renderAsset(decodeURIComponent(url.pathname.slice(ASSET_PREFIX.length)));
    if (asset !== null) {
      await route.fulfill({ status: 200, contentType: asset.contentType, body: asset.body });
      return;
    }
  }
  if (url.pathname.startsWith(FILES_PREFIX)) {
    await route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL });
    return;
  }
  await route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' });
}

/** What one page produced, before comparison. */
export interface PageRun {
  readonly page: string;
  readonly nodes: readonly AxeNode[];
  /** Every rule axe-core ran on the page (any result type), to prove a golden rule ran. */
  readonly rulesRun: readonly string[];
  readonly occurrences: readonly ResolvedOccurrence[];
  /**
   * The elements the page's result nodes and golden occurrences name, by their index in
   * document order, described for the source mapper (tag, attributes, text, ancestors).
   */
  readonly elements: Readonly<Record<number, RenderedElement>>;
  /** Every element of the page in document order (scripts left out), for the additive check. */
  readonly snapshot: readonly SnapshotNode[];
}

export interface PageResult extends PageRun {
  /** axe-core findings against the golden occurrences. */
  readonly comparison: PageComparison;
  /**
   * Custom-rule occurrences (engine `rampsmith-browser`) whose selector matched another number
   * of elements than the golden says. Whether the custom rule fires is checked at integration,
   * when `@rampsmith/a11y-rules` is in the workspace (CONTRACT.md, check 6).
   */
  readonly customSelectorMismatch: PageComparison['countMismatch'];
  /** The custom-rule occurrences with their selectors resolved on this page. */
  readonly customOccurrences: readonly ResolvedOccurrence[];
}

interface Wanted {
  readonly finding: string;
  readonly rule: string;
  readonly outcome: Outcome;
  readonly impact: Impact;
  readonly selector: string;
  readonly expectedCount: number;
}

/** The golden occurrences on one page, for findings of one engine. */
export function occurrencesFor(
  golden: GoldenFile,
  page: string,
  engine: 'axe' | 'rampsmith-browser' = 'axe',
): Wanted[] {
  const wanted: Wanted[] = [];
  for (const finding of golden.findings) {
    if (finding.engine !== engine) continue;
    for (const occurrence of finding.occurrences ?? []) {
      if (occurrence.page !== page && occurrence.page !== '*') continue;
      wanted.push({
        finding: finding.id,
        rule: finding.ruleId,
        outcome: finding.outcome,
        impact: finding.impact,
        selector: occurrence.selector,
        expectedCount: occurrence.count ?? 1,
      });
    }
  }
  return wanted;
}

interface InPageResult {
  readonly nodes: AxeNode[];
  readonly rulesRun: string[];
  readonly indices: number[][];
  readonly elements: Record<number, RenderedElement>;
  readonly snapshot: SnapshotNode[];
}

/** Renders, loads and checks one page in a fresh browser context. */
export async function runPage(
  browser: Browser,
  renderer: ThemeRenderer,
  spec: PageSpec,
  wanted: readonly Wanted[],
  options: {
    readonly tags: readonly string[];
    readonly viewport: { width: number; height: number };
  },
): Promise<PageRun> {
  const html = renderer.renderPage(spec);
  const context = await browser.newContext({
    viewport: options.viewport,
    locale: 'en-US',
    timezoneId: 'UTC',
    reducedMotion: 'reduce',
  });
  try {
    await context.route('**/*', (route) => serve(route, renderer, spec, html));
    const page = await context.newPage();
    await page.goto(`${ORIGIN}${spec.path}`, { waitUntil: 'load' });
    await page.addScriptTag({ content: axe.source });
    const result = await page.evaluate(
      async ([tags, selectors]): Promise<InPageResult> => {
        const all = Array.from(document.querySelectorAll('*'));
        const indexOf = new Map(all.map((el, i) => [el, i]));
        const attributesOf = (el: Element): Record<string, string> =>
          Object.fromEntries(Array.from(el.attributes, (a) => [a.name.toLowerCase(), a.value]));
        const snapshot = all
          .filter((el) => el.tagName !== 'SCRIPT')
          .map((el) => ({
            tag: el.tagName.toLowerCase(),
            attributes: attributesOf(el),
            text: Array.from(el.childNodes)
              .filter((n): n is Text => n.nodeType === Node.TEXT_NODE)
              .map((n) => n.data)
              .join(' ')
              .replace(/\s+/g, ' ')
              .trim(),
          }));
        const axeApi = (
          globalThis as unknown as {
            axe: { run(context: Document, options: RunOptions): Promise<AxeResults> };
          }
        ).axe;
        const results = await axeApi.run(document, {
          runOnly: { type: 'tag', values: [...tags] },
          resultTypes: ['violations', 'incomplete'],
          iframes: false,
          elementRef: true,
        });
        const nodes: AxeNode[] = [];
        for (const [outcome, list] of [
          ['violation', results.violations],
          ['incomplete', results.incomplete],
        ] as const) {
          for (const rule of list) {
            for (const node of rule.nodes) {
              const element: Element | undefined = node.element;
              const data: Record<string, unknown> = {};
              for (const check of [...node.any, ...node.all, ...node.none]) {
                if (check.data !== null && typeof check.data === 'object') {
                  data[check.id] = JSON.parse(JSON.stringify(check.data)) as unknown;
                }
              }
              nodes.push({
                rule: rule.id,
                outcome,
                impact: node.impact ?? null,
                index: element === undefined ? -1 : (indexOf.get(element) ?? -1),
                target: node.target.map(String).join(' >>> '),
                data,
              });
            }
          }
        }
        const rulesRun = [
          ...results.violations,
          ...results.incomplete,
          ...results.passes,
          ...results.inapplicable,
        ].map((r) => r.id);
        const indices = selectors.map((selector) =>
          Array.from(document.querySelectorAll(selector)).map((el) => indexOf.get(el) ?? -1),
        );
        const nodeOf = (el: Element) => {
          const previous: { tag: string; attributes: Record<string, string> }[] = [];
          for (let s = el.previousElementSibling; s !== null; s = s.previousElementSibling) {
            previous.push({ tag: s.tagName.toLowerCase(), attributes: attributesOf(s) });
          }
          let following = 0;
          for (let s = el.nextElementSibling; s !== null; s = s.nextElementSibling) following += 1;
          return {
            tag: el.tagName.toLowerCase(),
            attributes: attributesOf(el),
            previous,
            following,
          };
        };
        const wanted = new Set<number>();
        for (const n of nodes) if (n.index >= 0) wanted.add(n.index);
        for (const list of indices) for (const i of list) if (i >= 0) wanted.add(i);
        const elements: Record<number, RenderedElement> = {};
        for (const i of wanted) {
          const el = all[i];
          if (el === undefined) continue;
          const ancestors = [];
          for (let p = el.parentElement; p !== null; p = p.parentElement) ancestors.push(nodeOf(p));
          elements[i] = {
            ...nodeOf(el),
            text: el.textContent.replace(/\s+/g, ' ').trim(),
            ancestors,
          };
        }
        return { nodes, rulesRun: [...new Set(rulesRun)].sort(), indices, elements, snapshot };
      },
      [options.tags, wanted.map((w) => w.selector)] as const,
    );
    const occurrences = wanted.map((w, i) => ({ ...w, indices: result.indices[i] ?? [] }));
    return {
      page: spec.id,
      nodes: result.nodes,
      rulesRun: result.rulesRun,
      occurrences,
      elements: result.elements,
      snapshot: result.snapshot,
    };
  } finally {
    await context.close();
  }
}

export interface CheckOptions {
  readonly tags: readonly string[];
  readonly viewport: { width: number; height: number };
}

/** Renders and checks one page of a theme against its golden file. */
export async function checkPage(
  browser: Browser,
  renderer: ThemeRenderer,
  spec: PageSpec,
  golden: GoldenFile,
  options: CheckOptions,
): Promise<PageResult> {
  const axeWanted = occurrencesFor(golden, spec.id, 'axe');
  const customWanted = occurrencesFor(golden, spec.id, 'rampsmith-browser');
  const run = await runPage(browser, renderer, spec, [...axeWanted, ...customWanted], options);
  const axeOccurrences = run.occurrences.slice(0, axeWanted.length);
  const customOccurrences = run.occurrences.slice(axeWanted.length);
  return {
    ...run,
    occurrences: axeOccurrences,
    comparison: comparePage(axeOccurrences, run.nodes),
    customOccurrences,
    customSelectorMismatch: customOccurrences
      .filter((o) => o.indices.length !== o.expectedCount)
      .map((o) => ({
        finding: o.finding,
        selector: o.selector,
        expected: o.expectedCount,
        actual: o.indices.length,
      })),
  };
}

/** Checks every page of a theme against its golden file. */
export async function checkTheme(
  browser: Browser,
  renderer: ThemeRenderer,
  entry: ThemeEntry,
  golden: GoldenFile,
  options: CheckOptions,
): Promise<PageResult[]> {
  const results: PageResult[] = [];
  for (const spec of entry.pages) {
    results.push(await checkPage(browser, renderer, spec, golden, options));
  }
  return results;
}
