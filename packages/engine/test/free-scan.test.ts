import { uuidv7, type ClaimedJob } from '@rampsmith/queue';
import type postgres from 'postgres';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  aggregate,
  chooseLinks,
  freeScanHandler,
  hostsFor,
  robotsVerdict,
  summarise,
  type PageSummary,
} from '../src/free-scan.ts';
import type { Occurrence, PageScan, ScanOptions } from '../src/scan-page.ts';
import { freshDatabase, type TestDatabase } from './db.ts';

function occurrence(ruleId: string, html: string, criteria = ['1.1.1']): Occurrence {
  return {
    ruleId,
    impact: 'serious',
    criteria,
    help: `Help for ${ruleId}`,
    target: 'img',
    html,
    section: undefined,
  };
}

function page(url: string, violations: Occurrence[], rulesRun: string[]): PageSummary {
  return { url, violations, incomplete: [], rulesRun };
}

describe('choosing the pages to scan beside the home page', () => {
  const home = new URL('https://shop.com/');

  it('picks two pages of different kinds, on the site, skipping carts, accounts and assets', () => {
    const chosen = chooseLinks(home, [
      'https://shop.com/',
      'https://shop.com/cart',
      'https://shop.com/account/login',
      'https://shop.com/checkout',
      'https://shop.com/search?q=x',
      'https://shop.com/cdn/logo.png',
      'https://other.com/collections/all',
      'https://user:pw@shop.com/pages/x',
      'mailto:hi@shop.com',
      'javascript:void(0)',
      'https://www.shop.com/collections/all?sort=price#top',
      'https://shop.com/collections/summer',
      'https://shop.com/products/scarf',
      'https://shop.com/pages/contact',
    ]);
    expect(chosen.map((u) => u.href)).toEqual([
      'https://shop.com/collections/all',
      'https://shop.com/products/scarf',
    ]);
  });

  it('falls back to a repeated kind, and returns fewer when the page has fewer links', () => {
    expect(
      chooseLinks(home, ['https://shop.com/collections/a', 'https://shop.com/collections/b']).map(
        (u) => u.pathname,
      ),
    ).toEqual(['/collections/a', '/collections/b']);
    expect(chooseLinks(home, ['https://shop.com/about']).map((u) => u.pathname)).toEqual([
      '/about',
    ]);
    expect(chooseLinks(home, [])).toEqual([]);
  });

  it('names the site, its www spelling and its subdomains, and no other host', () => {
    expect(hostsFor('www.shop.com').slice(0, 3)).toEqual(['shop.com', 'www.shop.com', '.shop.com']);
    expect(hostsFor('shop.com').slice(0, 3)).toEqual(['shop.com', 'www.shop.com', '.shop.com']);
  });
});

describe('the visitor’s result', () => {
  it('counts distinct rules, groups failures, keeps three examples and cuts snippets', () => {
    const long = `<img alt="" src="${'x'.repeat(400)}">`;
    const result = aggregate(
      'shop.com',
      [
        page(
          'https://shop.com/',
          [
            occurrence('image-alt', '<img src="/a.jpg">'),
            occurrence('image-alt', '<img src="/b.jpg">'),
            occurrence('color-contrast', long, ['1.4.3']),
          ],
          ['image-alt', 'color-contrast', 'label', 'html-has-lang'],
        ),
        page(
          'https://shop.com/products/x',
          [
            occurrence('image-alt', '<img src="/c.jpg">'),
            occurrence('image-alt', '<img src="/d.jpg">'),
          ],
          ['image-alt', 'label', 'link-name'],
        ),
      ],
      new Date('2026-10-22T10:00:00Z'),
    );
    expect(result.domain).toBe('shop.com');
    expect(result.scanned_at).toBe('2026-10-22T10:00:00.000Z');
    expect(result.pages).toEqual(['https://shop.com/', 'https://shop.com/products/x']);
    // Five distinct rules ran; two failed on some page; three passed on every page.
    expect(result.checks_run).toBe(5);
    expect(result.checks_passed).toBe(3);
    expect(result.failures.map((f) => [f.rule_id, f.count])).toEqual([
      ['image-alt', 4],
      ['color-contrast', 1],
    ]);
    const alt = result.failures[0];
    expect(alt?.examples).toHaveLength(3);
    expect(alt?.examples.map((e) => e.page)).toEqual([
      'https://shop.com/',
      'https://shop.com/',
      'https://shop.com/products/x',
    ]);
    expect(alt?.criterion).toBe('1.1.1');
    const contrast = result.failures[1];
    expect(Array.from(contrast?.examples[0]?.snippet ?? '').length).toBeLessThanOrEqual(240);
  });

  it('does not count a rule that could not decide as passed, and lists at most 20 groups', () => {
    const many = Array.from({ length: 30 }, (_, i) => occurrence(`rule-${String(i)}`, '<a></a>'));
    const result = aggregate(
      'shop.com',
      [
        {
          url: 'https://shop.com/',
          violations: many,
          incomplete: [occurrence('aria-valid-attr', '<a></a>')],
          rulesRun: [...many.map((o) => o.ruleId), 'aria-valid-attr', 'label'],
        },
      ],
      new Date(),
    );
    expect(result.failures).toHaveLength(20);
    expect(result.checks_run).toBe(32);
    expect(result.checks_passed).toBe(1);
  });

  it('takes the default state of a page that opened, and nothing from one that did not', () => {
    const base: PageScan = {
      url: 'u',
      finalUrl: 'u',
      status: 200,
      blocked: undefined,
      crops: {},
      durationMs: 1,
      states: [
        {
          state: 'default',
          result: 'opened',
          reason: undefined,
          violations: [occurrence('image-alt', '<img>')],
          incomplete: [],
          bestPractice: [],
          rulesRun: ['image-alt'],
          checksRun: 1,
          checksPassed: 0,
          durationMs: 1,
        },
      ],
    };
    expect(summarise('https://shop.com/', base)?.violations).toHaveLength(1);
    expect(summarise('https://shop.com/', { ...base, states: [] })).toBeUndefined();
  });
});

