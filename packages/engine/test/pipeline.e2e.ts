/**
 * The whole scan pipeline over the synthetic corpus: `scan.plan` chooses pages, `scan.page`
 * loads them in Chromium through the real egress proxy, `audit.data` audits the store's data and
 * `scan.finalize` ranks the result (ADR-070 to ADR-073). The `aurora` theme renders every page
 * type from the corpus store; `ctl` is replaced by rows written to `scan_inputs`.
 *
 * LAUNCH.md C rows 1 and 3 (a live store and its Admin API token) are substituted by this local
 * storefront. The live test at the bottom skips until a store is supplied.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import process from 'node:process';
import { enqueue, runWorker, uuidv7 } from '@rampsmith/queue';
import type { ThemeRenderer } from '@rampsmith/corpus-tools';
import { loadCorpus, type LoadedTheme } from '@rampsmith/corpus-tools';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser } from '../src/browser.ts';
import { engineHandlers } from '../src/queues.ts';
import { freshDatabase, seed, type TestDatabase } from './db.ts';
import { EGRESS_SECRET, startEgress, type Egress } from './egress.ts';

const UA = 'RampsmithBot/test (accessibility scanner)';
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

let browser: Browser;
let db: TestDatabase;
let egress: Egress;
let server: Server;
let theme: LoadedTheme;
let origin = '';

function serve(renderer: ThemeRenderer): Server {
  return createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://local');
    const path = decodeURIComponent(url.pathname);
    if (path.startsWith('/cdn/shop/t/1/assets/')) {
      const asset = renderer.renderAsset(path.slice('/cdn/shop/t/1/assets/'.length));
      if (asset !== null) {
        response.writeHead(200, { 'content-type': asset.contentType }).end(asset.body);
        return;
      }
    }
    if (path.startsWith('/cdn/shop/files/') || path.startsWith('/media/')) {
      response.writeHead(200, { 'content-type': 'image/png' }).end(PIXEL);
      return;
    }
    const spec = theme.entry.pages.find((p) => new URL(p.path, 'http://local').pathname === path);
    if (spec === undefined) {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    // The search page renders the query the planner chose, not the one the corpus used.
    const html = renderer.renderPage({ ...spec, path: `${url.pathname}${url.search}` });
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
  });
}

beforeAll(async () => {
  const corpus = loadCorpus();
  const found = corpus.themes.find((t) => t.entry.name === 'aurora');
  if (found === undefined) throw new Error('the corpus has no aurora theme');
  theme = found;
  server = serve(theme.renderer);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  origin = `https://127.0.0.1:${port.toString()}`;
  const executablePath = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'];
  browser = await launchBrowser({
    chromiumSandbox: false,
    ...(executablePath === undefined ? {} : { executablePath }),
  });
  egress = await startEgress(port);
  db = await freshDatabase();
});
afterAll(async () => {
  await browser.close();
  await egress.stop();
  await db.drop();
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
});

/** The corpus store, shaped the way `ctl` writes it to `scan_inputs`. */
function inputs() {
  const store = theme.store.fixture;
  const media = (p: (typeof store.products)[number]) =>
    p.media.map((m) => ({
      id: `gid://shopify/MediaImage/${String(m.id)}`,
      alt: m.alt,
      url: `https://cdn.shopify.com/s/files/${m.src}`,
    }));
  return {
    shop: {
      primary_locale: 'en',
      sampling: { mode: 'per_template', samples: 1, every_variant: false },
    },
    products: {
      items: store.products.map((p) => ({
        id: `gid://shopify/Product/${String(p.id)}`,
        handle: p.handle,
        title: p.title,
        description_html: p.description,
        media: media(p),
      })),
    },
    collections: {
      items: store.collections.map((c) => ({
        id: `gid://shopify/Collection/${String(c.id)}`,
        handle: c.handle,
        title: c.title,
        description_html: c.description,
      })),
    },
    pages: {
      items: store.pages.map((p) => ({
        id: `gid://shopify/Page/${String(p.id)}`,
        handle: p.handle,
        title: p.title,
        body: p.content,
      })),
    },
    articles: {
      items: store.blogs.flatMap((b) =>
        b.articles.map((a) => ({
          id: `gid://shopify/Article/${String(a.id)}`,
          handle: a.handle,
          blog_handle: b.handle,
          title: a.title,
          body: a.content,
        })),
      ),
    },
    menus: {
      items: Object.entries(store.menus).map(([handle, links], index) => ({
        id: `gid://shopify/Menu/${String(index + 1)}`,
        handle,
        title: handle,
        items: links.map((l) => ({ title: l.title, url: l.url, items: [] })),
      })),
    },
  };
}

