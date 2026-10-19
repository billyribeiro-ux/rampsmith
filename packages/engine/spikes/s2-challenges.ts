#!/usr/bin/env node
/**
 * Spike S-2 (PLAN §11): the bot-challenge rate for headless Chromium across 50 public Shopify
 * stores. Each candidate gets one robots.txt fetch; a store confirmed as Shopify whose
 * robots.txt allows `/` gets its home page loaded once, with the identified user agent, one
 * store at a time. Challenges are recorded, never retried or evaded.
 *
 * Output is one JSON document. Rampsmith does not publish anyone's accessibility failures
 * (PLAN §16), so per-store rows carry only identity, robots and challenge signals; violation
 * counts appear only as aggregates across all stores.
 */
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { AxeBuilder } from '@axe-core/playwright';
import { detectChallenge } from '../src/challenge.ts';
import { WCAG_TAGS, settle } from '../src/scan-page.ts';
import { UA, checkRobots, keepOnSite, launch, onSite, percentile, sleep } from './shared.ts';

const TARGET = Number(process.env['S2_STORES'] ?? '50');
const candidates = readFileSync(new URL('./stores.txt', import.meta.url), 'utf8')
  .split('\n')
  .map((l) => l.replace(/#.*$/, '').trim())
  .filter((l) => l !== '');

const SHOPIFY_ROBOTS = 'we use shopify as our ecommerce platform';

interface Row {
  domain: string;
  shopify: 'robots' | 'header' | 'page' | 'no' | 'unknown';
  robots: number | 'unreachable';
  robotsAllowed: boolean;
  robotsCfMitigated?: string;
  status?: number;
  finalHost?: string;
  verdict?: string | undefined;
  signals?: Record<string, boolean | string>;
  durationMs?: number;
  error?: string;
}

const rows: Row[] = [];
const violationTotals: number[] = [];
const ruleStores = new Map<string, number>();
const browser = await launch();

for (const domain of candidates) {
  if (rows.filter((r) => r.status !== undefined || r.error !== undefined).length >= TARGET) break;
  const origin = `https://${domain}`;
  const robots = await checkRobots(origin);
  const headers = robots.headers;
  const row: Row = {
    domain,
    shopify: 'unknown',
    robots: robots.response?.status ?? 'unreachable',
    robotsAllowed: robots.allowed,
  };
  const cf = headers?.get('cf-mitigated');
  if (cf !== null && cf !== undefined) row.robotsCfMitigated = cf;
  if (robots.response?.text.toLowerCase().includes(SHOPIFY_ROBOTS) === true) row.shopify = 'robots';
  else if (
    headers?.get('powered-by')?.toLowerCase().includes('shopify') === true ||
    headers?.has('x-shopid') === true
  ) {
    row.shopify = 'header';
  } else if (robots.response?.status === 200) row.shopify = 'no';
  rows.push(row);
  // Only confirmed Shopify stores whose robots.txt allows the home page are loaded.
  if ((row.shopify !== 'robots' && row.shopify !== 'header') || !robots.allowed) continue;

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: UA,
    locale: 'en',
    timezoneId: 'UTC',
    serviceWorkers: 'block',
  });
  await keepOnSite(context, domain);
  try {
    const page = await context.newPage();
    const started = performance.now();
    const response = await page.goto(origin, { waitUntil: 'load', timeout: 30_000 });
    await settle(page, 500, 10_000);
    const status = response?.status() ?? 0;
    const title = await page.title();
    const html = await page.content();
    const lower = html.toLowerCase();
    const finalUrl = new URL(page.url());
    row.status = status;
    row.finalHost = finalUrl.host;
    row.verdict = detectChallenge({
      status,
      title,
      html,
      url: page.url(),
      headers: response?.headers() ?? {},
    });
    row.signals = {
      cfMitigated: response?.headers()['cf-mitigated'] ?? '',
      cfChl: lower.includes('cf-chl'),
      cfTitle: /^(just a moment|attention required)/i.test(title.trim()),
      recaptcha: lower.includes('/recaptcha/'),
      hcaptcha: lower.includes('h-captcha') || lower.includes('hcaptcha.com'),
      turnstile: lower.includes('challenges.cloudflare.com/turnstile'),
      challengePath: finalUrl.pathname.startsWith('/challenge'),
      passwordPage: finalUrl.pathname.startsWith('/password'),
      storefront: lower.includes('shopify.shop') || lower.includes('shopify-section'),
      status429: status === 429,
      links: String(html.match(/<a\s[^>]*href=/gi)?.length ?? 0),
    };
    // A navigation that tried to leave the store ends on Chrome's error page: nothing to scan.
    if (!onSite(finalUrl.hostname, domain)) {
      row.error = 'navigation left the store and was blocked';
    } else if (row.verdict === undefined && status < 400) {
      const results = await new AxeBuilder({ page }).withTags([...WCAG_TAGS]).analyze();
      violationTotals.push(results.violations.reduce((n, r) => n + r.nodes.length, 0));
      for (const r of results.violations) ruleStores.set(r.id, (ruleStores.get(r.id) ?? 0) + 1);
    }
    row.durationMs = Math.round(performance.now() - started);
  } catch (error) {
    row.error = (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '';
  } finally {
    await context.close();
  }
  await sleep(1_000);
}
await browser.close();

const loaded = rows.filter((r) => r.status !== undefined);
const challenged = loaded.filter((r) => r.verdict !== undefined);
const durations = loaded.flatMap((r) => (r.durationMs === undefined ? [] : [r.durationMs]));
process.stdout.write(
  `${JSON.stringify(
    {
      spike: 'S-2',
      at: new Date().toISOString(),
      userAgent: UA,
      candidates: rows.length,
      confirmedShopify: rows.filter((r) => r.shopify === 'robots' || r.shopify === 'header').length,
      robotsDisallowed: rows.filter(
        (r) => (r.shopify === 'robots' || r.shopify === 'header') && !r.robotsAllowed,
      ).length,
      loaded: loaded.length,
      errors: rows.filter((r) => r.error !== undefined).length,
      challengedByDetector: challenged.length,
      challengeRate: loaded.length === 0 ? null : challenged.length / loaded.length,
      durationMs: {
        p50: percentile(durations, 50),
        p95: percentile(durations, 95),
        max: percentile(durations, 100),
      },
      aggregateViolations: {
        storesScanned: violationTotals.length,
        nodesP50: percentile(violationTotals, 50),
        nodesP95: percentile(violationTotals, 95),
        storesPerRule: Object.fromEntries([...ruleStores].sort((a, b) => b[1] - a[1])),
      },
      rows,
    },
    null,
    2,
  )}\n`,
);