describe('robots.txt (RFC 9309)', () => {
  it('allows what it allows, refuses what it disallows, and distinguishes a dead server', () => {
    const ok = (text: string, status = 200) => robotsVerdict({ status, text }, '/');
    expect(ok('User-agent: *\nDisallow: /admin')).toBe('allowed');
    expect(ok('User-agent: *\nDisallow: /')).toBe('robots');
    expect(ok('User-agent: RampsmithBot\nDisallow: /\n\nUser-agent: *\nAllow: /')).toBe('robots');
    expect(ok('', 404)).toBe('allowed');
    expect(ok('', 503)).toBe('robots');
    expect(ok('', 429)).toBe('robots');
    expect(robotsVerdict(undefined, '/')).toBe('unreachable');
  });
});

describe('the free_scan.run job', () => {
  let db: TestDatabase;
  let sql: postgres.Sql;
  beforeAll(async () => {
    db = await freshDatabase();
    sql = db.as('rampsmith_worker');
  });
  afterAll(async () => {
    await db.drop();
  });

  const NOT_USED = {} as Browser;

  async function ask(origin: string, domain: string): Promise<string> {
    const id = uuidv7();
    await db.owner`
      insert into free_scans (id, domain, origin, ip_hash, status)
      values (${id}, ${domain}, ${origin}, ${Buffer.alloc(32, 1)}, 'queued')`;
    return id;
  }

  function job(id: string, attempt = 1, maxAttempts = 3): ClaimedJob {
    return {
      payloadSchema: 'free_scan.run@1',
      payload: { free_scan_id: id },
      tenantId: null,
      lease: { attempt },
      maxAttempts,
    } as unknown as ClaimedJob;
  }

  function scanned(links: string[] = []) {
    return (_browser: Browser, options: ScanOptions): Promise<PageScan> =>
      Promise.resolve({
        url: options.url,
        finalUrl: options.url,
        status: 200,
        blocked: undefined,
        crops: {},
        links,
        durationMs: 1,
        states: [
          {
            state: 'default',
            result: 'opened',
            reason: undefined,
            violations: options.url.endsWith('/')
              ? [occurrence('image-alt', '<img src="/a.jpg">')]
              : [],
            incomplete: [],
            bestPractice: [],
            rulesRun: ['image-alt', 'label'],
            checksRun: 2,
            checksPassed: 1,
            durationMs: 1,
          },
        ],
      });
  }

  const egress = { proxyUrl: 'http://127.0.0.1:1', tokenSecret: 'x'.repeat(40) };
  const allowRobots = () => Promise.resolve({ status: 404, text: '' });

  async function row(id: string) {
    const [r] = await db.owner<
      { status: string; refusal: string | null; result: Record<string, unknown> | null }[]
    >`select status, refusal, result from free_scans where id = ${id}`;
    return r;
  }

  it('scans the home page and two linked pages, and stores only the summary', async () => {
    const id = await ask('https://shop.com/', 'shop.com');
    const seen: ScanOptions[] = [];
    const inner = scanned(['https://shop.com/collections/all', 'https://shop.com/pages/about']);
    await freeScanHandler({
      sql,
      browser: NOT_USED,
      egress,
      userAgent: 'RampsmithBot/test',
      fetchText: allowRobots,
      scan: (browser, options) => {
        seen.push(options);
        return inner(browser, options);
      },
    })(job(id));
    const stored = await row(id);
    expect(stored?.status).toBe('complete');
    expect(stored?.result).toMatchObject({
      domain: 'shop.com',
      checks_run: 2,
      checks_passed: 1,
    });
    expect((stored?.result?.['pages'] as string[]).length).toBe(3);
    expect(seen.map((s) => s.viewport)).toEqual(['desktop', 'desktop', 'desktop']);
    expect(seen.every((s) => s.deep === false && s.states?.join() === 'default')).toBe(true);
    // Only the home page's links are collected; every page goes through the egress proxy.
    expect(seen.map((s) => s.collectLinks)).toEqual([true, false, false]);
    expect(seen.every((s) => s.proxy?.server === egress.proxyUrl)).toBe(true);
    const [finished] = await db.owner<{ finished: boolean }[]>`
      select finished_at is not null as finished from free_scans where id = ${id}`;
    expect(finished?.finished).toBe(true);
  });

  it('refuses, without loading anything, when robots.txt disallows the agent', async () => {
    const id = await ask('https://closed.com/', 'closed.com');
    let loaded = 0;
    await freeScanHandler({
      sql,
      browser: NOT_USED,
      egress,
      userAgent: 'x',
      fetchText: () => Promise.resolve({ status: 200, text: 'User-agent: *\nDisallow: /' }),
      scan: () => {
        loaded += 1;
        return Promise.reject(new Error('must not load'));
      },
    })(job(id));
    expect(loaded).toBe(0);
    expect(await row(id)).toMatchObject({ status: 'refused', refusal: 'robots' });
  });

  it('skips a linked page that robots.txt disallows', async () => {
    const id = await ask('https://partial.com/', 'partial.com');
    const urls: string[] = [];
    const inner = scanned(['https://partial.com/collections/all', 'https://partial.com/pages/x']);
    await freeScanHandler({
      sql,
      browser: NOT_USED,
      egress,
      userAgent: 'x',
      fetchText: () =>
        Promise.resolve({ status: 200, text: 'User-agent: *\nDisallow: /collections' }),
      scan: (browser, options) => {
        urls.push(options.url);
        return inner(browser, options);
      },
    })(job(id));
    expect(urls).toEqual(['https://partial.com/', 'https://partial.com/pages/x']);
    expect((await row(id))?.status).toBe('complete');
  });

  it('reports a bot challenge as refused and never tries again', async () => {
    const id = await ask('https://guarded.com/', 'guarded.com');
    await freeScanHandler({
      sql,
      browser: NOT_USED,
      egress,
      userAgent: 'x',
      fetchText: allowRobots,
      scan: (_b, options) =>
        Promise.resolve({
          url: options.url,
          finalUrl: options.url,
          status: 403,
          blocked: 'cloudflare',
          states: [],
          crops: {},
          durationMs: 1,
        }),
    })(job(id));
    expect(await row(id)).toMatchObject({ status: 'refused', refusal: 'bot-challenge' });
  });

  it('reports a site that cannot be reached as refused, and a closed store likewise', async () => {
    const down = await ask('https://down.com/', 'down.com');
    await freeScanHandler({
      sql,
      browser: NOT_USED,
      egress,
      userAgent: 'x',
      fetchText: () => Promise.resolve(undefined),
    })(job(down));
    expect(await row(down)).toMatchObject({ status: 'refused', refusal: 'unreachable' });

    const closed = await ask('https://closed-store.com/', 'closed-store.com');
    await freeScanHandler({
      sql,
      browser: NOT_USED,
      egress,
      userAgent: 'x',
      fetchText: allowRobots,
      scan: (_b, options) =>
        Promise.resolve({
          url: options.url,
          finalUrl: options.url,
          status: 200,
          blocked: 'storefront_password',
          states: [],
          crops: {},
          durationMs: 1,
        }),
    })(job(closed));
    expect(await row(closed)).toMatchObject({ status: 'refused', refusal: 'unreachable' });
  });

  it('retries a failed load, and on the last attempt says the site was unreachable', async () => {
    const id = await ask('https://flaky.com/', 'flaky.com');
    const handler = freeScanHandler({
      sql,
      browser: NOT_USED,
      egress,
      userAgent: 'x',
      fetchText: allowRobots,
      scan: () => Promise.reject(new Error('net::ERR_CONNECTION_RESET')),
    });
    await expect(handler(job(id, 1))).rejects.toMatchObject({
      failure: { kind: 'retryable' },
    });
    expect((await row(id))?.status).toBe('running');
    await handler(job(id, 3));
    expect(await row(id)).toMatchObject({ status: 'refused', refusal: 'unreachable' });
  });

  it('does nothing for a scan that is gone or already finished', async () => {
    const handler = freeScanHandler({
      sql,
      browser: NOT_USED,
      egress,
      userAgent: 'x',
      fetchText: () => Promise.reject(new Error('must not run')),
    });
    await handler(job(uuidv7()));
    const id = await ask('https://done.com/', 'done.com');
    await db.owner`
      update free_scans set status = 'failed', finished_at = now() where id = ${id}`;
    await handler(job(id));
    expect((await row(id))?.status).toBe('failed');
  });

  it('rejects a payload that is not a free scan id', async () => {
    const handler = freeScanHandler({
      sql,
      browser: NOT_USED,
      egress,
      userAgent: 'x',
    });
    const bad = { ...job(uuidv7()), payload: { free_scan_id: 'nope' } } as ClaimedJob;
    await expect(handler(bad)).rejects.toMatchObject({ failure: { kind: 'permanent' } });
  });
});