describe('the scan pipeline over the aurora corpus theme', () => {
  it('plans, scans, audits and finalizes a scan, with findings for every page type', async () => {
    const sql = db.as('rampsmith_worker');
    const f = await seed(db.owner, origin, { pages: 0 });
    const rows = inputs();
    const ids: Record<string, string> = {};
    for (const [kind, payload] of Object.entries(rows)) {
      const id = uuidv7();
      ids[kind] = id;
      await db.owner`
        insert into scan_inputs (id, tenant_id, scan_id, site_id, kind, seq, payload)
        values (${id}, ${f.tenantId}, ${f.scanId}, ${f.siteId}, ${kind}, 0,
                ${db.owner.json(payload)})`;
    }

    const handlers = engineHandlers({
      sql,
      browser,
      egress: { proxyUrl: egress.url, tokenSecret: EGRESS_SECRET },
      userAgent: UA,
      rewriteUrl: (url) => new URL(url.href.replace('https:', 'http:')),
    });
    const stop = new AbortController();
    const workers = (['scan.plan', 'scan.page', 'audit.data', 'scan.finalize'] as const).map(
      (queue) =>
        runWorker({
          sql,
          queue,
          workerId: `e2e-${queue}`,
          pollMs: 100,
          signal: stop.signal,
          handler: handlers[queue],
        }),
    );

    await enqueue(sql, {
      queue: 'scan.plan',
      payloadSchema: 'scan.plan@1',
      payload: { scan_id: f.scanId, site_id: f.siteId },
      tenantId: f.tenantId,
      maxAttempts: 1,
    });
    for (const kind of ['products', 'collections', 'pages', 'articles', 'menus']) {
      await enqueue(sql, {
        queue: 'audit.data',
        payloadSchema: 'audit.data@1',
        payload: { scan_id: f.scanId, site_id: f.siteId, input_id: ids[kind] ?? '' },
        tenantId: f.tenantId,
        maxAttempts: 1,
      });
    }

    let status = 'queued';
    for (let i = 0; i < 600 && !['succeeded', 'partial', 'failed'].includes(status); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const [scan] = await db.owner<{ status: string }[]>`
        select status from scans where id = ${f.scanId}`;
      status = scan?.status ?? status;
    }
    stop.abort();
    await Promise.allSettled(workers);

    expect(status).toBe('succeeded');
    const pages = await db.owner<
      { page_state: string; viewport: string; blocked_reason: string | null; violations: number }[]
    >`select page_state, viewport, blocked_reason, violations from scan_pages
       where scan_id = ${f.scanId}`;
    expect(pages.length).toBeGreaterThanOrEqual(8);
    expect(pages.every((p) => p.blocked_reason === null)).toBe(true);

    const found = await db.owner<{ page_type: string; origin: string }[]>`
      select distinct o.page_type, f.origin
        from finding_occurrences o join findings f on f.id = o.finding_id
       where f.site_id = ${f.siteId}`;
    const renderTypes = new Set(found.filter((r) => r.origin !== 'data').map((r) => r.page_type));
    // The aurora theme fails on every one of the eight page types (corpus/golden/aurora.json).
    for (const type of [
      'home',
      'product',
      'collection',
      'cart',
      'search',
      'page',
      'article',
      'login',
    ]) {
      expect(renderTypes, `findings on the ${type} page`).toContain(type);
    }
    const data = found.filter((r) => r.origin === 'data');
    expect(data.length).toBeGreaterThan(0);

    const ranked = await db.owner<{ priority: string | null }[]>`
      select priority_score as priority from findings
       where site_id = ${f.siteId} and status = 'open' and best_practice = false`;
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked.every((r) => r.priority !== null && Number(r.priority) > 0)).toBe(true);
  });
});

// LAUNCH.md C rows 1 and 3: a live development store and its Admin API token.
describe.skipIf(process.env['RAMPSMITH_LIVE_STORE'] === undefined)('a live store', () => {
  it('scans a real store end to end', () => {
    expect(process.env['RAMPSMITH_LIVE_STORE']).toBeDefined();
  });
});
