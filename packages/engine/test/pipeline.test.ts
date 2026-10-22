/**
 * The scan pipeline's handlers against PostgreSQL, with a fake page scanner: plan, page, audit,
 * finalize and verify, the way the queue would run them (ADR-070 to ADR-073). No browser.
 */
import { uuidv7 } from '@rampsmith/queue';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scanPlanHandler } from '../src/jobs/plan.ts';
import { auditDataHandler } from '../src/jobs/audit-data.ts';
import { scanFinalizeHandler } from '../src/jobs/finalize.ts';
import type { JobHandler, JobInput } from '../src/jobs/payload.ts';
import { verifyScanHandler } from '../src/jobs/verify.ts';
import { scanPage, type Occurrence, type PageScan, type ScanOptions } from '../src/scan-page.ts';
import { scanPageHandler, type EngineDeps } from '../src/worker.ts';
import { freshDatabase, seed, type Fixture, type TestDatabase } from './db.ts';
import { pageScan, stateScan } from './scans.ts';

let db: TestDatabase;
let sql: postgres.Sql;

beforeAll(async () => {
  db = await freshDatabase();
  sql = db.as('rampsmith_worker');
});
afterAll(async () => {
  await db.drop();
});

const SHOP = 'https://shop.example';

/** What the fake scanner is told to find, by URL path. */
type Script = Record<string, (options: ScanOptions) => PageScan>;

function deps(script: Script, seen: ScanOptions[] = []): EngineDeps {
  return {
    sql,
    browser: undefined as never,
    egress: { proxyUrl: 'http://127.0.0.1:1', tokenSecret: 'test-secret-0123456789abcdef0123' },
    userAgent: 'test',
    scan: (_browser, options) => {
      seen.push(options);
      const path = new URL(options.url).pathname;
      const make = script[path];
      return Promise.resolve(make === undefined ? pageScan(options.url, []) : make(options));
    },
  };
}

const imageAlt = (target: string, impact: Occurrence['impact'] = 'critical'): Occurrence => ({
  ruleId: 'image-alt',
  impact,
  criteria: ['1.1.1'],
  help: 'Images must have alternative text',
  target,
  html: '<img src="a.png">',
  section: 'shopify-section-template--1__main',
});

const contrast = (target: string): Occurrence => ({
  ruleId: 'color-contrast',
  impact: 'serious',
  criteria: ['1.4.3'],
  help: 'Elements must meet minimum color contrast ratio thresholds',
  target,
  html: '<p style="color:#bbb">Price</p>',
  section: 'shopify-section-template--2__main',
});

function input(schema: string, payload: unknown, tenantId: string, attempt?: number): JobInput {
  return {
    payloadSchema: schema,
    payload,
    tenantId,
    ...(attempt === undefined
      ? {}
      : { lease: { jobId: uuidv7(), worker: 'w', attempt }, maxAttempts: 4 }),
  };
}

async function addInput(f: Fixture, kind: string, seq: number, payload: unknown): Promise<string> {
  const id = uuidv7();
  await db.owner`
    insert into scan_inputs (id, tenant_id, scan_id, site_id, kind, seq, payload)
    values (${id}, ${f.tenantId}, ${f.scanId}, ${f.siteId}, ${kind}, ${seq},
            ${db.owner.json(payload as postgres.JSONValue)})`;
  return id;
}

interface QueuedJob {
  queue: string;
  payload_schema: string;
  payload: Record<string, unknown>;
  idempotency_key: string | null;
}

async function queued(queue: string, scanId: string): Promise<QueuedJob[]> {
  return db.owner<QueuedJob[]>`
    select queue, payload_schema, payload, idempotency_key from jobs
     where queue = ${queue} and payload ->> 'scan_id' = ${scanId}
     order by (payload ->> 'seq')::int nulls first, created_at`;
}

const PRODUCTS = {
  items: [
    {
      id: 'gid://shopify/Product/1',
      handle: 'linen-shirt',
      title: 'Linen Shirt',
      description_html: '<h4>Care</h4><p><a href="/care">Click here</a></p>',
      media: [
        {
          id: 'gid://shopify/MediaImage/11',
          alt: '',
          url: 'https://cdn.shopify.com/s/files/a.jpg',
        },
        {
          id: 'gid://shopify/MediaImage/12',
          alt: 'IMG_4032.jpg',
          url: 'https://cdn.shopify.com/b.jpg',
        },
        { id: 'gid://shopify/MediaImage/13', alt: 'Front view in sand' },
      ],
    },
    { id: 'gid://shopify/Product/2', handle: 'wool-throw', title: 'Wool Throw', media: [] },
  ],
};

