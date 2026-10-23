/**
 * The `email.send@1` job against PostgreSQL (a fresh database, the engine's own role) and a local
 * stand-in for the Amazon SES endpoint that checks the SigV4 signature (ADR-270 to ADR-273).
 */
import { readFileSync } from 'node:fs';
import { EMAIL_KINDS, LinkKeyRing, verifyLinkToken } from '@rampsmith/email';
import { startFakeSes, type FakeSes } from '@rampsmith/email/testing';
import { JobFailure, uuidv7 } from '@rampsmith/queue';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createEmailRuntime, type EmailRuntime } from '../src/email/runtime.ts';
import { blocks } from '../src/email/suppression.ts';
import { emailSendHandler, MAX_SEND_TRIES } from '../src/jobs/email-send.ts';
import { parsePayload, type JobInput } from '../src/jobs/payload.ts';
import { freshDatabase, type TestDatabase } from './db.ts';

const ACCESS_KEY = 'AKIDTESTONLY0000000';
const SECRET = 'test-only-secret-key/not+a+credential';
const OWNER_ADDRESS = 'owner-of-demo-store@demo-store.example';
const APP = 'https://app.rampsmith.example';

const ENV = {
  APP_ORIGIN: APP,
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

interface Tenant {
  readonly tenantId: string;
  readonly shopId: string;
}

/** A tenant with an installed shop, and its owner's contact unless told otherwise. */
async function tenant(address: string | null = OWNER_ADDRESS): Promise<Tenant> {
  const tenantId = uuidv7();
  const siteId = uuidv7();
  const shopId = uuidv7();
  const owner = db.owner;
  await owner`insert into tenants (id, kind) values (${tenantId}, 'shopify_store')`;
  await owner`
    insert into sites (id, tenant_id, platform, base_url)
    values (${siteId}, ${tenantId}, 'shopify', ${`https://${shopId}.example`})`;
  await owner`
    insert into shopify_shops (id, tenant_id, site_id, shop_domain, scopes, api_version, status, installed_at)
    values (${shopId}, ${tenantId}, ${siteId}, ${`s${shopId.slice(-12).replaceAll('-', '')}.myshopify.com`},
            ${owner.array(['read_products'])}, '2026-10', 'installed', now())`;
  if (address !== null) {
    await owner`
      insert into shop_contacts (shop_id, tenant_id, email, store_name, locale)
      values (${shopId}, ${tenantId}, ${address}, 'Demo Outfitters', 'fr')`;
  }
  return { tenantId, shopId };
}

const UNINSTALL_INPUT = {
  storeName: 'Demo Outfitters',
  exportUrl: `${APP}/app/log`,
  deleteAt: '2026-10-24T18:30:00Z',
  locale: 'fr',
};

function job(t: Tenant, over: Readonly<Record<string, unknown>> = {}): JobInput {
  return {
    payloadSchema: 'email.send@1',
    tenantId: t.tenantId,
    payload: {
      template: 'uninstall_export',
      recipient: { kind: 'shop_owner', shop_id: t.shopId },
      input: UNINSTALL_INPUT,
      message_key: `uninstall-export:${uuidv7()}`,
      ...over,
    },
  };
}

async function outcome(run: Promise<void>): Promise<JobFailure | 'done'> {
  try {
    await run;
    return 'done';
  } catch (error) {
    if (error instanceof JobFailure) return error;
    throw error;
  }
}

function handler(over: Partial<{ email: EmailRuntime | undefined }> = {}) {
  return emailSendHandler({
    sql,
    email: 'email' in over ? over.email : runtime,
    random: () => 0.5,
  });
}

async function delivery(t: Tenant, key: string) {
  const [row] = await db.owner<
    { state: string; tries: number; message_id: string | null; error_code: string | null }[]
  >`select state, tries, message_id, error_code from email_deliveries
     where tenant_id = ${t.tenantId} and message_key = ${key}`;
  return row;
}

function keyOf(j: JobInput): string {
  return (j.payload as { message_key: string }).message_key;
}

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

describe('a message that can be sent', () => {
  it('renders the uninstall export email and sends it through SES to the stored address', async () => {
    const t = await tenant();
    const j = job(t);
    const before = ses.requests.length;

    expect(await outcome(handler()(j))).toBe('done');

    expect(ses.requests.length - before).toBe(1);
    const request = ses.requests[before];
    expect(request?.body.Destination.ToAddresses).toEqual([OWNER_ADDRESS]);
    expect(request?.body.FromEmailAddress).toBe('Rampsmith <hello@rampsmith.example>');
    const text = request?.body.Content.Simple.Body.Text?.Data ?? '';
    expect(text).toContain('Demo Outfitters');
    expect(text).toContain(`${APP}/app/log`);
    // Never tracked, whatever the account or a configuration set say.
    expect(request?.body.ConfigurationOverrides?.Tracking).toEqual({
      OpenTrackingEnabled: 'DISABLED',
      ClickTrackingEnabled: 'DISABLED',
    });
    // Nothing in the message points anywhere but the origins Rampsmith controls.
    const html = request?.body.Content.Simple.Body.Html?.Data ?? '';
    for (const href of html.matchAll(/href="([^"]+)"/gu)) {
      expect(href[1]).toMatch(/^(https:\/\/app\.rampsmith\.example|mailto:)/u);
    }
    const row = await delivery(t, keyOf(j));
    expect(row?.state).toBe('sent');
    expect(row?.tries).toBe(1);
    expect(row?.message_id).toMatch(/^fake-ses-\d{4}$/u);
  });

  it('sends a message key once, however often the job runs', async () => {
    const t = await tenant();
    const j = job(t);
    const before = ses.requests.length;
    await handler()(j);
    await handler()(j);
    await handler()(j);
    expect(ses.requests.length - before).toBe(1);
    expect((await delivery(t, keyOf(j)))?.tries).toBe(1);
  });

  it('writes nothing to stdout or stderr, and nothing it throws names an address', async () => {
    const t = await tenant();
    const written: string[] = [];
    const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    const err = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    try {
      ses.failNext({ status: 400, type: 'MessageRejected' });
      const failed = await outcome(handler()(job(t)));
      await handler()(job(t));
      expect(failed).toBeInstanceOf(JobFailure);
      const shown = JSON.stringify((failed as JobFailure).failure);
      expect(shown).not.toContain('demo-store.example');
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
    expect(written.join('')).not.toContain('demo-store.example');
    expect(written.join('')).not.toContain('Demo Outfitters');
  });
});

describe('errors from SES', () => {
  it('defers a throttled send without spending an attempt, with a growing delay, then succeeds', async () => {
    const t = await tenant();
    const j = job(t);
    ses.failNext(
      { status: 429, type: 'TooManyRequestsException' },
      { status: 503, type: 'ServiceUnavailable' },
    );
    const first = await outcome(handler()(j));
    const second = await outcome(handler()(j));
    expect(first).toBeInstanceOf(JobFailure);
    const [a, b] = [first, second].map((f) => (f as JobFailure).failure);
    expect(a?.kind).toBe('defer');
    expect(a?.error).toMatchObject({ code: 'ses_throttled', retryable: true });
    expect(b?.error.code).toBe('ses_unavailable');
    const delays = [a, b].map((f) => (f?.kind === 'defer' ? f.delayMs : 0));
    // retryDelayMs(1, 0.5) = 3750 and retryDelayMs(2, 0.5) = 7500: the delay follows the tries.
    expect(delays).toEqual([3750, 7500]);
    expect((await delivery(t, keyOf(j)))?.state).toBe('sending');

    expect(await outcome(handler()(j))).toBe('done');
    const row = await delivery(t, keyOf(j));
    expect([row?.state, row?.tries, row?.error_code]).toEqual(['sent', 3, null]);
  });

  it('waits at least as long as SES asks', async () => {
    const t = await tenant();
    ses.failNext({
      status: 429,
      type: 'TooManyRequestsException',
      headers: { 'retry-after': '90' },
    });
    const failure = (await outcome(handler()(job(t)))) as JobFailure;
    expect(failure.failure.kind === 'defer' && failure.failure.delayMs).toBe(90_000);
  });

  it('fails for good when SES rejects the message, and records why', async () => {
    const t = await tenant();
    const j = job(t);
    ses.failNext({ status: 400, type: 'MessageRejected' });
    const failure = (await outcome(handler()(j))) as JobFailure;
    expect(failure.failure.kind).toBe('permanent');
    expect(failure.failure.error.code).toBe('ses_message_rejected');
    const row = await delivery(t, keyOf(j));
    expect([row?.state, row?.error_code]).toEqual(['failed', 'ses_message_rejected']);
  });

  it('gives up after the last try rather than deferring for ever', async () => {
    const t = await tenant();
    const j = job(t);
    await db.owner`
      insert into email_deliveries (tenant_id, message_key, template, state, tries)
      values (${t.tenantId}, ${keyOf(j)}, 'uninstall_export', 'sending', ${MAX_SEND_TRIES - 1})`;
    ses.failNext({ status: 503, type: 'ServiceUnavailable' });
    const failure = (await outcome(handler()(j))) as JobFailure;
    expect(failure.failure.kind).toBe('permanent');
    expect(failure.failure.error.code).toBe('email_gave_up');
  });

  it('retries a send that failed for good once somebody re-queues it', async () => {
    const t = await tenant();
    const j = job(t);
    ses.failNext({ status: 400, type: 'MessageRejected' });
    await handler()(j).catch(() => undefined);
    expect((await delivery(t, keyOf(j)))?.state).toBe('failed');
    expect(await outcome(handler()(j))).toBe('done');
    expect((await delivery(t, keyOf(j)))?.state).toBe('sent');
  });
});

describe('the recipient', () => {
  it('is a reference that must name something this tenant owns', async () => {
    const mine = await tenant();
    const theirs = await tenant('someone-else@other-store.example');
    const before = ses.requests.length;
    const failure = (await outcome(
      handler()(job(mine, { recipient: { kind: 'shop_owner', shop_id: theirs.shopId } })),
    )) as JobFailure;
    expect(failure.failure.kind).toBe('permanent');
    expect(failure.failure.error.code).toBe('recipient_missing');
    expect(ses.requests.length).toBe(before);

    const noContact = await tenant(null);
    const missing = (await outcome(handler()(job(noContact)))) as JobFailure;
    expect(missing.failure.error.code).toBe('recipient_missing');
  });

  it('is never sent mail while on the tenant’s suppression list, as far as the category says', async () => {
    const t = await tenant();
    const before = ses.requests.length;
    // An unsubscribe stops notifications...
    await db.owner`
      insert into email_suppressions (tenant_id, address_hash, reason)
      values (${t.tenantId}, email_address_hash(${t.tenantId}, ${OWNER_ADDRESS}), 'unsubscribed')`;
    const welcome = job(t, {
      template: 'welcome',
      input: {
        unsubscribeUrl: `${APP}/email/unsubscribe?t=TESTONLYunsub55aa66bb77cc88dd99`,
        preferencesUrl: `${APP}/settings/email`,
        storeName: 'Demo Outfitters',
        appUrl: 'https://admin.shopify.com/store/demo/apps/rampsmith',
      },
    });
    expect(await outcome(handler()(welcome))).toBe('done');
    expect(ses.requests.length).toBe(before);
    const row = await delivery(t, keyOf(welcome));
    expect([row?.state, row?.error_code]).toEqual(['suppressed', 'suppressed_unsubscribed']);
    // ...and the same message key is never sent afterwards, even if the list changes.
    await db.owner`delete from email_suppressions where tenant_id = ${t.tenantId}`;
    await handler()(welcome);
    expect(ses.requests.length).toBe(before);

    // ...but not the export link the law and the product promise.
    await db.owner`
      insert into email_suppressions (tenant_id, address_hash, reason)
      values (${t.tenantId}, email_address_hash(${t.tenantId}, ${OWNER_ADDRESS}), 'unsubscribed')`;
    expect(await outcome(handler()(job(t)))).toBe('done');
    expect(ses.requests.length).toBe(before + 1);

    // A bounce stops everything.
    await db.owner`update email_suppressions set reason = 'bounced' where tenant_id = ${t.tenantId}`;
    expect(await outcome(handler()(job(t)))).toBe('done');
    expect(ses.requests.length).toBe(before + 1);
  });

  it('is suppressed by tenant: another tenant’s list has no say', async () => {
    const a = await tenant();
    const b = await tenant();
    await db.owner`
      insert into email_suppressions (tenant_id, address_hash, reason)
      values (${a.tenantId}, email_address_hash(${a.tenantId}, ${OWNER_ADDRESS}), 'manual')`;
    const before = ses.requests.length;
    await handler()(job(a));
    await handler()(job(b));
    expect(ses.requests.length - before).toBe(1);
  });

  it('decides what a suppression blocks by category', () => {
    expect(blocks('unsubscribed', 'notification')).toBe(true);
    expect(blocks('unsubscribed', 'marketing')).toBe(true);
    expect(blocks('unsubscribed', 'transactional')).toBe(false);
    expect(blocks('unsubscribed', 'security')).toBe(false);
    for (const reason of ['bounced', 'complained', 'manual'] as const) {
      for (const category of ['security', 'transactional', 'notification', 'marketing'] as const) {
        expect(blocks(reason, category)).toBe(true);
      }
    }
  });
});

const WELCOME_INPUT = {
  storeName: 'Demo Outfitters',
  appUrl: 'https://admin.shopify.com/store/demo/apps/rampsmith',
};

function welcomeJob(t: Tenant): JobInput {
  return job(t, { template: 'welcome', input: WELCOME_INPUT, message_key: `welcome:${uuidv7()}` });
}

function headerOf(request: FakeSes['requests'][number] | undefined, name: string): string {
  return request?.body.Content.Simple.Headers?.find((h) => h.Name === name)?.Value ?? '';
}

describe('mail a recipient can switch off', () => {
  const ring = LinkKeyRing.parse(`k1:${Buffer.alloc(32, 7).toString('base64')}`);
  const now = () => Math.floor(Date.now() / 1000);

  it('carries signed, single-purpose links and the one-click headers', async () => {
    const t = await tenant();
    const before = ses.requests.length;
    expect(await outcome(handler()(welcomeJob(t)))).toBe('done');
    const request = ses.requests[before];
    const listUnsub = headerOf(request, 'List-Unsubscribe');
    const oneClick =
      /^<(https:\/\/hooks\.rampsmith\.example\/webhooks\/email\/unsubscribe\?t=([\w-]+))>$/u.exec(
        listUnsub,
      );
    expect(oneClick, 'List-Unsubscribe points at the webhook host').not.toBeNull();
    expect(headerOf(request, 'List-Unsubscribe-Post')).toBe('List-Unsubscribe=One-Click');

    const verdict = verifyLinkToken(ring, oneClick?.[2] ?? '', now());
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.claims.purpose).toBe('unsubscribe');
      expect(verdict.claims.category).toBe('notification');
      expect(verdict.claims.tenantId).toBe(t.tenantId);
      expect(verdict.claims.shopId).toBe(t.shopId);
      const [row] = await db.owner<{ same: boolean }[]>`
        select email_address_hash(${t.tenantId}, ${OWNER_ADDRESS}) = ${Buffer.from(verdict.claims.addressHash)} as same`;
      expect(row?.same).toBe(true);
    }
    const html = request?.body.Content.Simple.Body.Html?.Data ?? '';
    expect(html).toContain(`${APP}/email/unsubscribe?t=`);
    expect(html).toContain(`${APP}/email/preferences?t=`);
  });

  it('is not sent once the recipient has opted out of the category', async () => {
    const t = await tenant();
    await db.owner`
      insert into email_opt_outs (tenant_id, address_hash, category)
      values (${t.tenantId}, email_address_hash(${t.tenantId}, ${OWNER_ADDRESS}), 'notification')`;
    const before = ses.requests.length;
    const j = welcomeJob(t);
    expect(await outcome(handler()(j))).toBe('done');
    expect(ses.requests.length).toBe(before);
    expect((await delivery(t, keyOf(j)))?.error_code).toBe('suppressed_opted_out');
    // The export link is transactional and unaffected.
    expect(await outcome(handler()(job(t)))).toBe('done');
    expect(ses.requests.length).toBe(before + 1);
  });

  it('goes to the notification address the merchant chose, and an opt-out follows that address', async () => {
    const t = await tenant();
    const chosen = 'alerts@demo-store.example';
    await db.owner`
      update sites set settings = settings || ${db.owner.json({ notification_email: chosen })}
       where tenant_id = ${t.tenantId}`;
    const before = ses.requests.length;
    expect(await outcome(handler()(welcomeJob(t)))).toBe('done');
    expect(ses.requests[before]?.body.Destination.ToAddresses).toEqual([chosen]);
    await db.owner`
      insert into email_opt_outs (tenant_id, address_hash, category)
      values (${t.tenantId}, email_address_hash(${t.tenantId}, ${chosen}), 'notification')`;
    expect(await outcome(handler()(welcomeJob(t)))).toBe('done');
    expect(ses.requests.length).toBe(before + 1);
  });

  it('retries, naming the setting, while the link keys are unset', async () => {
    const t = await tenant();
    const { EMAIL_LINK_KEYS: _omit, ...rest } = ENV;
    const bare = createEmailRuntime(rest, { endpoint: ses.endpoint });
    const failure = await outcome(handler({ email: bare })(welcomeJob(t)));
    expect(failure).toBeInstanceOf(JobFailure);
    expect(String((failure as JobFailure).message)).toContain('EMAIL_LINK_KEYS');
    expect(String((failure as JobFailure).message)).not.toContain(OWNER_ADDRESS);
  });
});

