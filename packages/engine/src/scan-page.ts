/**
 * Loads one page in a fresh Chromium context, checks it in each requested state, and returns what
 * it found (PLAN §11, render audit steps 2 to 7; ADR-070). All traffic goes through egress when
 * a proxy is given.
 *
 * Per state: axe-core restricted to the WCAG tag set (whole page in the default state, the
 * changed region in the others) and an evidence crop per failing element. On a page flagged
 * `deep`, the custom browser checks of `@rampsmith/a11y-rules` run after the default state's
 * axe pass. A bot challenge is reported and never solved (ADR-027).
 */
import { AxeBuilder } from '@axe-core/playwright';
import {
  RULES,
  checkFocusNotObscured,
  checkKeyboard,
  checkMediaAutoplay,
  checkReflow,
  checkTextSpacing,
  openState,
  scanContextOptions,
  type CheckResult,
  type PageFinding,
  type StateOutcome,
} from '@rampsmith/a11y-rules';
import axe from 'axe-core';
import type { Browser, BrowserContext, Page } from 'playwright';
import { assertLoopbackProxied, contextProxy } from './browser.ts';
import { detectChallenge, type Challenge } from './challenge.ts';
import { cropOf } from './evidence.ts';
import { scrubExcerpt } from './scrub.ts';
import { isPasswordPage, unlockStorefront } from './storefront.ts';
import { criteriaFromTags } from './wcag.ts';
import { VIEWPORT_SIZES, type PageState, type Viewport } from './pipeline/vocab.ts';

/** Only WCAG A and AA rules count as failures (PLAN §11 step 4). */
export const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] as const;

export const AXE_VERSION = axe.version;

export type Impact = 'minor' | 'moderate' | 'serious' | 'critical';

/** Why a page was not checked at all. */
type BlockedReason = Challenge | 'storefront_password';

/** One element that failed (or could not be decided by) one rule. */
export interface Occurrence {
  readonly ruleId: string;
  readonly impact: Impact;
  readonly criteria: readonly string[];
  readonly help: string;
  readonly target: string;
  readonly html: string;
  /** The `shopify-section-*` wrapper's id, when the element sits in one. */
  readonly section: string | undefined;
  /** The element's ancestors up to its section wrapper, nearest first (ADR-296). */
  readonly ancestors?: readonly AncestorNode[];
  /** What axe-core measured for a `color-contrast` node, for the code-fix channel (ADR-296). */
  readonly evidence?: ContrastReading;
  /** A PNG of the area around the element (at most 64 KiB), when one could be taken. */
  readonly crop?: Buffer;
}

/** The colours and text size axe-core's `color-contrast` check measured. */
export interface ContrastReading {
  readonly foreground: string;
  readonly background: string;
  readonly font_size_px: number;
  readonly bold: boolean;
}

/** How a state ended; the values of `scan_pages.state_outcome`. */
type StateResult = 'opened' | 'not_found' | 'blocked' | 'timed_out' | 'error';

export interface StateScan {
  readonly state: PageState;
  readonly result: StateResult;
  /** Why the state was not reached or was stopped: a short code, never page content. */
  readonly reason: string | undefined;
  readonly violations: readonly Occurrence[];
  /** Undecided results go to review, never counted as failures. */
  readonly incomplete: readonly Occurrence[];
  /** Best-practice results of the custom rules, stored apart (PLAN §11 step 4). */
  readonly bestPractice: readonly Occurrence[];
  /** Rules that ran in this state, axe-core's and the custom checks'. */
  readonly rulesRun: readonly string[];
  readonly checksRun: number;
  readonly checksPassed: number;
  readonly durationMs: number;
}

export interface PageScan {
  readonly url: string;
  readonly finalUrl: string;
  readonly status: number;
  /** Set when nothing was checked: a bot challenge or a closed storefront answered. */
  readonly blocked: BlockedReason | undefined;
  /** The default state first when requested, then the interactive states in order. */
  readonly states: readonly StateScan[];
  /** Crops of the `cropSelectors` that were found, keyed by selector. */
  readonly crops: Readonly<Record<string, Buffer>>;
  /** Absolute `href`s of the page's links, when `collectLinks` asked for them. */
  readonly links?: readonly string[];
  readonly durationMs: number;
}