describe('scan.plan', () => {
  it('writes the plan on the scan and enqueues one scan.page@2 job per page', async () => {
    const f = await seed(db.owner, SHOP, { pages: 0 });
    await addInput(f, 'shop', 0, {
      primary_domain: 'shop.example',
      primary_locale: 'en',
      sampling: { mode: 'per_template', samples: 3, every_variant: false },
    });
    await addInput(f, 'products', 0, PRODUCTS);
    await addInput(f, 'menus', 0, { items: [] });
    const handler = scanPlanHandler({ sql });
    await handler(input('scan.plan@1', { scan_id: f.scanId, site_id: f.siteId }, f.tenantId));

    const jobs = await queued('scan.page', f.scanId);
    const [scan] = await db.owner<
      { pages_planned: number; data_inputs_planned: number; plan: { pages: unknown[] } }[]
    >`select pages_planned, data_inputs_planned, plan from scans where id = ${f.scanId}`;
    expect(scan?.pages_planned).toBe(jobs.length);
    expect(scan?.plan.pages).toHaveLength(jobs.length);
    expect(scan?.data_inputs_planned).toBe(2);
    // Home, cart, search, login, two products; a mobile page for each of the first five types.
    expect(jobs.filter((j) => j.payload['viewport'] === 'desktop')).toHaveLength(6);
    expect(jobs.filter((j) => j.payload['viewport'] === 'mobile')).toHaveLength(5);
    for (const job of jobs) expect(job.payload_schema).toBe('scan.page@2');
    expect(jobs[0]?.payload).toMatchObject({ page_type: 'home', url: `${SHOP}/`, seq: 0 });
    expect(jobs.map((j) => j.payload['url'])).toContain(`${SHOP}/search?q=Linen`);

    // Planning again changes nothing: same plan, no duplicate jobs.
    await handler(input('scan.plan@1', { scan_id: f.scanId, site_id: f.siteId }, f.tenantId));
    expect(await queued('scan.page', f.scanId)).toHaveLength(jobs.length);
  });

  it('plans the four universal pages when ctl has stored nothing yet', async () => {
    const f = await seed(db.owner, SHOP, { pages: 0 });
    await scanPlanHandler({ sql })(
      input('scan.plan@1', { scan_id: f.scanId, site_id: f.siteId }, f.tenantId),
    );
    const jobs = await queued('scan.page', f.scanId);
    expect(
      jobs.filter((j) => j.payload['viewport'] === 'desktop').map((j) => j.payload['page_type']),
    ).toEqual(['home', 'cart', 'search', 'login']);
  });

  it('refuses an unverified site, a missing scan and a closed scan, permanently', async () => {
    const handler = scanPlanHandler({ sql });
    const unverified = await seed(db.owner, SHOP, { verified: false });
    await expect(
      handler(
        input(
          'scan.plan@1',
          { scan_id: unverified.scanId, site_id: unverified.siteId },
          unverified.tenantId,
        ),
      ),
    ).rejects.toMatchObject({
      failure: { kind: 'permanent', error: { code: 'site_not_verified' } },
    });
    const f = await seed(db.owner, SHOP);
    await expect(
      handler(input('scan.plan@1', { scan_id: uuidv7(), site_id: f.siteId }, f.tenantId)),
    ).rejects.toMatchObject({ failure: { error: { code: 'scan_not_found' } } });
    await db.owner`update scans set status = 'cancelled' where id = ${f.scanId}`;
    await expect(
      handler(input('scan.plan@1', { scan_id: f.scanId, site_id: f.siteId }, f.tenantId)),
    ).rejects.toMatchObject({ failure: { error: { code: 'scan_closed' } } });
  });

  it("cannot plan another tenant's scan", async () => {
    const mine = await seed(db.owner, SHOP);
    const theirs = await seed(db.owner, SHOP);
    await expect(
      scanPlanHandler({ sql })(
        input('scan.plan@1', { scan_id: theirs.scanId, site_id: theirs.siteId }, mine.tenantId),
      ),
    ).rejects.toMatchObject({ failure: { kind: 'permanent' } });
  });
});

/** Runs every queued scan.page job of a scan, in order, with the fake scanner. */
async function runPages(f: Fixture, handler: JobHandler): Promise<void> {
  for (const job of await queued('scan.page', f.scanId)) {
    await handler(input('scan.page@2', job.payload, f.tenantId));
  }
}

async function planned(
  sampling: unknown = { mode: 'per_template', samples: 1, every_variant: false },
): Promise<Fixture> {
  const f = await seed(db.owner, SHOP, { pages: 0 });
  await addInput(f, 'shop', 0, { primary_locale: 'en', sampling });
  await addInput(f, 'products', 0, PRODUCTS);
  await scanPlanHandler({ sql })(
    input('scan.plan@1', { scan_id: f.scanId, site_id: f.siteId }, f.tenantId),
  );
  return f;
}

