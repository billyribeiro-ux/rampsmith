import process from 'node:process';
import { JobFailure, enqueue, runWorker, uuidv7 } from '@rampsmith/queue';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser } from '../src/browser.ts';
import { signScanToken } from '../src/egress-token.ts';
import { scanPage } from '../src/scan-page.ts';
import { scanPageHandler } from '../src/worker.ts';
import { freshDatabase, seed, type TestDatabase } from './db.ts';
import { EGRESS_SECRET, startEgress, type Egress } from './egress.ts';
import { startSite, type Site } from './site.ts';

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

describe('scanPage', () => {
  it('finds the known failures, with criteria, section and scrubbed excerpts', async () => {
    const scan = await scanPage(browser, { url: `${site.origin}/`, userAgent: UA });
    expect(scan.blocked).toBeUndefined();
    expect(scan.status).toBe(200);
    const rules = new Set(scan.violations.map((v) => v.ruleId));
    for (const rule of ['image-alt', 'link-name', 'color-contrast']) expect(rules).toContain(rule);
    const image = scan.violations.find((v) => v.ruleId === 'image-alt');
    expect(image?.criteria).toContain('1.1.1');
    expect(image?.impact).toBe('critical');
    expect(image?.section).toBe('shopify-section-template--1234__main');
    for (const v of [...scan.violations, ...scan.incomplete]) {
      expect(v.html).not.toContain('shopper@example.com');
      expect(v.html.length).toBeLessThanOrEqual(512);
    }
  });

  it('finds nothing on a clean page', async () => {
    const scan = await scanPage(browser, { url: `${site.origin}/clean`, userAgent: UA });
    expect(scan.violations).toEqual([]);
  });

  it('runs target-size (2.5.8), which axe-core disables by default, through the tag set (S-1)', async () => {
    const scan = await scanPage(browser, { url: `${site.origin}/targets`, userAgent: UA });
    const targets = scan.violations.filter((v) => v.ruleId === 'target-size');
    expect(targets.map((v) => v.criteria)).toEqual([['2.5.8'], ['2.5.8']]);
  });

  it('reports a bot challenge as blocked and does not scan it', async () => {
    const scan = await scanPage(browser, { url: `${site.origin}/challenge`, userAgent: UA });
    expect(scan.blocked).toBe('cloudflare');
    expect(scan.violations).toEqual([]);
  });

  it('goes through egress, which carries only the hosts on the token', async () => {
    const before = site.requests.length;
    const through = await scanPage(browser, {
      url: `${site.origin}/`,
      userAgent: UA,
      proxy: { server: egress.url, token: token(['127.0.0.1']) },
    });
    expect(through.violations.map((v) => v.ruleId)).toContain('image-alt');
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
});

describe('the scan.page worker', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await freshDatabase();
  });
  afterAll(async () => {
    await db.drop();
  });

  async function runJob(tenantId: string, payload: Record<string, unknown>) {
    const sql = db.as('rampsmith_worker');
    const enqueued = await enqueue(sql, {
      queue: 'scan.page',
      payloadSchema: 'scan.page@1',
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
      handler: scanPageHandler({
        sql,
        browser,
        egress: { proxyUrl: egress.url, tokenSecret: EGRESS_SECRET },
        userAgent: UA,
      }),
    });
    let state = 'ready';
    for (let i = 0; i < 200 && (state === 'ready' || state === 'running'); i += 1) {
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

  it('scans a verified site through egress and records its findings', async () => {
    const f = await seed(db.owner, site.origin.replace('http:', 'https:'), { pages: 1 });
    const job = await runJob(f.tenantId, {
      scan_id: f.scanId,
      site_id: f.siteId,
      url: `${site.origin}/`,
    });
    expect(job?.state).toBe('succeeded');
    const findings = await db.owner<{ rule_id: string }[]>`
      select rule_id from findings where site_id = ${f.siteId} order by rule_id`;
    expect(findings.map((r) => r.rule_id)).toEqual(
      expect.arrayContaining(['color-contrast', 'image-alt', 'link-name']),
    );
    const [scan] = await db.owner<
      { status: string }[]
    >`select status from scans where id = ${f.scanId}`;
    expect(scan?.status).toBe('succeeded');
  });

  it('refuses unverified sites and pages off the site, permanently', async () => {
    const unverified = await seed(db.owner, site.origin.replace('http:', 'https:'), {
      verified: false,
    });
    const job = await runJob(unverified.tenantId, {
      scan_id: unverified.scanId,
      site_id: unverified.siteId,
      url: `${site.origin}/`,
    });
    expect(job?.state).toBe('dead');
    expect(job?.last_error?.code).toBe('site_not_verified');

    const verified = await seed(db.owner, site.origin.replace('http:', 'https:'));
    const off = await runJob(verified.tenantId, {
      scan_id: verified.scanId,
      site_id: verified.siteId,
      url: 'http://127.0.0.2:9/',
    });
    expect(off?.state).toBe('dead');
    expect(off?.last_error?.code).toBe('url_off_site');
  });

  it('rejects malformed payloads permanently', () => {
    const handler = scanPageHandler({
      sql: db.owner,
      browser,
      egress: { proxyUrl: egress.url, tokenSecret: EGRESS_SECRET },
      userAgent: UA,
    });
    return Promise.all(
      [
        { payloadSchema: 'scan.page@2', payload: {}, tenantId: uuidv7() },
        { payloadSchema: 'scan.page@1', payload: { scan_id: 'x' }, tenantId: uuidv7() },
        {
          payloadSchema: 'scan.page@1',
          payload: { scan_id: uuidv7(), site_id: uuidv7(), url: 'u', extra: 1 },
          tenantId: uuidv7(),
        },
      ].map(async (job) => {
        const error: unknown = await handler(job).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(JobFailure);
        expect((error as JobFailure).failure.kind).toBe('permanent');
      }),
    );
  });
});
