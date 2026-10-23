/**
 * The emails the pipeline queues when work finishes (ADR-279): `first_scan_complete` and
 * `weekly_summary` from `scan.finalize`, `fix_verified` from `verify.scan`. Real handlers against
 * PostgreSQL with a fake page scanner, then the queued job run through the real `email.send`
 * handler against the SES stand-in: what is queued fits its template, goes out once, reaches the
 * merchant only when preferences and the suppression list allow it, and links into the app in
 * the merchant's admin.
 */
import { startFakeSes, type FakeSes } from '@rampsmith/email/testing';
import { uuidv7 } from '@rampsmith/queue';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditDataHandler } from '../src/jobs/audit-data.ts';
import { createEmailRuntime, type EmailRuntime } from '../src/email/runtime.ts';
import { emailSendHandler } from '../src/jobs/email-send.ts';
import { scanFinalizeHandler } from '../src/jobs/finalize.ts';
import type { JobInput } from '../src/jobs/payload.ts';
import { scanPlanHandler } from '../src/jobs/plan.ts';
import { verifyScanHandler } from '../src/jobs/verify.ts';
import { scanPageHandler, type EngineDeps } from '../src/worker.ts';
import { freshDatabase, seed, type Fixture, type TestDatabase } from './db.ts';
import { pageScan } from './scans.ts';

const ACCESS_KEY = 'AKIDTESTONLY0000000';
const SECRET = 'test-only-secret-key/not+a+credential';
const OWNER = 'owner-of-trigger-store@trigger-store.example';
const SHOP = 'https://shop.example';
const ENV = {
  APP_ORIGIN: 'https://app.rampsmith.example',
  EMAIL_LINK_KEYS: `k1:${Buffer.alloc(32, 7).toString('base64')}`,
  EMAIL_ONE_CLICK_ORIGIN: 'https://hooks.rampsmith.example',
  EMAIL_FROM: 'Rampsmith <hello@rampsmith.example>',
  EMAIL_POSTAL_ADDRESS: '100 Example Street\nSpringfield, EX 00000\nUnited States (test fixture)',
  SES_REGION: 'eu-west-1',
  SES_ACCESS_KEY_ID: ACCESS_KEY,
  SES_SECRET_ACCESS_KEY: SECRET,
};

let db: TestDatabase;
let sql: postgres.Sql;
let ses: FakeSes;
let runtime: EmailRuntime;

beforeAll(async () => {
  db = await freshDatabase();
  sql = db.as('rampsmith_worker');
  ses = await startFakeSes({
    region: ENV.SES_REGION,
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET,
  });
  runtime = createEmailRuntime(ENV, { endpoint: ses.endpoint });
});
afterAll(async () => {
  await ses.close();
  await db.drop();
});

function input(schema: string, payload: unknown, tenantId: string): JobInput {
  return { payloadSchema: schema, payload, tenantId };
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
      ],
    },
  ],
};