describe('scan.page@2 through finalize', () => {
  it('records each state and viewport, merges across pages, and finalises once', async () => {
    const f = await planned();
    // The first audit input is done before the last page: finalize waits for both.
    const script: Script = {
      '/': (o) =>
        pageScan(o.url, [], o.url, {
          states: [
            stateScan('default', [imageAlt('header > img')]),
            stateScan('nav_open', [], { result: 'not_found', reason: 'no_trigger' }),
            stateScan('modal', [contrast('dialog > p')]),
          ],
        }),
      '/products/linen-shirt': (o) =>
        pageScan(
          o.url,
          [imageAlt('main > div:nth-child(3) > img'), contrast('main p.price')],
          o.url,
          {
            crops: {},
          },
        ),
    };
    const page = scanPageHandler(deps(script));
    await runPages(f, page);

    const rows = await db.owner<
      {
        url: string;
        page_state: string;
        viewport: string;
        page_type: string;
        state_outcome: string | null;
      }[]
    >`select url, page_state, viewport, page_type, state_outcome from scan_pages
       where scan_id = ${f.scanId} order by url, viewport, page_state`;
    const home = rows.filter((r) => r.url === `${SHOP}/` && r.viewport === 'desktop');
    expect(home.map((r) => [r.page_state, r.state_outcome])).toEqual([
      ['default', 'opened'],
      ['modal', 'opened'],
      ['nav_open', 'not_found'],
    ]);
    expect(rows.some((r) => r.viewport === 'mobile' && r.page_type === 'product')).toBe(true);

    const findings = await db.owner<
      {
        rule_id: string;
        status: string;
        fix_kind: string;
        fix_recipe: string;
        occurrence_count: number;
      }[]
    >`select rule_id, status, fix_kind, fix_recipe, occurrence_count from findings
       where site_id = ${f.siteId} order by rule_id, occurrence_count`;
    expect(findings.map((x) => [x.rule_id, x.fix_kind, x.fix_recipe])).toEqual(
      expect.arrayContaining([
        ['color-contrast', 'code', 'contrast'],
        ['image-alt', 'code', 'image-alt'],
      ]),
    );
    const [scan] = await db.owner<
      { pages_done: number; pages_planned: number; status: string; data_inputs_planned: number }[]
    >`
      select pages_done, pages_planned, status, data_inputs_planned from scans where id = ${f.scanId}`;
    expect(scan?.pages_done).toBe(scan?.pages_planned);
    expect(scan?.status).toBe('running');
    // One data input (products) is still to be audited, so nothing is finalised yet.
    expect(scan?.data_inputs_planned).toBe(1);
    expect(await queued('scan.finalize', f.scanId)).toHaveLength(0);

    const [products] = await db.owner<{ id: string }[]>`
      select id from scan_inputs where scan_id = ${f.scanId} and kind = 'products'`;
    await auditDataHandler({ sql })(
      input(
        'audit.data@1',
        { input_id: products?.id, scan_id: f.scanId, site_id: f.siteId },
        f.tenantId,
      ),
    );
    const finalize = await queued('scan.finalize', f.scanId);
    expect(finalize).toHaveLength(1);
    expect(finalize[0]?.idempotency_key).toBe(`scan.finalize:${f.scanId}`);

    const run = scanFinalizeHandler({ sql });
    await run(input('scan.finalize@1', { scan_id: f.scanId, site_id: f.siteId }, f.tenantId));
    const [done] = await db.owner<
      {
        status: string;
        finalized: boolean;
        checks_run: number;
        checks_passed: number;
        coverage: Record<string, unknown>;
      }[]
    >`select status, finalized_at is not null as finalized, checks_run, checks_passed, coverage
        from scans where id = ${f.scanId}`;
    expect(done?.status).toBe('succeeded');
    expect(done?.finalized).toBe(true);
    expect(done?.checks_run).toBeGreaterThan(0);
    expect(done?.checks_passed).toBeLessThanOrEqual(done?.checks_run ?? 0);
    expect(done?.coverage).toMatchObject({
      version: 1,
      pages: { blocked: 0, failed: 0 },
      data_audit: { resources: expect.any(Number) as number },
    });

    // Ranked: every open finding has a score, the contrast on the purchase path outranks all.
    const ranked = await db.owner<
      {
        rule_id: string;
        priority_score: string;
        templates_affected: number;
        on_purchase_path: boolean;
      }[]
    >`select rule_id, priority_score, templates_affected, on_purchase_path from findings
       where site_id = ${f.siteId} and status = 'open' and not best_practice
       order by priority_score desc`;
    expect(ranked.length).toBeGreaterThan(3);
    for (const r of ranked) expect(Number(r.priority_score)).toBeGreaterThan(0);
    const top = ranked[0];
    expect(top?.on_purchase_path).toBe(true);

    // A second run is a no-op.
    await run(input('scan.finalize@1', { scan_id: f.scanId, site_id: f.siteId }, f.tenantId));
    const [again] = await db.owner<
      { status: string }[]
    >`select status from scans where id = ${f.scanId}`;
    expect(again?.status).toBe('succeeded');
  });

  it('ends partial when a page is blocked, and failed when every page is', async () => {
    const f = await planned();
    const blocked = (o: ScanOptions): PageScan =>
      pageScan(o.url, [], o.url, { status: 403, blocked: 'cloudflare', states: [] });
    const [products] = await db.owner<{ id: string }[]>`
      select id from scan_inputs where scan_id = ${f.scanId} and kind = 'products'`;
    await auditDataHandler({ sql })(
      input(
        'audit.data@1',
        { input_id: products?.id, scan_id: f.scanId, site_id: f.siteId },
        f.tenantId,
      ),
    );
    await runPages(f, scanPageHandler(deps({ '/cart': blocked })));
    const finalize = scanFinalizeHandler({ sql });
    await finalize(input('scan.finalize@1', { scan_id: f.scanId, site_id: f.siteId }, f.tenantId));
    const [partial] = await db.owner<
      { status: string; coverage: { pages: { blocked: number; blocked_reasons: string[] } } }[]
    >`
      select status, coverage from scans where id = ${f.scanId}`;
    expect(partial?.status).toBe('partial');
    expect(partial?.coverage.pages.blocked).toBeGreaterThan(0);
    expect(partial?.coverage.pages.blocked_reasons).toEqual(['cloudflare']);

    const g = await planned();
    const everything = new Proxy({}, { get: () => blocked });
    await runPages(g, scanPageHandler(deps(everything)));
    const [p2] = await db.owner<{ id: string }[]>`
      select id from scan_inputs where scan_id = ${g.scanId} and kind = 'products'`;
    await auditDataHandler({ sql })(
      input('audit.data@1', { input_id: p2?.id, scan_id: g.scanId, site_id: g.siteId }, g.tenantId),
    );
    await finalize(input('scan.finalize@1', { scan_id: g.scanId, site_id: g.siteId }, g.tenantId));
    const [failed] = await db.owner<{ status: string; error_code: string }[]>`
      select status, error_code from scans where id = ${g.scanId}`;
    expect(failed).toEqual({ status: 'failed', error_code: 'blocked_cloudflare' });
  });

  it('counts a page that failed its last attempt, so the scan can still finish', async () => {
    const f = await planned();
    const [products] = await db.owner<{ id: string }[]>`
      select id from scan_inputs where scan_id = ${f.scanId} and kind = 'products'`;
    await auditDataHandler({ sql })(
      input(
        'audit.data@1',
        { input_id: products?.id, scan_id: f.scanId, site_id: f.siteId },
        f.tenantId,
      ),
    );
    const boom: EngineDeps = {
      ...deps({}),
      scan: (_b, o) =>
        new URL(o.url).pathname === '/cart'
          ? Promise.reject(new Error('net::ERR_TIMED_OUT'))
          : Promise.resolve(pageScan(o.url, [])),
    };
    const handler = scanPageHandler(boom);
    for (const job of await queued('scan.page', f.scanId)) {
      const isCart = job.payload['url'] === `${SHOP}/cart`;
      const result = handler(input('scan.page@2', job.payload, f.tenantId, isCart ? 4 : 1));
      if (isCart) {
        await expect(result).rejects.toMatchObject({
          failure: { kind: 'retryable', error: { code: 'page_load_failed' } },
        });
      } else {
        await result;
      }
    }
    expect(await queued('scan.finalize', f.scanId)).toHaveLength(1);
    await scanFinalizeHandler({ sql })(
      input('scan.finalize@1', { scan_id: f.scanId, site_id: f.siteId }, f.tenantId),
    );
    const [scan] = await db.owner<
      { status: string }[]
    >`select status from scans where id = ${f.scanId}`;
    expect(scan?.status).toBe('partial');
  });

  it('refuses a page off the site and an unverified site, permanently', async () => {
    const f = await planned();
    const handler = scanPageHandler(deps({}));
    const [job] = await queued('scan.page', f.scanId);
    await expect(
      handler(input('scan.page@2', { ...job?.payload, url: 'https://evil.example/' }, f.tenantId)),
    ).rejects.toMatchObject({ failure: { kind: 'permanent', error: { code: 'url_off_site' } } });
    const u = await seed(db.owner, SHOP, { verified: false });
    await expect(
      handler(
        input('scan.page@2', { ...job?.payload, scan_id: u.scanId, site_id: u.siteId }, u.tenantId),
      ),
    ).rejects.toMatchObject({ failure: { error: { code: 'site_not_verified' } } });
  });

  it('allows the shop primary domain, and reads the deep flag from the plan', async () => {
    const f = await seed(db.owner, SHOP, { pages: 0 });
    await addInput(f, 'shop', 0, { primary_domain: 'www.shop.example' });
    await scanPlanHandler({ sql })(
      input('scan.plan@1', { scan_id: f.scanId, site_id: f.siteId }, f.tenantId),
    );
    const seen: ScanOptions[] = [];
    const handler = scanPageHandler(deps({}, seen));
    const jobs = await queued('scan.page', f.scanId);
    await handler(
      input('scan.page@2', { ...jobs[0]?.payload, url: 'https://www.shop.example/' }, f.tenantId),
    );
    await handler(input('scan.page@2', jobs[1]?.payload, f.tenantId));
    await handler(
      input(
        'scan.page@2',
        jobs.find((j) => j.payload['viewport'] === 'mobile')?.payload,
        f.tenantId,
      ),
    );
    expect(seen.map((s) => s.deep)).toEqual([true, true, false]);
    expect(seen[2]?.viewport).toBe('mobile');
  });
});