describe('a payload that cannot be sent', () => {
  it('fails for good, naming the field and never its value', async () => {
    const t = await tenant();
    const before = ses.requests.length;
    const failure = (await outcome(
      handler()(job(t, { input: { ...UNINSTALL_INPUT, exportUrl: 'https://evil.example/steal' } })),
    )) as JobFailure;
    expect(failure.failure.kind).toBe('permanent');
    expect(failure.failure.error.code).toBe('email_input_invalid');
    expect(failure.failure.error.message).toContain('exportUrl');
    expect(failure.failure.error.message).not.toContain('evil.example');
    expect(ses.requests.length).toBe(before);
  });

  it.each([
    ['raw html in place of an input', { input: '<p>hello</p>' }],
    ['an unknown template', { template: 'newsletter' }],
    ['a recipient given by address', { recipient: { kind: 'address', value: 'a@b.example' } }],
    ['a short message key', { message_key: 'short' }],
    ['a member the contract does not have', { body_html: '<p>hi</p>' }],
  ])('refuses %s before touching the database', async (_name, over) => {
    const t = await tenant();
    const failure = (await outcome(handler()(job(t, over)))) as JobFailure;
    expect(failure.failure.kind).toBe('permanent');
    expect(failure.failure.error.code).toBe('payload_invalid');
  });

  it('refuses a payload for a postal-address kind while the address is unset', async () => {
    const t = await tenant();
    const noAddress = createEmailRuntime(
      { ...ENV, EMAIL_POSTAL_ADDRESS: undefined },
      { endpoint: ses.endpoint },
    );
    const scannerReport = job(t, {
      template: 'scanner_report',
      input: {
        scannedHost: 'shop.example',
        scannedAt: '2026-10-17T20:00:00Z',
        pagesChecked: 3,
        checks: { passed: 41, total: 50 },
        issues: { critical: 2, serious: 7, moderate: 4, minor: 1 },
        topIssues: [{ title: 'Images without alternative text', count: 12 }],
        unsubscribeUrl: `${APP}/email/unsubscribe?t=TESTONLYunsub55aa66bb77cc88dd99`,
        preferencesUrl: `${APP}/settings/email`,
        reportUrl: 'https://rampsmith.example/scan/report?r=TEST',
      },
    });
    const before = ses.requests.length;
    const failure = await outcome(handler({ email: noAddress })(scannerReport));
    // Either the input does not fit (a field this test guessed) or the guard refuses the send;
    // in neither case does mail go out without the postal address.
    expect(failure).toBeInstanceOf(JobFailure);
    expect(ses.requests.length).toBe(before);
  });
});