const FIXED = {
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

const deps = (): EngineDeps => ({
  sql,
  browser: undefined as never,
  egress: { proxyUrl: 'http://127.0.0.1:1', tokenSecret: 'test-secret-0123456789abcdef0123' },
  userAgent: 'test',
  scan: (_browser, options) => Promise.resolve(pageScan(options.url, [])),
});

async function addInput(f: Fixture, kind: string, seq: number, payload: unknown): Promise<string> {
  const id = uuidv7();
  await db.owner`
    insert into scan_inputs (id, tenant_id, scan_id, site_id, kind, seq, payload)
    values (${id}, ${f.tenantId}, ${f.scanId}, ${f.siteId}, ${kind}, ${seq},
            ${db.owner.json(payload as postgres.JSONValue)})`;
  return id;
}

interface Store extends Fixture {
  readonly shopId: string;
  readonly domain: string;
}

/** An installed store with its owner's contact (unless told otherwise) and a scan not yet run. */
async function store(contact = true): Promise<Store> {
  const f = await seed(db.owner, SHOP, { pages: 0 });
  const shopId = uuidv7();
  const domain = `t${shopId.slice(-12).replaceAll('-', '')}.myshopify.com`;
  await db.owner`
    insert into shopify_shops (id, tenant_id, site_id, shop_domain, scopes, api_version, status, installed_at)
    values (${shopId}, ${f.tenantId}, ${f.siteId}, ${domain}, ${db.owner.array(['read_products'])},
            '2026-10', 'installed', now())`;
  if (contact) {
    await db.owner`
      insert into shop_contacts (shop_id, tenant_id, email, store_name, locale)
      values (${shopId}, ${f.tenantId}, ${OWNER}, 'Trigger Outfitters', 'en')`;
  }
  return { ...f, shopId, domain };
}

/** Plans, scans (nothing found on the pages), audits the data and finalises one scan. */
async function runScan(s: Store, scanId: string, products: unknown): Promise<void> {
  const f: Fixture = { tenantId: s.tenantId, siteId: s.siteId, scanId };
  await addInput(f, 'shop', 0, { primary_locale: 'en' });
  const productsInput = await addInput(f, 'products', 0, products);
  await scanPlanHandler({ sql })(
    input('scan.plan@1', { scan_id: scanId, site_id: s.siteId }, s.tenantId),
  );
  const pages = await db.owner<{ payload: Record<string, unknown> }[]>`
    select payload from jobs where queue = 'scan.page' and payload ->> 'scan_id' = ${scanId}
     order by (payload ->> 'seq')::int`;
  for (const job of pages) {
    await scanPageHandler(deps())(input('scan.page@2', job.payload, s.tenantId));
  }
  await auditDataHandler({ sql })(
    input(
      'audit.data@1',
      { input_id: productsInput, scan_id: scanId, site_id: s.siteId },
      s.tenantId,
    ),
  );
  await scanFinalizeHandler({ sql })(
    input('scan.finalize@1', { scan_id: scanId, site_id: s.siteId }, s.tenantId),
  );
}

async function newScan(s: Store, trigger: 'manual' | 'scheduled'): Promise<string> {
  const id = uuidv7();
  await db.owner`
    insert into scans (id, tenant_id, site_id, trigger, status, ruleset_version, pages_planned)
    values (${id}, ${s.tenantId}, ${s.siteId}, ${trigger}, 'queued', 'axe-4.14.0', 0)`;
  return id;
}

interface EmailJob {
  payload: { template: string; message_key: string; input: Record<string, unknown> };
  idempotency_key: string;
}

async function emailJobs(s: Store): Promise<EmailJob[]> {
  return db.owner<EmailJob[]>`
    select payload, idempotency_key from jobs
     where queue = 'email.send' and tenant_id = ${s.tenantId} order by created_at, id`;
}

async function deliver(s: Store, job: EmailJob): Promise<void> {
  await emailSendHandler({ sql, email: runtime, random: () => 0.5 })(
    input('email.send@1', job.payload, s.tenantId),
  );
}

describe('the first scan', () => {
  it('queues one first_scan_complete, which renders, links into the admin and is sent once', async () => {
    const s = await store();
    const scan = s.scanId;
    await runScan(s, scan, PRODUCTS);
    const jobs = await emailJobs(s);
    expect(jobs.map((j) => j.payload.template)).toEqual(['first_scan_complete']);
    const [job] = jobs;
    expect(job?.payload.message_key).toBe(`first-scan-complete:${s.siteId}`);
    expect(job?.idempotency_key).toBe(`email.send:first-scan-complete:${s.siteId}`);
    expect(job?.payload).toMatchObject({
      recipient: { kind: 'shop_owner', shop_id: s.shopId },
      input: { storeName: 'Trigger Outfitters', locale: 'en' },
    });
    // The queue holds a reference, not the address.
    expect(JSON.stringify(job)).not.toContain(OWNER);

    // Finalising again is a no-op: no second email.
    await scanFinalizeHandler({ sql })(
      input('scan.finalize@1', { scan_id: scan, site_id: s.siteId }, s.tenantId),
    );
    expect(await emailJobs(s)).toHaveLength(1);

    const before = ses.requests.length;
    if (job === undefined) throw new Error('no job');
    await deliver(s, job);
    await deliver(s, job);
    expect(ses.requests.length - before).toBe(1);
    const text = ses.requests[before]?.body.Content.Simple.Body.Text?.Data ?? '';
    const handle = s.domain.replace('.myshopify.com', '');
    expect(text).toContain(`https://admin.shopify.com/store/${handle}/apps/rampsmith/findings`);
    expect(text).toMatch(/List-Unsubscribe|unsubscribe/iu);
    expect(ses.requests[before]?.body.Destination.ToAddresses).toEqual([OWNER]);
  });

  it('is dropped, not sent, when the store uninstalled before it went out', async () => {
    const s = await store();
    await runScan(s, s.scanId, PRODUCTS);
    const [job] = await emailJobs(s);
    if (job === undefined) throw new Error('no job');
    await db.owner`update shopify_shops set status = 'uninstalled', uninstalled_at = now() where id = ${s.shopId}`;
    const before = ses.requests.length;
    await deliver(s, job);
    expect(ses.requests.length - before).toBe(0);
    const [row] = await db.owner<{ state: string; error_code: string }[]>`
      select state, error_code from email_deliveries
       where tenant_id = ${s.tenantId} and message_key = ${job.payload.message_key}`;
    expect(row).toEqual({ state: 'suppressed', error_code: 'suppressed_shop_left' });
  });

  it('queues nothing for a store with no contact', async () => {
    const s = await store(false);
    await runScan(s, s.scanId, PRODUCTS);
    expect(await emailJobs(s)).toEqual([]);
  });

  it('queues nothing when the scan failed', async () => {
    const s = await store();
    const f: Fixture = s;
    await scanPlanHandler({ sql })(
      input('scan.plan@1', { scan_id: f.scanId, site_id: f.siteId }, f.tenantId),
    );
    const blocked: EngineDeps = {
      ...deps(),
      scan: (_b, o) =>
        Promise.resolve(
          pageScan(o.url, [], o.url, { status: 403, blocked: 'captcha', states: [] }),
        ),
    };
    const pages = await db.owner<{ payload: Record<string, unknown> }[]>`
      select payload from jobs where queue = 'scan.page' and payload ->> 'scan_id' = ${f.scanId}`;
    for (const job of pages) {
      await scanPageHandler(blocked)(input('scan.page@2', job.payload, f.tenantId));
    }
    await scanFinalizeHandler({ sql })(
      input('scan.finalize@1', { scan_id: f.scanId, site_id: f.siteId }, f.tenantId),
    );
    const [scan] = await db.owner<{ status: string }[]>`
      select status from scans where id = ${f.scanId}`;
    expect(scan?.status).toBe('failed');
    expect(await emailJobs(s)).toEqual([]);
  });

  it('is held back by the merchant: an opt-out or a suppressed address sends nothing', async () => {
    for (const how of ['opt_out', 'bounced', 'unsubscribed'] as const) {
      const s = await store();
      await runScan(s, s.scanId, PRODUCTS);
      const [job] = await emailJobs(s);
      if (job === undefined) throw new Error('no job');
      if (how === 'opt_out') {
        await db.owner`
          insert into email_opt_outs (tenant_id, address_hash, category)
          values (${s.tenantId}, email_address_hash(${s.tenantId}::uuid, ${OWNER}), 'notification')`;
      } else {
        await db.owner`
          insert into email_suppressions (tenant_id, address_hash, reason)
          values (${s.tenantId}, email_address_hash(${s.tenantId}::uuid, ${OWNER}), ${how})`;
      }
      const before = ses.requests.length;
      await deliver(s, job);
      expect(ses.requests.length - before, how).toBe(0);
      const [row] = await db.owner<{ state: string }[]>`
        select state from email_deliveries
         where tenant_id = ${s.tenantId} and message_key = ${job.payload.message_key}`;
      expect(row?.state, how).toBe('suppressed');
    }
  });
});

describe('the weekly rescan', () => {
  it('queues a weekly_summary for a scheduled rescan, once, and none for a manual one', async () => {
    const s = await store();
    await runScan(s, s.scanId, PRODUCTS);
    expect((await emailJobs(s)).map((j) => j.payload.template)).toEqual(['first_scan_complete']);

    // A manual rescan: the merchant is in the app; no email.
    await runScan(s, await newScan(s, 'manual'), FIXED);
    expect(await emailJobs(s)).toHaveLength(1);

    const weekly = await newScan(s, 'scheduled');
    await runScan(s, weekly, FIXED);
    const jobs = await emailJobs(s);
    expect(jobs.map((j) => j.payload.template)).toEqual(['first_scan_complete', 'weekly_summary']);
    const summary = jobs[1];
    expect(summary?.payload.message_key).toBe(`weekly-summary:${weekly}`);
    expect(summary?.payload.input).toMatchObject({
      storeName: 'Trigger Outfitters',
      newIssues: 0,
      fixesAwaitingApproval: 0,
    });
    expect(summary?.payload.input['previousChecks']).toBeDefined();
    expect(summary?.payload.input['nextScanAt']).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:]+Z$/u);

    await scanFinalizeHandler({ sql })(
      input('scan.finalize@1', { scan_id: weekly, site_id: s.siteId }, s.tenantId),
    );
    expect(await emailJobs(s)).toHaveLength(2);

    const before = ses.requests.length;
    if (summary === undefined) throw new Error('no summary');
    await deliver(s, summary);
    expect(ses.requests.length - before).toBe(1);
    const text = ses.requests[before]?.body.Content.Simple.Body.Text?.Data ?? '';
    expect(text).toContain('/apps/rampsmith');
  });
});