describe('audit.data', () => {
  it('records data findings with their location and fix, and queues alt-text drafts once', async () => {
    const f = await seed(db.owner, SHOP, { pages: 1 });
    await addInput(f, 'shop', 0, { primary_locale: 'en' });
    const id = await addInput(f, 'products', 0, PRODUCTS);
    const run = auditDataHandler({ sql });
    await run(
      input('audit.data@1', { input_id: id, scan_id: f.scanId, site_id: f.siteId }, f.tenantId),
    );

    const found = await db.owner<
      {
        rule_id: string;
        origin: string;
        fix_kind: string;
        fix_recipe: string;
        status: string;
        on_purchase_path: boolean;
        best_practice: boolean;
        resource: string;
        field: string;
      }[]
    >`select rule_id, origin, fix_kind, fix_recipe, status, on_purchase_path, best_practice,
             source_location ->> 'resource' as resource, source_location ->> 'field' as field
        from findings where site_id = ${f.siteId} order by rule_id`;
    expect(found.map((x) => x.rule_id)).toEqual([
      'rs-media-alt-empty',
      'rs-media-alt-filename',
      'rs-rich-text-heading-skip',
      'rs-rich-text-link-vague',
    ]);
    const empty = found.find((x) => x.rule_id === 'rs-media-alt-empty');
    expect(empty).toMatchObject({
      origin: 'data',
      fix_kind: 'data',
      fix_recipe: 'media-alt',
      resource: 'gid://shopify/MediaImage/11',
      field: 'alt',
      on_purchase_path: true,
    });
    expect(found.find((x) => x.rule_id === 'rs-rich-text-heading-skip')?.best_practice).toBe(true);

    const drafts = await db.owner<{ payload: Record<string, string>; idempotency_key: string }[]>`
      select payload, idempotency_key from jobs where queue = 'ai.alt_text'
       and payload ->> 'input_id' = ${id} order by payload ->> 'resource_gid'`;
    expect(drafts.map((d) => d.payload['resource_gid'])).toEqual([
      'gid://shopify/MediaImage/11',
      'gid://shopify/MediaImage/12',
    ]);
    expect(drafts[0]?.payload).toMatchObject({ site_id: f.siteId, input_id: id });

    // A retry after success does nothing twice.
    await run(
      input('audit.data@1', { input_id: id, scan_id: f.scanId, site_id: f.siteId }, f.tenantId),
    );
    const [{ n } = { n: -1 }] = await db.owner<{ n: number }[]>`
      select count(*)::int as n from finding_occurrences where scan_id = ${f.scanId}`;
    expect(n).toBe(4);
    const [scan] = await db.owner<{ data_inputs_done: number; data_inputs_planned: number }[]>`
      select data_inputs_done, data_inputs_planned from scans where id = ${f.scanId}`;
    expect(scan).toEqual({ data_inputs_done: 1, data_inputs_planned: 1 });
  });

  it('audits menus, pages, articles and collections', async () => {
    const f = await seed(db.owner, SHOP, { pages: 1 });
    const menus = await addInput(f, 'menus', 0, {
      items: [
        {
          id: 'gid://shopify/Menu/1',
          handle: 'main-menu',
          items: [
            { id: 'gid://shopify/MenuItem/1', title: '', url: '/a', items: [] },
            { id: 'gid://shopify/MenuItem/2', title: 'Shop', url: '/shop', items: [] },
            { id: 'gid://shopify/MenuItem/3', title: 'shop', url: '/other', items: [] },
          ],
        },
      ],
    });
    const pages = await addInput(f, 'pages', 0, {
      items: [
        {
          id: 'gid://shopify/Page/5',
          handle: 'about',
          title: 'About',
          body: '<p><img src="/a.jpg"></p><table><tr><td>x</td></tr></table>',
        },
      ],
    });
    const articles = await addInput(f, 'articles', 0, {
      items: [
        {
          id: 'gid://shopify/Article/6',
          handle: 'news-1',
          blog: { handle: 'news' },
          title: 'News',
          body: '<p><a href="/x"></a></p>',
        },
      ],
    });
    const collections = await addInput(f, 'collections', 0, {
      items: [
        {
          id: 'gid://shopify/Collection/7',
          handle: 'all',
          title: 'All',
          description_html: '<h3>Skips</h3>',
        },
      ],
    });
    const run = auditDataHandler({ sql });
    for (const id of [menus, pages, articles, collections]) {
      await run(
        input('audit.data@1', { input_id: id, scan_id: f.scanId, site_id: f.siteId }, f.tenantId),
      );
    }
    const rules = await db.owner<{ rule_id: string }[]>`
      select rule_id from findings where site_id = ${f.siteId} order by rule_id`;
    expect(rules.map((r) => r.rule_id)).toEqual(
      expect.arrayContaining([
        'rs-menu-item-label-empty',
        'rs-menu-item-label-duplicate',
        'rs-rich-text-img-alt-missing',
        'rs-rich-text-link-empty',
        'rs-rich-text-heading-skip',
      ]),
    );
    const [scan] = await db.owner<{ data_inputs_done: number }[]>`
      select data_inputs_done from scans where id = ${f.scanId}`;
    expect(scan?.data_inputs_done).toBe(4);
  });

  it('rejects an input from another scan and a kind it does not audit', async () => {
    const f = await seed(db.owner, SHOP);
    const other = await seed(db.owner, SHOP);
    const foreign = await addInput(other, 'products', 0, PRODUCTS);
    const shop = await addInput(f, 'shop', 0, {});
    const run = auditDataHandler({ sql });
    await expect(
      run(
        input(
          'audit.data@1',
          { input_id: foreign, scan_id: f.scanId, site_id: f.siteId },
          f.tenantId,
        ),
      ),
    ).rejects.toMatchObject({ failure: { error: { code: 'input_not_found' } } });
    await expect(
      run(
        input('audit.data@1', { input_id: shop, scan_id: f.scanId, site_id: f.siteId }, f.tenantId),
      ),
    ).rejects.toMatchObject({ failure: { error: { code: 'input_not_auditable' } } });
  });
});

