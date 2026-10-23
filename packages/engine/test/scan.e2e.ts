import process from 'node:process';
import { JobFailure, enqueue, runWorker, uuidv7 } from '@rampsmith/queue';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser } from '../src/browser.ts';
import { signScanToken } from '../src/egress-token.ts';
import { scanPage, type PageScan } from '../src/scan-page.ts';
import { scanPageHandler } from '../src/worker.ts';
import { freshDatabase, seed, type TestDatabase } from './db.ts';
import { EGRESS_SECRET, startEgress, type Egress } from './egress.ts';
import { LOCKED_PASSWORD, startSite, type Site } from './site.ts';

const UA = 'RampsmithBot/test (accessibility scanner)';
let browser: Browser;
let site: Site;
let egress: Egress;

beforeAll(async () => {
  const executablePath = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'];
  // The engine's own launch settings; the sandbox is off only because the test runs as root.
  browser = await launchBrowser({
    chromiumSandbox: false,
    ...(executablePath === undefined ? {} : { executablePath }),
  });
  site = await startSite();
  egress = await startEgress(site.port);
});
afterAll(async () => {
  await browser.close();
  await egress.stop();
  await site.close();
});

function token(hosts: string[], budget = 50): string {
  return signScanToken(EGRESS_SECRET, {
    v: 1,
    scan: 'e2e',
    hosts,
    budget,
    exp: Math.floor(Date.now() / 1000) + 60,
  });
}

const defaultState = (scan: PageScan) => {
  const state = scan.states[0];
  if (state === undefined) throw new Error('the page was not checked');
  return state;
};