describe('a verified fix', () => {
  async function applied(s: Store) {
    const original = await addInput(s, 'products', 0, PRODUCTS);
    await addInput(s, 'shop', 0, { primary_locale: 'en' });
    await auditDataHandler({ sql })(
      input(
        'audit.data@1',
        { input_id: original, scan_id: s.scanId, site_id: s.siteId },
        s.tenantId,
      ),
    );
    const [finding] = await db.owner<{ id: string }[]>`
      select id from findings where site_id = ${s.siteId} and rule_id = 'rs-media-alt-empty'`;
    const fixId = uuidv7();
    await db.owner`
      insert into fixes (id, tenant_id, site_id, kind, channel, status, origin, model, prompt_version)
      values (${fixId}, ${s.tenantId}, ${s.siteId}, 'data', 'admin_api', 'applied', 'ai', 'claude-x', 'v1')`;
    await db.owner`
      insert into fix_findings (fix_id, finding_id, tenant_id) values (${fixId}, ${finding?.id ?? ''}, ${s.tenantId})`;
    await db.owner`
      insert into data_fix_snapshots (fix_id, tenant_id, resource_gid, field, before_value, after_value)
      values (${fixId}, ${s.tenantId}, 'gid://shopify/MediaImage/11', 'alt', '""'::jsonb,
              '"Sand shirt, front"'::jsonb)`;
    const verifyScan = uuidv7();
    await db.owner`
      insert into scans (id, tenant_id, site_id, trigger, status, ruleset_version, pages_planned)
      values (${verifyScan}, ${s.tenantId}, ${s.siteId}, 'verify', 'queued', 'axe-4.14.0', 1)`;
    return { fixId, verifyScan };
  }

  async function verify(
    s: Store,
    a: { fixId: string; verifyScan: string },
    items: unknown,
    times = 1,
  ) {
    const inputId = await addInput({ ...s, scanId: a.verifyScan }, 'verify', 0, {
      kind: 'products',
      items: (items as { items: unknown[] }).items,
    });
    for (let i = 0; i < times; i += 1) {
      await verifyScanHandler(deps())(
        input(
          'verify.scan@1',
          {
            fix_id: a.fixId,
            input_id: inputId,
            scan_id: a.verifyScan,
            site_id: s.siteId,
            urls: [`${SHOP}/products/linen-shirt`],
          },
          s.tenantId,
        ),
      );
    }
  }

  it('queues one fix_verified when the fix checks out, and sends it with a link to the log', async () => {
    const s = await store();
    const a = await applied(s);
    await verify(s, a, FIXED, 2);
    const jobs = await emailJobs(s);
    expect(jobs.map((j) => j.payload.template)).toEqual(['fix_verified']);
    expect(jobs[0]?.payload.message_key).toBe(`fix-verified:${a.fixId}`);
    expect(jobs[0]?.payload.input).toMatchObject({
      verified: [{ criterion: '1.1.1' }],
      notVerified: [],
    });
    const before = ses.requests.length;
    if (jobs[0] === undefined) throw new Error('no job');
    await deliver(s, jobs[0]);
    expect(ses.requests.length - before).toBe(1);
    expect(ses.requests[before]?.body.Content.Simple.Body.Text?.Data ?? '').toContain(
      '/apps/rampsmith/log',
    );
  });

  it('says so when the fix does not check out', async () => {
    const s = await store();
    const a = await applied(s);
    await verify(s, a, PRODUCTS);
    const jobs = await emailJobs(s);
    expect(jobs.map((j) => j.payload.template)).toEqual(['fix_verified']);
    expect(jobs[0]?.payload.message_key).toBe(`fix-unverified:${a.fixId}`);
    expect(jobs[0]?.payload.input).toMatchObject({ verified: [], notVerified: [{}] });
    if (jobs[0] === undefined) throw new Error('no job');
    await deliver(s, jobs[0]);
  });

  it('queues nothing for a store with no contact', async () => {
    const s = await store(false);
    const a = await applied(s);
    await verify(s, a, FIXED);
    expect(await emailJobs(s)).toEqual([]);
  });
});
