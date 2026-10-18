#!/usr/bin/env node
/**
 * Spike S-1 (PLAN §11): the axe-core 4.14 tag set, and how `target-size` (2.5.8) behaves on
 * Shopify's Dawn demo store. Three pages (home, a collection, a product) at one mobile
 * viewport, inside the free scanner's limits. Prints one JSON document.
 */
import process from 'node:process';
import { AxeBuilder } from '@axe-core/playwright';
import axe from 'axe-core';
import { detectChallenge } from '../src/challenge.ts';
import { WCAG_TAGS, settle } from '../src/scan-page.ts';
import { scrubExcerpt } from '../src/scrub.ts';
import { UA, checkRobots, keepOnSite, launch, sleep } from './shared.ts';

const FALLBACK = 'https://theme-dawn-demo.myshopify.com/';
const VIEWPORT = { width: 390, height: 844 };

/** The demo store the theme store's preview opens, read from the preview page itself. */
async function demoStore(): Promise<{ url: string; source: string }> {
  const preview = 'https://themes.shopify.com/themes/dawn/styles/default/preview';
  try {
    const res = await fetch(preview, {
      headers: { 'user-agent': UA },
      signal: AbortSignal.timeout(15_000),
    });
    const match = /https:\/\/[a-z0-9-]+\.myshopify\.com/.exec(await res.text());
    if (match !== null) return { url: `${match[0]}/`, source: preview };
  } catch {
    // Fall through to the known demo host.
  }
  return { url: FALLBACK, source: 'fallback' };
}

interface AxeEntry {
  readonly id: string;
  readonly nodes: readonly {
    target: unknown;
    html: string;
    failureSummary?: string | undefined;
  }[];
}

function summarize(entry: AxeEntry | undefined) {
  if (entry === undefined) return { nodes: 0, examples: [] };
  return {
    nodes: entry.nodes.length,
    examples: entry.nodes.slice(0, 15).map((n) => ({
      target: Array.isArray(n.target) ? n.target.map(String).join(' >>> ') : String(n.target),
      html: scrubExcerpt(n.html).slice(0, 200),
      summary: n.failureSummary?.replace(/\s+/g, ' ').slice(0, 300),
    })),
  };
}

const selected = axe.getRules([...WCAG_TAGS]);
const tagSet = {
  axeVersion: axe.version,
  tags: WCAG_TAGS,
  rulesTotal: axe.getRules().length,
  rulesSelected: selected.length,
  perTag: Object.fromEntries(WCAG_TAGS.map((t) => [t, axe.getRules([t]).map((r) => r.ruleId)])),
  targetSize: axe.getRules().find((r) => r.ruleId === 'target-size'),
};

const store = await demoStore();
const robots = await checkRobots(store.url);
const pages: unknown[] = [];
if (robots.allowed) {
  const browser = await launch();
  const context = await browser.newContext({
    viewport: VIEWPORT,
    userAgent: UA,
    locale: 'en',
    timezoneId: 'UTC',
    serviceWorkers: 'block',
  });
  await keepOnSite(context, new URL(store.url).hostname);
  const queue: string[] = [store.url];
  const visited = new Set<string>();
  while (queue.length > 0 && visited.size < 3) {
    const url = queue.shift();
    if (url === undefined || visited.has(url)) continue;
    visited.add(url);
    const page = await context.newPage();
    const started = performance.now();
    const response = await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
    await settle(page, 500, 10_000);
    const status = response?.status() ?? 0;
    const blocked = detectChallenge({
      status,
      title: await page.title(),
      html: await page.content(),
      url: page.url(),
      headers: response?.headers() ?? {},
    });
    if (visited.size === 1) {
      const links = await page.evaluate(() => {
        const pick = (part: string) =>
          [...document.querySelectorAll<HTMLAnchorElement>(`a[href*="${part}"]`)]
            .map((a) => a.href)
            .find((href) => !href.endsWith('/collections/all'));
        return [pick('/collections/'), pick('/products/')];
      });
      for (const link of links) if (link !== undefined) queue.push(link.split('?')[0] ?? link);
    }
    if (blocked !== undefined) {
      pages.push({ url, status, blocked });
    } else {
      const results = await new AxeBuilder({ page }).withTags([...WCAG_TAGS]).analyze();
      const ran = new Set(
        [
          ...results.passes,
          ...results.violations,
          ...results.incomplete,
          ...results.inapplicable,
        ].map((r) => r.id),
      );
      const find = (list: readonly AxeEntry[]) => list.find((r) => r.id === 'target-size');
      pages.push({
        url,
        status,
        durationMs: Math.round(performance.now() - started),
        rulesRun: ran.size,
        targetSizeRan: ran.has('target-size'),
        targetSize: {
          violations: summarize(find(results.violations)),
          incomplete: summarize(find(results.incomplete)),
          passes: summarize(find(results.passes)).nodes,
        },
        violationsByRule: Object.fromEntries(results.violations.map((r) => [r.id, r.nodes.length])),
      });
    }
    await page.close();
    await sleep(1_000);
  }
  await browser.close();
}

process.stdout.write(
  `${JSON.stringify(
    {
      spike: 'S-1',
      at: new Date().toISOString(),
      userAgent: UA,
      viewport: VIEWPORT,
      tagSet,
      store,
      robots: { status: robots.response?.status, allowed: robots.allowed },
      pages,
    },
    null,
    2,
  )}\n`,
);