describe('finalize closes what was not seen again', () => {
  it('closes a data finding the audit no longer sees, and a render finding on a page it re-loaded', async () => {
    const f = await seed(db.owner, SHOP, { pages: 0 });
    await addInput(f, 'shop', 0, { primary_locale: 'en' });
    await addInput(f, 'products', 0, PRODUCTS);
    await scanPlanHandler({ sql })(
      input('scan.plan@1', { scan_id: f.scanId, site_id: f.siteId }, f.tenantId),
    );
    await runPages(
      f,
      scanPageHandler(deps({ '/cart': (o) => pageScan(o.url, [imageAlt('form > img')]) })),
    );
    const [products] = await db.owner<{ id: string }[]>`
      select id from scan_inputs where scan_id = ${f.scanId} and kind = 'products'`;
    await auditDataHandler({ sql })(
      input(
        'audit.data@1',
        { input_id: products?.id, scan_id: f.scanId, site_id: f.siteId },
        f.tenantId,
      ),
    );
    await scanFinalizeHandler({ sql })(
      input('scan.finalize@1', { scan_id: f.scanId, site_id: f.siteId }, f.tenantId),
    );
    const open = await db.owner<{ n: number }[]>`
      select count(*)::int as n from findings where site_id = ${f.siteId} and status = 'open'`;
    expect(open[0]?.n).toBeGreaterThan(3);

    // A second scan of the same site: the cart is fixed and the alt text was written.
    const second = uuidv7();
    await db.owner`
      insert into scans (id, tenant_id, site_id, trigger, status, ruleset_version, pages_planned)
      values (${second}, ${f.tenantId}, ${f.siteId}, 'manual', 'queued', 'axe-4.14.0', 0)`;
    const next: Fixture = { ...f, scanId: second };
    await addInput(next, 'shop', 0, { primary_locale: 'en' });
    const fixed = {
      items: [
        {
          ...PRODUCTS.items[0],
          description_html: '<p>Clean.</p>',
          media: [
            { id: 'gid://shopify/MediaImage/11', alt: 'Sand shirt, front' },
            { id: 'gid://shopify/MediaImage/12', alt: 'Sand shirt, back' },
          ],
        },
      ],
    };
    const productsInput = await addInput(next, 'products', 0, fixed);
    await scanPlanHandler({ sql })(
      input('scan.plan@1', { scan_id: second, site_id: f.siteId }, f.tenantId),
    );
    await runPages(next, scanPageHandler(deps({})));
    await auditDataHandler({ sql })(
      input(
        'audit.data@1',
        { input_id: productsInput, scan_id: second, site_id: f.siteId },
        f.tenantId,
      ),
    );
    await scanFinalizeHandler({ sql })(
      input('scan.finalize@1', { scan_id: second, site_id: f.siteId }, f.tenantId),
    );
    const left = await db.owner<{ rule_id: string; status: string }[]>`
      select rule_id, status from findings where site_id = ${f.siteId} order by rule_id`;
    expect(left.every((x) => x.status === 'fixed')).toBe(true);
    expect(left.map((x) => x.rule_id)).toContain('image-alt');
  });

  it('keeps a finding open when the page it was on was not loaded again', async () => {
    const f = await seed(db.owner, SHOP, { pages: 0 });
    await scanPlanHandler({ sql })(
      input('scan.plan@1', { scan_id: f.scanId, site_id: f.siteId }, f.tenantId),
    );
    await runPages(
      f,
      scanPageHandler(deps({ '/cart': (o) => pageScan(o.url, [imageAlt('form > img')]) })),
    );
    await scanFinalizeHandler({ sql })(
      input('scan.finalize@1', { scan_id: f.scanId, site_id: f.siteId }, f.tenantId),
    );
    const second = uuidv7();
    await db.owner`
      insert into scans (id, tenant_id, site_id, trigger, status, ruleset_version, pages_planned)
      values (${second}, ${f.tenantId}, ${f.siteId}, 'manual', 'queued', 'axe-4.14.0', 0)`;
    await scanPlanHandler({ sql })(
      input('scan.plan@1', { scan_id: second, site_id: f.siteId }, f.tenantId),
    );
    // The cart is blocked this time: it cannot be called fixed.
    const blocked = (o: ScanOptions): PageScan =>
      pageScan(o.url, [], o.url, { status: 403, blocked: 'captcha', states: [] });
    await runPages({ ...f, scanId: second }, scanPageHandler(deps({ '/cart': blocked })));
    await scanFinalizeHandler({ sql })(
      input('scan.finalize@1', { scan_id: second, site_id: f.siteId }, f.tenantId),
    );
    const [finding] = await db.owner<{ status: string }[]>`
      select status from findings where site_id = ${f.siteId} and rule_id = 'image-alt'`;
    expect(finding?.status).toBe('open');
  });
});