describe('scanPage', () => {
  it('keeps the section and ancestors of an element inside a form with a field named id', async () => {
    const scan = await scanPage(browser, { url: `${site.origin}/product-form`, userAgent: UA });
    const button = defaultState(scan).violations.find((v) => v.ruleId === 'button-name');
    expect(button?.section).toBe('shopify-section-template--1234__main');
    expect(button?.ancestors?.map((a) => a.tag)).toEqual(['form', 'div']);
  });

  it('finds the known failures, with criteria, section and scrubbed excerpts', async () => {
    const scan = await scanPage(browser, { url: `${site.origin}/`, userAgent: UA });
    expect(scan.blocked).toBeUndefined();
    expect(scan.status).toBe(200);
    const { violations, incomplete } = defaultState(scan);
    const rules = new Set(violations.map((v) => v.ruleId));
    for (const rule of ['image-alt', 'link-name', 'color-contrast']) expect(rules).toContain(rule);
    const image = violations.find((v) => v.ruleId === 'image-alt');
    expect(image?.criteria).toContain('1.1.1');
    expect(image?.impact).toBe('critical');
    expect(image?.section).toBe('shopify-section-template--1234__main');
    // What the code-fix channel needs to find the source again (ADR-296): the ancestors up to
    // the section wrapper, nearest first, and for contrast what axe-core measured.
    expect(image?.ancestors?.at(-1)).toMatchObject({
      tag: 'div',
      attributes: { id: 'shopify-section-template--1234__main' },
    });
    expect(image?.ancestors?.length).toBeLessThanOrEqual(16);
    const contrast = violations.find((v) => v.ruleId === 'color-contrast');
    expect(String(contrast?.evidence?.foreground)).toMatch(/^#[0-9a-f]{6}$/u);
    expect(String(contrast?.evidence?.background)).toMatch(/^#[0-9a-f]{6}$/u);
    expect(contrast?.evidence?.font_size_px).toBeGreaterThan(0);
    for (const v of [...violations, ...incomplete]) {
      expect(v.html).not.toContain('shopper@example.com');
      expect(v.html.length).toBeLessThanOrEqual(512);
    }
  });

  it('finds nothing on a clean page, and counts the checks it ran', async () => {
    const scan = await scanPage(browser, { url: `${site.origin}/clean`, userAgent: UA });
    const state = defaultState(scan);
    expect(state.violations).toEqual([]);
    expect(state.checksRun).toBeGreaterThan(3);
    expect(state.checksPassed).toBe(state.checksRun - state.incomplete.length);
    expect(state.rulesRun).toContain('document-title');
  });

  it('runs target-size (2.5.8), which axe-core disables by default, through the tag set (S-1)', async () => {
    const scan = await scanPage(browser, { url: `${site.origin}/targets`, userAgent: UA });
    const targets = defaultState(scan).violations.filter((v) => v.ruleId === 'target-size');
    expect(targets.map((v) => v.criteria)).toEqual([['2.5.8'], ['2.5.8']]);
  });

  it('reports a bot challenge as blocked and does not scan it', async () => {
    const scan = await scanPage(browser, { url: `${site.origin}/challenge`, userAgent: UA });
    expect(scan.blocked).toBe('cloudflare');
    expect(scan.states).toEqual([]);
  });

  it('goes through egress, which carries only the hosts on the token', async () => {
    const before = site.requests.length;
    const through = await scanPage(browser, {
      url: `${site.origin}/`,
      userAgent: UA,
      proxy: { server: egress.url, token: token(['127.0.0.1']) },
    });
    expect(defaultState(through).violations.map((v) => v.ruleId)).toContain('image-alt');
    expect(site.requests.length).toBeGreaterThan(before);

    // A token for another host: egress answers 403 itself and the site never sees the request,
    // which also proves the browser's traffic really goes through egress.
    const seen = site.requests.length;
    const refused = await scanPage(browser, {
      url: `${site.origin}/clean`,
      userAgent: UA,
      proxy: { server: egress.url, token: token(['shop.example']) },
    });
    expect(refused.status).toBe(403);
    expect(site.requests.length).toBe(seen);
  });

  it('attaches a PNG crop of the worst failures, small enough for the evidence table', async () => {
    const scan = await scanPage(browser, { url: `${site.origin}/`, userAgent: UA });
    const cropped = defaultState(scan).violations.filter((v) => v.crop !== undefined);
    expect(cropped.length).toBeGreaterThan(0);
    for (const v of cropped) {
      const png = v.crop ?? Buffer.alloc(0);
      expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      expect(png.length).toBeLessThanOrEqual(65_536);
    }
    // One crop per rule and section, at most `maxCrops` in all.
    const few = await scanPage(browser, { url: `${site.origin}/`, userAgent: UA, maxCrops: 1 });
    expect(defaultState(few).violations.filter((v) => v.crop !== undefined)).toHaveLength(1);
  });

  it('crops the selectors it is asked for', async () => {
    const scan = await scanPage(browser, {
      url: `${site.origin}/`,
      userAgent: UA,
      cropSelectors: ['h1', '#missing'],
    });
    expect(Object.keys(scan.crops)).toEqual(['h1']);
  });
});

describe('the four interactive states', () => {
  const STATES = ['default', 'nav_open', 'cart_drawer', 'variant_changed', 'modal'] as const;

  it('opens each state and checks the region it changed, finding what only that state shows', async () => {
    const before = site.requests.length;
    const scan = await scanPage(browser, {
      url: `${site.origin}/storefront`,
      userAgent: UA,
      states: STATES,
      proxy: { server: egress.url, token: token(['127.0.0.1']) },
    });
    expect(scan.blocked).toBeUndefined();
    expect(scan.states.map((s) => [s.state, s.result, s.reason])).toEqual(
      STATES.map((s) => [s, 'opened', undefined]),
    );
    const rules = (state: (typeof STATES)[number]) =>
      new Set(scan.states.find((s) => s.state === state)?.violations.map((v) => v.ruleId));

    // The seeded failures sit in closed or hidden parts, so the default state cannot see them.
    expect(rules('default')).not.toContain('link-name');
    expect(rules('default')).not.toContain('button-name');
    expect(rules('default')).not.toContain('label');
    expect(rules('nav_open')).toContain('link-name');
    expect(rules('cart_drawer')).toContain('button-name');
    expect(rules('modal')).toContain('label');
    expect(rules('variant_changed')).toContain('color-contrast');

    // Each interactive check is scoped to the region the script returned.
    const nav = scan.states.find((s) => s.state === 'nav_open');
    expect(nav?.violations.some((v) => v.target.includes('seed-nav-link'))).toBe(true);
    expect(nav?.violations.some((v) => v.target.includes('seed-drawer-button'))).toBe(false);

    // Add-to-cart ran; checkout was never touched.
    expect(site.requests.slice(before)).toContain('/cart/add.js');
    expect(site.requests.slice(before).some((r) => r.includes('checkout'))).toBe(false);
  });

  it('reports a state the page does not have as not found, with the reason', async () => {
    const scan = await scanPage(browser, {
      url: `${site.origin}/clean`,
      userAgent: UA,
      states: ['default', 'nav_open', 'cart_drawer', 'variant_changed', 'modal'],
    });
    expect(scan.states.map((s) => [s.state, s.result, s.reason])).toEqual([
      ['default', 'opened', undefined],
      ['nav_open', 'not_found', 'no_trigger'],
      ['cart_drawer', 'not_found', 'no_product_form'],
      ['variant_changed', 'not_found', 'no_variant_picker'],
      ['modal', 'not_found', 'no_trigger'],
    ]);
    for (const state of scan.states.slice(1)) expect(state.violations).toEqual([]);
  });

  it('stops a state script that would reach checkout, and says why', async () => {
    const scan = await scanPage(browser, {
      url: `${site.origin}/fixtures/guard-checkout.html`,
      userAgent: UA,
      states: ['default', 'cart_drawer'],
    });
    const cart = scan.states.find((s) => s.state === 'cart_drawer');
    expect(cart?.result).toBe('blocked');
    expect(cart?.reason).toBe('checkout');
    expect(site.requests.some((r) => r.includes('/checkouts/'))).toBe(false);
  });
});

describe('the custom browser checks', () => {
  it('runs them on a deep page: keyboard, reflow and the rest report what axe-core cannot', async () => {
    const reflow = await scanPage(browser, {
      url: `${site.origin}/fixtures/seeded-reflow.html`,
      userAgent: UA,
      deep: true,
    });
    const state = defaultState(reflow);
    expect(state.violations.map((v) => v.ruleId)).toContain('rs-reflow-horizontal-scroll');
    const hit = state.violations.find((v) => v.ruleId === 'rs-reflow-horizontal-scroll');
    expect(hit?.criteria).toEqual(['1.4.10']);
    expect(hit?.help).toMatch(/horizontal scrolling/);
    expect(state.rulesRun).toEqual(
      expect.arrayContaining(['rs-check-reflow', 'rs-check-keyboard']),
    );

    const keyboard = await scanPage(browser, {
      url: `${site.origin}/fixtures/seeded-keyboard.html`,
      userAgent: UA,
      deep: true,
    });
    const rules = defaultState(keyboard).violations.map((v) => v.ruleId);
    expect(rules).toEqual(expect.arrayContaining(['rs-keyboard-trap']));
  });

  it('runs none of them on an ordinary page', async () => {
    const scan = await scanPage(browser, {
      url: `${site.origin}/fixtures/seeded-reflow.html`,
      userAgent: UA,
    });
    expect(defaultState(scan).violations.map((v) => v.ruleId)).not.toContain(
      'rs-reflow-horizontal-scroll',
    );
  });
});

describe('a password-protected storefront', () => {
  it('is reported as blocked when no password is supplied, and checked with the right one', async () => {
    const closed = await scanPage(browser, { url: `${site.origin}/locked/`, userAgent: UA });
    expect(closed.blocked).toBe('storefront_password');
    expect(closed.states).toEqual([]);

    const wrong = await scanPage(browser, {
      url: `${site.origin}/locked/`,
      userAgent: UA,
      storefrontPassword: 'nope',
    });
    expect(wrong.blocked).toBe('storefront_password');

    const open = await scanPage(browser, {
      url: `${site.origin}/locked/`,
      userAgent: UA,
      storefrontPassword: LOCKED_PASSWORD,
    });
    expect(open.blocked).toBeUndefined();
    expect(defaultState(open).violations.map((v) => v.ruleId)).toContain('image-alt');
  });
});

describe('the scan.page@2 worker', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await freshDatabase();
  });
  afterAll(async () => {
    await db.drop();
  });

  const BASE = () => site.origin.replace('http:', 'https:');

  function handler(sql: ReturnType<TestDatabase['as']>) {
    return scanPageHandler({
      sql,
      browser,
      egress: { proxyUrl: egress.url, tokenSecret: EGRESS_SECRET },
      userAgent: UA,
      // The fixture site speaks HTTP; the plan, like a store's, says https.
      rewriteUrl: (url) => new URL(url.href.replace('https:', 'http:')),
    });
  }

  async function runJob(tenantId: string, payload: Record<string, unknown>) {
    const sql = db.as('rampsmith_worker');
    const enqueued = await enqueue(sql, {
      queue: 'scan.page',
      payloadSchema: 'scan.page@2',
      payload: payload as Parameters<typeof enqueue>[1]['payload'],
      tenantId,
      maxAttempts: 1,
    });
    if (!enqueued.created) throw new Error('job was not created');
    const jobId = enqueued.id;
    const stop = new AbortController();
    const done = runWorker({
      sql,
      queue: 'scan.page',
      workerId: 'engine-e2e',
      pollMs: 100,
      signal: stop.signal,
      handler: handler(sql),
    });
    let state = 'ready';
    for (let i = 0; i < 300 && (state === 'ready' || state === 'running'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const [row] = await db.owner<{ state: string }[]>`select state from jobs where id = ${jobId}`;
      state = row?.state ?? 'missing';
    }
    stop.abort();
    await done;
    const [job] = await db.owner<{ state: string; last_error: { code: string } | null }[]>`
      select state, last_error from jobs where id = ${jobId}`;
    return job;
  }

  const page = (f: { scanId: string; siteId: string }, over: Record<string, unknown> = {}) => ({
    scan_id: f.scanId,
    site_id: f.siteId,
    seq: 0,
    page_type: 'home',
    url: `${BASE()}/`,
    viewport: 'desktop',
    states: ['default'],
    ...over,
  });

  it('scans a verified site through egress, records its findings, and queues the finalisation', async () => {
    const f = await seed(db.owner, BASE(), { pages: 1 });
    const job = await runJob(f.tenantId, page(f));
    expect(job?.state).toBe('succeeded');
    const findings = await db.owner<{ rule_id: string; fix_kind: string }[]>`
      select rule_id, fix_kind from findings where site_id = ${f.siteId} order by rule_id`;
    expect(findings.map((r) => r.rule_id)).toEqual(
      expect.arrayContaining(['color-contrast', 'image-alt', 'link-name']),
    );
    expect(findings.every((r) => r.fix_kind === 'code')).toBe(true);
    const [row] = await db.owner<{ page_type: string; viewport: string; state_outcome: string }[]>`
      select page_type, viewport, state_outcome from scan_pages where scan_id = ${f.scanId}`;
    expect(row).toEqual({ page_type: 'home', viewport: 'desktop', state_outcome: 'opened' });
    const evidence = await db.owner<{ n: number }[]>`
      select count(*)::int as n from evidence where scan_id = ${f.scanId}`;
    expect(evidence[0]?.n).toBeGreaterThan(0);
    const finalize = await db.owner<{ n: number }[]>`
      select count(*)::int as n from jobs where queue = 'scan.finalize' and payload ->> 'scan_id' = ${f.scanId}`;
    expect(finalize[0]?.n).toBe(1);
  });

  it('records the same URL at two viewports, once each', async () => {
    const f = await seed(db.owner, BASE(), { pages: 2 });
    expect((await runJob(f.tenantId, page(f, { seq: 0 })))?.state).toBe('succeeded');
    expect((await runJob(f.tenantId, page(f, { seq: 1, viewport: 'mobile' })))?.state).toBe(
      'succeeded',
    );
    const rows = await db.owner<{ viewport: string }[]>`
      select viewport from scan_pages where scan_id = ${f.scanId} order by viewport`;
    expect(rows.map((r) => r.viewport)).toEqual(['desktop', 'mobile']);
  });

  it('refuses unverified sites and pages off the site, permanently', async () => {
    const unverified = await seed(db.owner, BASE(), { verified: false });
    const job = await runJob(unverified.tenantId, page(unverified));
    expect(job?.state).toBe('dead');
    expect(job?.last_error?.code).toBe('site_not_verified');

    const verified = await seed(db.owner, BASE());
    const off = await runJob(verified.tenantId, page(verified, { url: 'https://127.0.0.2:9/' }));
    expect(off?.state).toBe('dead');
    expect(off?.last_error?.code).toBe('url_off_site');
  });

  it('rejects malformed payloads permanently', async () => {
    const sql = db.as('rampsmith_worker');
    const run = handler(sql);
    const results = await Promise.all(
      [
        { payloadSchema: 'scan.page@2', payload: {}, tenantId: uuidv7() },
        { payloadSchema: 'scan.page@1', payload: { scan_id: 'x' }, tenantId: uuidv7() },
        {
          payloadSchema: 'scan.page@2',
          payload: { ...page({ scanId: uuidv7(), siteId: uuidv7() }), extra: 1 },
          tenantId: uuidv7(),
        },
      ].map((job) => run(job).catch((e: unknown) => e)),
    );
    for (const error of results) {
      expect(error).toBeInstanceOf(JobFailure);
      expect((error as JobFailure).failure.kind).toBe('permanent');
    }
  });

  it('opens a protected store with the password the deployment supplies', async () => {
    const f = await seed(db.owner, BASE(), { pages: 1 });
    const sql = db.as('rampsmith_worker');
    const supplied = scanPageHandler({
      sql,
      browser,
      egress: { proxyUrl: egress.url, tokenSecret: EGRESS_SECRET },
      userAgent: UA,
      rewriteUrl: (url) => new URL(url.href.replace('https:', 'http:')),
      storefrontPassword: () => Promise.resolve(LOCKED_PASSWORD),
    });
    await supplied({
      payloadSchema: 'scan.page@2',
      payload: page(f, { url: `${BASE()}/locked/` }),
      tenantId: f.tenantId,
    });
    const [row] = await db.owner<{ blocked_reason: string | null; violations: number }[]>`
      select blocked_reason, violations from scan_pages where scan_id = ${f.scanId}`;
    expect(row).toEqual({ blocked_reason: null, violations: expect.any(Number) as number });
  });

  it('records a closed store as blocked, never storing the page', async () => {
    const f = await seed(db.owner, BASE(), { pages: 1 });
    await runJob(f.tenantId, page(f, { url: `${BASE()}/locked/` }));
    const [row] = await db.owner<{ blocked_reason: string; checks_run: number }[]>`
      select blocked_reason, checks_run from scan_pages where scan_id = ${f.scanId}`;
    expect(row).toEqual({ blocked_reason: 'storefront_password', checks_run: 0 });
  });
});