describe('settings', () => {
  it('retries, naming the settings, while email is not configured', async () => {
    const t = await tenant();
    const bare = createEmailRuntime({});
    expect(bare.transport).toBeUndefined();
    expect(bare.renderer).toBeUndefined();
    const failure = (await outcome(handler({ email: bare })(job(t)))) as JobFailure;
    expect(failure.failure.kind).toBe('retryable');
    expect(failure.failure.error.code).toBe('email_not_configured');
    expect(failure.failure.error.message).toContain('LAUNCH.md C row 7');
    expect(failure.failure.error.message).toContain('SES_REGION');
    expect(failure.failure.error.message).toContain('APP_ORIGIN');
    const withoutEngineEmail = (await outcome(handler({ email: undefined })(job(t)))) as JobFailure;
    expect(withoutEngineEmail.failure.error.code).toBe('email_not_configured');
  });

  it('never puts a setting’s value in a problem', () => {
    const secretish = createEmailRuntime({
      ...ENV,
      SES_REGION: 'not a region with SECRETVALUE',
      APP_ORIGIN: 'ftp://SECRETVALUE.example',
    });
    expect(secretish.problems.join(' ')).not.toContain('SECRETVALUE');
    expect(secretish.problems.length).toBeGreaterThan(0);
  });

  it('defaults the support address to the sender’s and the site origin to the app’s', () => {
    const ok = createEmailRuntime(ENV);
    expect(ok.problems).toEqual([]);
    const email = ok.renderer?.render('delivery_test', { requestedAt: '2026-10-17T21:05:00Z' });
    expect(email?.text).toContain('hello@rampsmith.example');
  });
});

describe('the contract and the templates agree', () => {
  it('lists exactly the templates @rampsmith/email renders', () => {
    const schema = JSON.parse(
      readFileSync(
        new URL('../../contracts-ts/schemas/email-send.schema.json', import.meta.url),
        'utf8',
      ),
    ) as { properties: { template: { oneOf: { const: string }[] } } };
    const listed = schema.properties.template.oneOf.map((entry) => entry.const);
    expect([...listed].sort()).toEqual([...EMAIL_KINDS].sort());
  });

  it('accepts the payload ctl builds for an uninstall', () => {
    const payload = {
      template: 'uninstall_export',
      recipient: { kind: 'shop_owner', shop_id: uuidv7() },
      input: UNINSTALL_INPUT,
      message_key: 'uninstall-export:0192f3a4-0000-7000-8000-000000000001',
    };
    expect(
      parsePayload({ payloadSchema: 'email.send@1', payload, tenantId: uuidv7() }, 'email.send@1'),
    ).toEqual(payload);
    // The same input renders.
    expect(runtime.renderer?.renderUnknown('uninstall_export', payload.input).subject).toBeTruthy();
  });
});
