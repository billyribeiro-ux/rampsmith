/**
 * Loads one page in a fresh Chromium context and runs axe-core on it (PLAN §11, render audit
 * steps 2–4). All traffic goes through egress when a proxy is given.
 */
import { AxeBuilder } from '@axe-core/playwright';
import axe from 'axe-core';
import type { Browser, Page } from 'playwright';
import { detectChallenge, type Challenge } from './challenge.ts';
import { scrubExcerpt } from './scrub.ts';
import { criteriaFromTags } from './wcag.ts';

/** Only WCAG A and AA rules count as failures (PLAN §11 step 4). */
export const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] as const;

export const AXE_VERSION = axe.version;

export type Impact = 'minor' | 'moderate' | 'serious' | 'critical';

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
}

export interface PageScan {
  readonly url: string;
  readonly finalUrl: string;
  readonly status: number;
  /** Set when a bot challenge answered instead of the store: nothing was checked. */
  readonly blocked: Challenge | undefined;
  readonly violations: readonly Occurrence[];
  /** Axe could not decide these; they go to review, never counted as failures. */
  readonly incomplete: readonly Occurrence[];
  readonly durationMs: number;
}

export interface ScanOptions {
  readonly url: string;
  /** egress, with the scan token as the proxy password (ADR-025). */
  readonly proxy?: { readonly server: string; readonly token: string; readonly loopback?: boolean };
  readonly viewport?: { readonly width: number; readonly height: number };
  readonly locale?: string;
  readonly userAgent: string;
  /** Navigation and settle budget. Default 15 seconds. */
  readonly timeoutMs?: number;
  /** How long the DOM must stay unchanged. Default 500 ms. */
  readonly quietMs?: number;
}

const IMPACTS = new Set<string>(['minor', 'moderate', 'serious', 'critical']);

/** Waits until the DOM has been quiet for `quietMs`, at most `capMs`. */
async function settle(page: Page, quietMs: number, capMs: number): Promise<void> {
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

async function occurrences(page: Page, rules: readonly AxeRule[]): Promise<Occurrence[]> {
  const flat = rules.flatMap((rule) => rule.nodes.map((node) => ({ rule, node })));
  const selectors = flat.map(({ node }) =>
    Array.isArray(node.target) && node.target.length === 1 ? String(node.target[0]) : '',
  );
  const sections = await page.evaluate(
    (list) =>
      list.map((selector) => {
        if (selector === '') return null;
        try {
          return document.querySelector(selector)?.closest('[id^="shopify-section-"]')?.id ?? null;
        } catch {
          return null;
        }
      }),
    selectors,
  );
  return flat.map(({ rule, node }, i) => {
    const impact = node.impact ?? rule.impact ?? 'moderate';
    return {
      ruleId: rule.id,
      impact: IMPACTS.has(impact) ? (impact as Impact) : 'moderate',
      criteria: criteriaFromTags(rule.tags),
      help: rule.help,
      target: selectorOf(node.target),
      html: scrubExcerpt(node.html),
      section: sections[i] ?? undefined,
    };
  });
}

/** Scans one page. Throws on navigation failure, which the caller retries. */
export async function scanPage(browser: Browser, options: ScanOptions): Promise<PageScan> {
  const started = performance.now();
  const timeout = options.timeoutMs ?? 15_000;
  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 1280, height: 800 },
    locale: options.locale ?? 'en',
    timezoneId: 'UTC',
    userAgent: options.userAgent,
    serviceWorkers: 'block',
    acceptDownloads: false,
    ...(options.proxy === undefined
      ? {}
      : {
          proxy: {
            server: options.proxy.server,
            username: 'rampsmith',
            password: options.proxy.token,
            // Chromium skips the proxy for loopback unless told otherwise (tests only).
            ...(options.proxy.loopback === true ? { bypass: '<-loopback>' } : {}),
          },
        }),
  });
  try {
    const page = await context.newPage();
    const response = await page.goto(options.url, { waitUntil: 'load', timeout });
    await settle(page, options.quietMs ?? 500, timeout);
    const status = response?.status() ?? 0;
    const blocked = detectChallenge({
      status,
      title: await page.title(),
      html: (await page.content()).slice(0, 200_000),
    });
    const base = { url: options.url, finalUrl: page.url(), status, blocked };
    if (blocked !== undefined) {
      return { ...base, violations: [], incomplete: [], durationMs: performance.now() - started };
    }
    const results = await new AxeBuilder({ page }).withTags([...WCAG_TAGS]).analyze();
    return {
      ...base,
      violations: await occurrences(page, results.violations),
      incomplete: await occurrences(page, results.incomplete),
      durationMs: performance.now() - started,
    };
  } finally {
    await context.close();
  }
}