export interface ScanOptions {
  readonly url: string;
  /** egress, with the scan token as the proxy password (ADR-025). */
  readonly proxy?: { readonly server: string; readonly token: string };
  readonly viewport?: Viewport;
  readonly locale?: string;
  readonly userAgent: string;
  /** Navigation and settle budget. Default 15 seconds. */
  readonly timeoutMs?: number;
  /** How long the DOM must stay unchanged. Default 500 ms. */
  readonly quietMs?: number;
  /** States to check, in order. Default `['default']`. */
  readonly states?: readonly PageState[];
  /** Run the custom browser checks on the default state. */
  readonly deep?: boolean;
  /** The storefront password for this scan; used once, never stored or logged. */
  readonly storefrontPassword?: string;
  /** Evidence crops per state. Default 8. */
  readonly maxCrops?: number;
  /** CSS selectors to crop in the default state, for the after-picture of a fix. */
  readonly cropSelectors?: readonly string[];
  /** Return the page's link targets, for the free scanner to choose two more pages from. */
  readonly collectLinks?: boolean;
  /**
   * The whole page scan's deadline, from the first navigation to the last state. When it passes,
   * the browser context is closed and the scan throws {@link ScanDeadlineError}, whatever the
   * page is doing: the navigation timeout bounds only navigation, and a page can replace its
   * own timers or busy-loop its main thread (audit M2). Default {@link DEFAULT_DEADLINE_MS}.
   */
  readonly deadlineMs?: number;
}

/** A page scan that ran out its overall deadline. The context was closed. */
export class ScanDeadlineError extends Error {
  readonly deadlineMs: number;

  constructor(deadlineMs: number) {
    super(`the page scan did not finish within ${deadlineMs.toString()} ms`);
    this.name = 'ScanDeadlineError';
    this.deadlineMs = deadlineMs;
  }
}

/**
 * The overall deadline of one page scan when the caller sets none (audit M2). Under the
 * page token's 120 seconds (`PAGE_TOKEN_TTL_SECONDS`).
 */
export const DEFAULT_DEADLINE_MS = 100_000;

const IMPACTS = new Set<string>(['minor', 'moderate', 'serious', 'critical']);
const IMPACT_ORDER: Readonly<Record<Impact, number>> = {
  critical: 3,
  serious: 2,
  moderate: 1,
  minor: 0,
};

/** Waits until the DOM has been quiet for `quietMs`, at most `capMs`. */
export async function settle(page: Page, quietMs: number, capMs: number): Promise<void> {
  await page.evaluate(
    ([quiet, cap]) =>
      new Promise<void>((resolve) => {
        let timer = setTimeout(done, quiet);
        const stop = setTimeout(done, cap);
        const observer = new MutationObserver(() => {
          clearTimeout(timer);
          timer = setTimeout(done, quiet);
        });
        function done() {
          observer.disconnect();
          clearTimeout(timer);
          clearTimeout(stop);
          resolve();
        }
        observer.observe(document, { subtree: true, childList: true, attributes: true });
      }),
    [quietMs, capMs] as const,
  );
}