describe('verify.scan', () => {
  /** A site with an open alt-text finding and an applied fix for it. */
  async function applied() {
    const f = await seed(db.owner, SHOP, { pages: 0 });
    await addInput(f, 'shop', 0, { primary_locale: 'en' });
    const original = await addInput(f, 'products', 0, PRODUCTS);
    await auditDataHandler({ sql })(
      input(
        'audit.data@1',
        { input_id: original, scan_id: f.scanId, site_id: f.siteId },
        f.tenantId,
      ),
    );
    const [finding] = await db.owner<{ id: string; fingerprint: Buffer }[]>`
      select id, fingerprint from findings
       where site_id = ${f.siteId} and rule_id = 'rs-media-alt-empty'`;
    const fixId = uuidv7();
    await db.owner`
      insert into fixes (id, tenant_id, site_id, kind, channel, status, origin, model, prompt_version)
      values (${fixId}, ${f.tenantId}, ${f.siteId}, 'data', 'admin_api', 'applied', 'ai', 'claude-x', 'v1')`;
    await db.owner`
      insert into fix_findings (fix_id, finding_id, tenant_id) values (${fixId}, ${finding?.id ?? ''}, ${f.tenantId})`;
    await db.owner`
      insert into data_fix_snapshots (fix_id, tenant_id, resource_gid, field, before_value, after_value)
      values (${fixId}, ${f.tenantId}, 'gid://shopify/MediaImage/11', 'alt', '""'::jsonb,
              '"Linen shirt in sand, front"'::jsonb)`;
    const verifyScan = uuidv7();
    await db.owner`
      insert into scans (id, tenant_id, site_id, trigger, status, ruleset_version, pages_planned)
      values (${verifyScan}, ${f.tenantId}, ${f.siteId}, 'verify', 'queued', 'axe-4.14.0', 1)`;
    return { f, findingId: finding?.id ?? '', fixId, verifyScan };
  }

  function reread(product: Record<string, unknown>): { kind: string; items: unknown[] } {
    return { kind: 'products', items: [product] };
  }

  const payloadOf = (a: Awaited<ReturnType<typeof applied>>, inputId: string | null) => ({
    fix_id: a.fixId,
    input_id: inputId,
    scan_id: a.verifyScan,
    site_id: a.f.siteId,
    urls: [`${SHOP}/products/linen-shirt`],
  });

  it('verifies a fix when the finding is gone and nothing new appeared', async () => {
    const a = await applied();
    const fixedInput = await addInput(
      { ...a.f, scanId: a.verifyScan },
      'verify',
      0,
      reread({
        ...PRODUCTS.items[0],
        description_html: '',
        media: [
          { id: 'gid://shopify/MediaImage/11', alt: 'Linen shirt in sand, front' },
          { id: 'gid://shopify/MediaImage/12', alt: 'IMG_4032.jpg' },
        ],
      }),
    );
    const seen: ScanOptions[] = [];
    const base = deps({}, seen);
    const withCrop: EngineDeps = {
      ...base,
      scan: (b, o) =>
        (base.scan ?? scanPage)(b, o).then((s) => ({
          ...s,
          crops: { [o.cropSelectors?.[0] ?? '']: Buffer.from('png-bytes') },
        })),
    };
    await verifyScanHandler(withCrop)(
      input('verify.scan@1', payloadOf(a, fixedInput), a.f.tenantId),
    );
    expect(seen[0]?.cropSelectors).toEqual(['img[alt="Linen shirt in sand, front"]']);
    const [fix] = await db.owner<
      {
        status: string;
        verified_scan: string;
        verified: boolean;
        error_code: string | null;
        after: string | null;
      }[]
    >`select status, verified_scan, verified_at is not null as verified, error_code,
             after_evidence_id::text as after from fixes where id = ${a.fixId}`;
    expect(fix).toMatchObject({
      status: 'verified',
      verified_scan: a.verifyScan,
      verified: true,
      error_code: null,
    });
    expect(fix?.after).not.toBeNull();
    const [finding] = await db.owner<{ status: string }[]>`
      select status from findings where id = ${a.findingId}`;
    expect(finding?.status).toBe('fixed');
    const [scan] = await db.owner<{ status: string; finalized: boolean }[]>`
      select status, finalized_at is not null as finalized from scans where id = ${a.verifyScan}`;
    expect(scan).toEqual({ status: 'succeeded', finalized: true });
    // The verification scan is not finalised by scan.finalize: it would close everything else.
    await scanFinalizeHandler({ sql })(
      input('scan.finalize@1', { scan_id: a.verifyScan, site_id: a.f.siteId }, a.f.tenantId),
    );
    const [others] = await db.owner<{ n: number }[]>`
      select count(*)::int as n from findings where site_id = ${a.f.siteId} and status = 'open'`;
    expect(others?.n).toBeGreaterThan(0);
  });

  it('reopens the finding and keeps the fix applied when the finding remains', async () => {
    const a = await applied();
    const same = await addInput(
      { ...a.f, scanId: a.verifyScan },
      'verify',
      0,
      reread(PRODUCTS.items[0] as Record<string, unknown>),
    );
    await verifyScanHandler(deps({}))(input('verify.scan@1', payloadOf(a, same), a.f.tenantId));
    const [fix] = await db.owner<{ status: string; error_code: string; verified: boolean }[]>`
      select status, error_code, verified_at is not null as verified from fixes where id = ${a.fixId}`;
    expect(fix).toEqual({
      status: 'applied',
      error_code: 'verify_finding_remains',
      verified: false,
    });
    const [finding] = await db.owner<{ status: string }[]>`
      select status from findings where id = ${a.findingId}`;
    expect(finding?.status).toBe('open');
  });

  it('fails the verdict when the rescan shows something new', async () => {
    const a = await applied();
    const fixedInput = await addInput(
      { ...a.f, scanId: a.verifyScan },
      'verify',
      0,
      reread({
        ...PRODUCTS.items[0],
        media: [{ id: 'gid://shopify/MediaImage/11', alt: 'Linen shirt in sand, front' }],
      }),
    );
    const script: Script = {
      '/products/linen-shirt': (o) => pageScan(o.url, [contrast('main p.price')]),
    };
    await verifyScanHandler(deps(script))(
      input('verify.scan@1', payloadOf(a, fixedInput), a.f.tenantId),
    );
    const [fix] = await db.owner<{ status: string; error_code: string }[]>`
      select status, error_code from fixes where id = ${a.fixId}`;
    expect(fix).toEqual({ status: 'applied', error_code: 'verify_new_findings' });
    const [finding] = await db.owner<{ status: string }[]>`
      select status from findings where id = ${a.findingId}`;
    expect(finding?.status).toBe('fixed');
    const [added] = await db.owner<{ status: string; first_seen_scan: string }[]>`
      select status, first_seen_scan from findings where site_id = ${a.f.siteId} and rule_id = 'color-contrast'`;
    expect(added).toEqual({ status: 'open', first_seen_scan: a.verifyScan });
  });

  it('cannot verify what it cannot read: no re-read input, or a resource missing from it', async () => {
    const a = await applied();
    await verifyScanHandler(deps({}))(input('verify.scan@1', payloadOf(a, null), a.f.tenantId));
    const [fix] = await db.owner<{ status: string; error_code: string }[]>`
      select status, error_code from fixes where id = ${a.fixId}`;
    expect(fix).toEqual({ status: 'applied', error_code: 'verify_unreadable' });
  });

  it('is idempotent and tenant-bound', async () => {
    const a = await applied();
    const fixedInput = await addInput(
      { ...a.f, scanId: a.verifyScan },
      'verify',
      0,
      reread({ ...PRODUCTS.items[0], media: [{ id: 'gid://shopify/MediaImage/11', alt: 'Sand' }] }),
    );
    const run = verifyScanHandler(deps({}));
    await run(input('verify.scan@1', payloadOf(a, fixedInput), a.f.tenantId));
    await run(input('verify.scan@1', payloadOf(a, fixedInput), a.f.tenantId));
    const other = await seed(db.owner, SHOP);
    await expect(
      run(input('verify.scan@1', payloadOf(a, fixedInput), other.tenantId)),
    ).rejects.toMatchObject({ failure: { kind: 'permanent', error: { code: 'fix_not_found' } } });
  });
});