interface AxeNode {
  readonly target: unknown;
  readonly html: string;
  readonly impact?: string | null;
  /** The passing-any checks' results; only `color-contrast`'s data is kept (ADR-296). */
  readonly any?: readonly { readonly id: string; readonly data?: unknown }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** axe-core's measure for a `color-contrast` node: `fgColor`, `bgColor`, `fontSize`, weight. */
export function contrastReading(node: AxeNode): ContrastReading | undefined {
  const data = node.any?.find((c) => c.id === 'color-contrast')?.data;
  if (!isRecord(data)) return undefined;
  const fg = data['fgColor'];
  const bg = data['bgColor'];
  const size = data['fontSize'];
  const weight = data['fontWeight'];
  const px = typeof size === 'string' ? /\((\d*\.?\d+)px\)/u.exec(size)?.[1] : undefined;
  if (typeof fg !== 'string' || typeof bg !== 'string' || px === undefined) return undefined;
  const font = Number(px);
  if (!Number.isFinite(font) || font <= 0 || font > 1000) return undefined;
  return {
    foreground: fg.slice(0, 32),
    background: bg.slice(0, 32),
    font_size_px: font,
    bold: weight === 'bold' || (typeof weight === 'number' && weight >= 700),
  };
}

interface AxeRule {
  readonly id: string;
  readonly impact?: string | null;
  readonly tags: readonly string[];
  readonly help: string;
  readonly nodes: readonly AxeNode[];
}

function selectorOf(target: unknown): string {
  return Array.isArray(target) ? target.map(String).join(' >>> ') : String(target);
}

/** An ancestor of a failing element: its tag and attributes, for the source mapper. */
export interface AncestorNode {
  readonly tag: string;
  readonly attributes: Readonly<Record<string, string>>;
}

/** Most ancestors, attributes per ancestor and characters per attribute value the scanner keeps. */
const MAX_ANCESTORS = 16;
const MAX_ANCESTOR_ATTRIBUTES = 12;
const MAX_ATTRIBUTE_CHARS = 160;

interface Located {
  readonly section: string | null;
  readonly ancestors: readonly AncestorNode[];
}

async function occurrences(page: Page, rules: readonly AxeRule[]): Promise<Occurrence[]> {
  const flat = rules.flatMap((rule) => rule.nodes.map((node) => ({ rule, node })));
  const selectors = flat.map(({ node }) =>
    Array.isArray(node.target) && node.target.length === 1 ? String(node.target[0]) : '',
  );
  const located: Located[] = await page.evaluate(
    ([list, maxAncestors, maxAttributes, maxChars]) =>
      list.map((selector) => {
        const none = { section: null, ancestors: [] };
        if (selector === '') return none;
        try {
          const el = document.querySelector(selector);
          if (el === null) return none;
          const ancestors: { tag: string; attributes: Record<string, string> }[] = [];
          for (let p = el.parentElement; p !== null; p = p.parentElement) {
            const attributes: Record<string, string> = {};
            for (const a of Array.from(p.attributes).slice(0, maxAttributes)) {
              attributes[a.name.toLowerCase()] = a.value.slice(0, maxChars);
            }
            ancestors.push({ tag: p.tagName.toLowerCase(), attributes });
            // `getAttribute`: a form with a field named `id` has an `id` property that is that field.
            const id = p.getAttribute('id') ?? '';
            if (id.startsWith('shopify-section-') || ancestors.length >= maxAncestors) break;
          }
          return {
            section: el.closest('[id^="shopify-section-"]')?.getAttribute('id') ?? null,
            ancestors,
          };
        } catch {
          return none;
        }
      }),
    [selectors, MAX_ANCESTORS, MAX_ANCESTOR_ATTRIBUTES, MAX_ATTRIBUTE_CHARS] as const,
  );
  return flat.map(({ rule, node }, i) => {
    const impact = node.impact ?? rule.impact ?? 'moderate';
    const where = located[i];
    const reading = rule.id === 'color-contrast' ? contrastReading(node) : undefined;
    return {
      ruleId: rule.id,
      impact: IMPACTS.has(impact) ? (impact as Impact) : 'moderate',
      criteria: criteriaFromTags(rule.tags),
      help: rule.help,
      target: selectorOf(node.target),
      html: scrubExcerpt(node.html),
      section: where?.section ?? undefined,
      ...(where === undefined || where.ancestors.length === 0
        ? {}
        : { ancestors: where.ancestors }),
      ...(reading === undefined ? {} : { evidence: reading }),
    };
  });
}

/** The outer HTML and section of the elements custom checks name, by their target paths. */
async function describeTargets(
  page: Page,
  targets: readonly (readonly string[])[],
): Promise<{ html: string; section: string | undefined }[]> {
  return page.evaluate(
    (list) =>
      list.map((path) => {
        try {
          let node: Element | Document | ShadowRoot = document;
          for (const selector of path) {
            const root: ParentNode = node instanceof Element ? (node.shadowRoot ?? node) : node;
            const next: Element | null = root.querySelector(selector);
            if (next === null) return { html: '', section: undefined };
            node = next;
          }
          if (!(node instanceof Element)) return { html: '', section: undefined };
          return {
            html: node.outerHTML.slice(0, 4096),
            section: node.closest('[id^="shopify-section-"]')?.getAttribute('id') ?? undefined,
          };
        } catch {
          return { html: '', section: undefined };
        }
      }),
    targets.map((t) => [...t]),
  );
}

async function fromCustom(
  page: Page,
  findings: readonly PageFinding[],
): Promise<{ violations: Occurrence[]; incomplete: Occurrence[]; bestPractice: Occurrence[] }> {
  const described = await describeTargets(
    page,
    findings.map((f) => f.target),
  );
  const out = {
    violations: [] as Occurrence[],
    incomplete: [] as Occurrence[],
    bestPractice: [] as Occurrence[],
  };
  findings.forEach((finding, i) => {
    const where = described[i];
    const occurrence: Occurrence = {
      ruleId: finding.ruleId,
      impact: finding.impact,
      criteria: finding.criteria,
      help: RULES[finding.ruleId].summary,
      target: finding.target.join(' >>> '),
      html: scrubExcerpt(where?.html ?? ''),
      section: where?.section,
    };
    if (finding.bestPractice) out.bestPractice.push(occurrence);
    else if (finding.outcome === 'violation') out.violations.push(occurrence);
    else out.incomplete.push(occurrence);
  });
  return out;
}

/**
 * axe-core's autoplay rule plays the media for about ten seconds to measure it; the custom
 * `media-autoplay` check of a11y-rules covers the same criterion without the wait.
 */
const SKIPPED_RULES = ['no-autoplay-audio'] as const;

/** What one axe-core run returned, reduced to what the scanner keeps. */
interface AxeRun {
  readonly violations: readonly AxeRule[];
  readonly incomplete: readonly AxeRule[];
  readonly passes: readonly string[];
}

/** Whole-page analysis, with `@axe-core/playwright` (iframes included). */
async function analyzePage(page: Page): Promise<AxeRun> {
  const results = await new AxeBuilder({ page })
    .withTags([...WCAG_TAGS])
    .disableRules([...SKIPPED_RULES])
    .analyze();
  return {
    violations: results.violations,
    incomplete: results.incomplete,
    passes: results.passes.map((r) => r.id),
  };
}

/**
 * Analysis of the region a state changed. `@axe-core/playwright` finishes each run in a blank
 * page it opens in the same context, and the checkout guard that the state scripts keep on that
 * context closes every page it did not open itself (a11y-rules ADR-116), so this runs axe-core
 * in the page: the source goes into every frame and `axe.run` scopes to the region.
 */
async function analyzeRegion(page: Page, region: readonly string[]): Promise<AxeRun> {
  await Promise.all(
    page.frames().map((frame) => frame.evaluate(axe.source).catch(() => undefined)),
  );
  const context =
    region.length === 1
      ? { include: [region[0] ?? 'html'] }
      : { include: [{ fromShadowDom: [...region] }] };
  return page.evaluate(
    async ([scope, tags, skipped]) => {
      const runner = (globalThis as unknown as { axe: typeof axe }).axe;
      const result = await runner.run(scope as axe.ElementContext, {
        runOnly: { type: 'tag', values: [...tags] },
        rules: Object.fromEntries(skipped.map((id) => [id, { enabled: false }])),
        resultTypes: ['violations', 'incomplete', 'passes'],
      });
      const trim = (rules: axe.Result[]) =>
        rules.map((r) => ({
          id: r.id,
          impact: r.impact ?? null,
          tags: r.tags,
          help: r.help,
          nodes: r.nodes.map((n) => ({
            target: n.target,
            html: n.html,
            impact: n.impact ?? null,
            any:
              r.id === 'color-contrast'
                ? n.any
                    .filter((c) => c.id === 'color-contrast')
                    .map((c) => ({ id: c.id, data: c.data as unknown }))
                : [],
          })),
        }));
      return {
        violations: trim(result.violations),
        incomplete: trim(result.incomplete),
        passes: result.passes.map((r) => r.id),
      };
    },
    [context, WCAG_TAGS, SKIPPED_RULES] as const,
  );
}

/** Attaches evidence crops to the worst failures, the first occurrence of each rule first. */
async function withCrops(
  page: Page,
  violations: readonly Occurrence[],
  max: number,
): Promise<Occurrence[]> {
  const order = violations
    .map((o, i) => ({ o, i }))
    .filter(({ o }) => !o.target.includes(' >>> '))
    .sort((a, b) => IMPACT_ORDER[b.o.impact] - IMPACT_ORDER[a.o.impact] || a.i - b.i);
  const seen = new Set<string>();
  const crops = new Map<number, Buffer>();
  for (const { o, i } of order) {
    if (crops.size >= max) break;
    const key = `${o.ruleId}\u0000${o.section ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const crop = await cropOf(page, o.target);
    if (crop !== undefined) crops.set(i, crop);
  }
  return violations.map((o, i) => {
    const crop = crops.get(i);
    return crop === undefined ? o : { ...o, crop };
  });
}

const CUSTOM_CHECKS: readonly ((page: Page) => Promise<CheckResult>)[] = [
  (page) => checkMediaAutoplay(page),
  (page) => checkKeyboard(page),
  (page) => checkFocusNotObscured(page),
  (page) => checkTextSpacing(page),
  (page) => checkReflow(page),
];

function firstLine(text: string): string {
  return (text.split('\n', 1)[0] ?? '').slice(0, 120);
}

function stateResult(outcome: StateOutcome): { result: StateResult; reason: string | undefined } {
  switch (outcome.status) {
    case 'opened':
      return { result: 'opened', reason: undefined };
    case 'not_found':
      return { result: 'not_found', reason: outcome.reason };
    case 'blocked':
      return { result: 'blocked', reason: outcome.guard };
    case 'timed_out':
      return { result: 'timed_out', reason: undefined };
    case 'error':
      return { result: 'error', reason: firstLine(outcome.error).replaceAll(/\s+/g, ' ') };
  }
}

interface Loaded {
  readonly status: number;
  readonly blocked: BlockedReason | undefined;
}

async function load(
  page: Page,
  options: ScanOptions,
  timeout: number,
  quietMs: number,
): Promise<Loaded> {
  let response = await page.goto(options.url, { waitUntil: 'load', timeout });
  if (isPasswordPage(page.url()) && !isPasswordPage(options.url)) {
    if (options.storefrontPassword === undefined || options.storefrontPassword === '') {
      return { status: response?.status() ?? 0, blocked: 'storefront_password' };
    }
    if (!(await unlockStorefront(page, options.storefrontPassword, timeout))) {
      return { status: response?.status() ?? 0, blocked: 'storefront_password' };
    }
    response = await page.goto(options.url, { waitUntil: 'load', timeout });
    if (isPasswordPage(page.url())) {
      return { status: response?.status() ?? 0, blocked: 'storefront_password' };
    }
  }
  await settle(page, quietMs, timeout);
  const status = response?.status() ?? 0;
  const blocked = detectChallenge({
    status,
    title: await page.title(),
    html: await page.content(),
    url: page.url(),
    headers: response?.headers() ?? {},
  });
  return { status, blocked };
}

async function checkState(
  page: Page,
  region: readonly string[] | undefined,
  maxCrops: number,
): Promise<{
  violations: Occurrence[];
  incomplete: Occurrence[];
  rulesRun: string[];
  checksRun: number;
  checksPassed: number;
}> {
  const results =
    region === undefined || region.length === 0
      ? await analyzePage(page)
      : await analyzeRegion(page, region);
  const violations = await withCrops(page, await occurrences(page, results.violations), maxCrops);
  return {
    violations,
    incomplete: await occurrences(page, results.incomplete),
    rulesRun: [
      ...results.violations.map((r) => r.id),
      ...results.incomplete.map((r) => r.id),
      ...results.passes,
    ],
    checksRun: results.violations.length + results.incomplete.length + results.passes.length,
    checksPassed: results.passes.length,
  };
}

/** The custom checks, folded into one state's result. */
async function deepChecks(page: Page): Promise<{
  violations: Occurrence[];
  incomplete: Occurrence[];
  bestPractice: Occurrence[];
  rulesRun: string[];
  checksRun: number;
  checksPassed: number;
}> {
  const findings: PageFinding[] = [];
  let checksRun = 0;
  let checksPassed = 0;
  const rulesRun: string[] = [];
  for (const run of CUSTOM_CHECKS) {
    const result = await run(page).catch(() => undefined);
    if (result === undefined || result.status === 'error') continue;
    // A check that hit its cap looked at only part of the page: it can fail but not pass.
    findings.push(...result.findings);
    checksRun += 1;
    rulesRun.push(`rs-check-${result.check}`);
    if (result.status === 'complete' && result.findings.length === 0) checksPassed += 1;
  }
  return { ...(await fromCustom(page, findings)), rulesRun, checksRun, checksPassed };
}

/** Most link targets collected from one page. */
const MAX_LINKS = 400;

async function linksOf(page: Page): Promise<string[]> {
  return page.evaluate(
    (max) =>
      Array.from(document.querySelectorAll('a[href]'))
        .slice(0, max)
        .map((a) => (a as HTMLAnchorElement).href),
    MAX_LINKS,
  );
}

/**
 * Scans one page. Throws on navigation failure, which the caller retries, and throws
 * {@link ScanDeadlineError} when the scan outlasts `options.deadlineMs` (audit M2): the deadline
 * is a timer in this process, not in the page, so a page that replaces its timers or never
 * returns control cannot hold the engine, and the context is closed to end its renderer.
 */
export async function scanPage(browser: Browser, options: ScanOptions): Promise<PageScan> {
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const open: OpenContext = { expired: false };
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      open.expired = true;
      // Closing the context ends the page and its renderer even while the page's script runs;
      // the scan below then fails on its next call and unwinds.
      void closeWithin(open);
      reject(new ScanDeadlineError(deadlineMs));
    }, deadlineMs);
  });
  const scanning = scanWithin(browser, options, open);
  // If the deadline wins, the scan's own failure (its page was closed under it) is expected.
  scanning.catch(() => undefined);
  try {
    return await Promise.race([scanning, expired]);
  } finally {
    clearTimeout(timer);
    // A scan that outlived the deadline must not leave its context behind, and a context that
    // will not close must not hold this call either.
    await closeWithin(open);
  }
}

/** The context in use, and whether the deadline has passed. */
interface OpenContext {
  context?: BrowserContext;
  expired: boolean;
  /** The one close in progress: Playwright's second `close()` returns before the first ends. */
  closing?: Promise<void>;
}

/** How long a context may take to close before the engine stops waiting for it. */
const CLOSE_GRACE_MS = 5_000;

function closeWithin(open: OpenContext): Promise<void> {
  const { context } = open;
  if (context === undefined) return Promise.resolve();
  open.closing ??= (async () => {
    let grace: NodeJS.Timeout | undefined;
    await Promise.race([
      context.close().catch(() => undefined),
      new Promise<void>((resolve) => {
        grace = setTimeout(resolve, CLOSE_GRACE_MS);
      }),
    ]);
    clearTimeout(grace);
  })();
  return open.closing;
}

async function scanWithin(
  browser: Browser,
  options: ScanOptions,
  open: OpenContext,
): Promise<PageScan> {
  // Through egress, loopback is only reachable if Chromium proxies it (audit L2).
  if (options.proxy !== undefined) assertLoopbackProxied();
  const started = performance.now();
  const timeout = options.timeoutMs ?? 15_000;
  const quietMs = options.quietMs ?? 500;
  const maxCrops = options.maxCrops ?? 8;
  // The default state goes first: the interactive states leave the checkout guard on the context.
  const requested: PageState[] = [...new Set<PageState>(options.states ?? ['default'])].sort(
    (a, b) => Number(b === 'default') - Number(a === 'default'),
  );
  const newContext = async (): Promise<BrowserContext> => {
    const created = await browser.newContext({
      viewport: VIEWPORT_SIZES[options.viewport ?? 'desktop'],
      locale: options.locale ?? 'en',
      timezoneId: 'UTC',
      userAgent: options.userAgent,
      // Service Workers are blocked: the checkout guard of the state scripts relies on it.
      ...scanContextOptions(),
      acceptDownloads: false,
      ...(options.proxy === undefined
        ? {}
        : { proxy: contextProxy(options.proxy.server, options.proxy.token) }),
    });
    // A context created after the deadline is closed at once and the scan stops.
    if (open.expired) {
      await created.close().catch(() => undefined);
      throw new ScanDeadlineError(options.deadlineMs ?? DEFAULT_DEADLINE_MS);
    }
    open.context = created;
    delete open.closing;
    return created;
  };
  let context = await newContext();
  try {
    let page = await context.newPage();
    const loaded = await load(page, options, timeout, quietMs);
    const base = { url: options.url, finalUrl: page.url(), status: loaded.status };
    if (loaded.blocked !== undefined) {
      return {
        ...base,
        blocked: loaded.blocked,
        states: [],
        crops: {},
        durationMs: performance.now() - started,
      };
    }
    const states: StateScan[] = [];
    const crops: Record<string, Buffer> = {};
    const links = options.collectLinks === true ? await linksOf(page) : undefined;
    for (const selector of options.cropSelectors ?? []) {
      const crop = await cropOf(page, selector);
      if (crop !== undefined) crops[selector] = crop;
    }
    for (const state of requested) {
      const stateStarted = performance.now();
      if (state === 'default') {
        const axeResult = await checkState(page, undefined, maxCrops);
        const deep =
          options.deep === true
            ? await deepChecks(page)
            : {
                violations: [],
                incomplete: [],
                bestPractice: [],
                rulesRun: [],
                checksRun: 0,
                checksPassed: 0,
              };
        states.push({
          state,
          result: 'opened',
          reason: undefined,
          violations: [...axeResult.violations, ...deep.violations],
          incomplete: [...axeResult.incomplete, ...deep.incomplete],
          bestPractice: deep.bestPractice,
          rulesRun: [...new Set([...axeResult.rulesRun, ...deep.rulesRun])],
          checksRun: axeResult.checksRun + deep.checksRun,
          checksPassed: axeResult.checksPassed + deep.checksPassed,
          durationMs: performance.now() - stateStarted,
        });
        continue;
      }
      // Each interactive state gets a context of its own: the one before leaves its checkout
      // guard, an open drawer or an item in the cart behind.
      if (states.length > 0) {
        await context.close().catch(() => undefined);
        context = await newContext();
        page = await context.newPage();
        const reloaded = await load(page, options, timeout, quietMs).catch(() => undefined);
        if (reloaded === undefined || reloaded.blocked !== undefined) {
          states.push(emptyState(state, 'error', 'reload_failed', stateStarted));
          continue;
        }
      }
      const outcome = await openState(page, state);
      const { result, reason } = stateResult(outcome);
      if (outcome.status !== 'opened') {
        states.push(emptyState(state, result, reason, stateStarted));
        continue;
      }
      const checked = await checkState(page, outcome.region, maxCrops);
      states.push({
        state,
        result,
        reason,
        ...checked,
        bestPractice: [],
        durationMs: performance.now() - stateStarted,
      });
    }
    return {
      ...base,
      blocked: undefined,
      states,
      crops,
      ...(links === undefined ? {} : { links }),
      durationMs: performance.now() - started,
    };
  } finally {
    await context.close();
  }
}

function emptyState(
  state: PageState,
  result: StateResult,
  reason: string | undefined,
  started: number,
): StateScan {
  return {
    state,
    result,
    reason,
    violations: [],
    incomplete: [],
    bestPractice: [],
    rulesRun: [],
    checksRun: 0,
    checksPassed: 0,
    durationMs: performance.now() - started,
  };
}
