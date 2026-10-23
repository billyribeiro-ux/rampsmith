/**
 * Audit M3 (ADR-283): a scan that cannot finish ends, and its sealed storefront-password copy is
 * cleared, on the engine's terminal paths: a permanent failure of scan.plan, scan.finalize,
 * verify.scan, audit.data or scan.page, and the last attempt of the other four. A scan.page that
 * fails on its last attempt does not end the scan (it records the page as failed).
 */
import { JobFailure, uuidv7, type ClaimedJob } from '@rampsmith/queue';
import type postgres from 'postgres';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { endingScanOnFailure } from '../src/jobs/scan-cleanup.ts';
import { engineHandlers, type EngineQueue } from '../src/queues.ts';
import { freshDatabase, seed, type Fixture, type TestDatabase } from './db.ts';

let db: TestDatabase;
let sql: postgres.Sql;

beforeAll(async () => {
  db = await freshDatabase();
  sql = db.as('rampsmith_worker');
});
afterAll(async () => {
  await db.drop();
});

/** A queued scan of an unverified site, holding a sealed password copy. */
async function scanWithCopy(verified = false): Promise<Fixture> {
  const fixture = await seed(db.owner, 'https://shop.example/', { verified });
  await db.owner`
    update scans set storefront_password_ct = ${Buffer.from([1, 2, 3])},
                     storefront_password_key_id = 'scan-1'
     where id = ${fixture.scanId}`;
  return fixture;
}

async function state(scanId: string) {
  const [row] = await db.owner<{ status: string; code: string | null; copy: boolean }[]>`
    select status, error_code as code, storefront_password_ct is not null as copy
      from scans where id = ${scanId}`;
  return row;
}

function job(
  schema: string,
  payload: Record<string, unknown>,
  tenantId: string,
  attempt = 1,
  maxAttempts = 3,
): ClaimedJob {
  return {
    payloadSchema: schema,
    payload,
    tenantId,
    lease: { attempt },
    maxAttempts,
  } as unknown as ClaimedJob;
}

const egress = { proxyUrl: 'http://127.0.0.1:1', tokenSecret: 'x'.repeat(40) };

function handlers(scan?: () => Promise<never>) {
  return engineHandlers({
    sql,
    browser: {} as Browser,
    egress,
    userAgent: 'x',
    ...(scan === undefined ? {} : { scan }),
  });
}

describe('terminal paths end the scan and clear its copy', () => {
  it('scan.plan: a permanent failure', async () => {
    const f = await scanWithCopy(false); // an unverified site is a permanent refusal
    await expect(
      handlers()['scan.plan'](
        job('scan.plan@1', { scan_id: f.scanId, site_id: f.siteId }, f.tenantId),
      ),
    ).rejects.toMatchObject({ failure: { kind: 'permanent' } });
    expect(await state(f.scanId)).toEqual({
      status: 'failed',
      code: 'site_not_verified',
      copy: false,
    });
  });

  it('verify.scan: a permanent failure', async () => {
    const f = await scanWithCopy(true);
    await expect(
      handlers()['verify.scan'](
        job(
          'verify.scan@1',
          {
            scan_id: f.scanId,
            site_id: f.siteId,
            fix_id: uuidv7(),
            urls: ['https://shop.example/'],
          },
          f.tenantId,
        ),
      ),
    ).rejects.toMatchObject({ failure: { kind: 'permanent' } });
    expect(await state(f.scanId)).toEqual({ status: 'failed', code: 'fix_not_found', copy: false });
  });

  it('scan.finalize and audit.data: a permanent failure', async () => {
    for (const queue of ['scan.finalize', 'audit.data'] as const satisfies EngineQueue[]) {
      const f = await scanWithCopy(true);
      // A payload that names a scan whose rows do not exist for the job: the handler refuses.
      const payload =
        queue === 'scan.finalize'
          ? { scan_id: f.scanId, site_id: uuidv7() }
          : { scan_id: f.scanId, site_id: f.siteId, input_id: uuidv7() };
      const schema = queue === 'scan.finalize' ? 'scan.finalize@1' : 'audit.data@1';
      await expect(handlers()[queue](job(schema, payload, f.tenantId))).rejects.toBeInstanceOf(
        JobFailure,
      );
      const after = await state(f.scanId);
      expect(after, queue).toMatchObject({ status: 'failed', copy: false });
    }
  });

  it('scan.page: a permanent failure ends the scan, a last retryable one does not', async () => {
    const f = await scanWithCopy(true);
    const page = (url: string, attempt: number) =>
      job(
        'scan.page@2',
        {
          scan_id: f.scanId,
          site_id: f.siteId,
          seq: 0,
          page_type: 'home',
          url,
          viewport: 'desktop',
          states: ['default'],
        },
        f.tenantId,
        attempt,
        attempt,
      );
    // A page off the site is permanent.
    await expect(
      handlers()['scan.page'](page('https://elsewhere.example/', 1)),
    ).rejects.toMatchObject({ failure: { kind: 'permanent' } });
    expect(await state(f.scanId)).toMatchObject({ status: 'failed', copy: false });

    // On its last attempt a retryable page failure records the page and keeps the scan going.
    const g = await scanWithCopy(true);
    await db.owner`update scans set status = 'running', pages_planned = 2 where id = ${g.scanId}`;
    const failing = handlers(() => Promise.reject(new Error('net::ERR_CONNECTION_RESET')));
    await expect(
      failing['scan.page'](
        job(
          'scan.page@2',
          {
            scan_id: g.scanId,
            site_id: g.siteId,
            seq: 0,
            page_type: 'home',
            url: 'https://shop.example/',
            viewport: 'desktop',
            states: ['default'],
          },
          g.tenantId,
          3,
          3,
        ),
      ),
    ).rejects.toMatchObject({ failure: { kind: 'retryable' } });
    expect(await state(g.scanId)).toMatchObject({ status: 'running', copy: true });
  });

  it('a retryable failure ends the scan only on the last attempt', async () => {
    const f = await scanWithCopy(true);
    // verify.scan reaches its page scan and fails with a retryable page_load_failed only when
    // the fix exists; here a missing database role would be permanent, so drive the wrapper
    // with a handler that fails retryably.
    const flaky = endingScanOnFailure(
      sql,
      () => Promise.reject(new JobFailure('retryable', { code: 'page_load_failed', message: 'x' })),
      { onLastAttempt: true },
    );
    const payload = { scan_id: f.scanId };
    await expect(flaky(job('verify.scan@1', payload, f.tenantId, 1, 3))).rejects.toBeInstanceOf(
      JobFailure,
    );
    expect(await state(f.scanId)).toMatchObject({ status: 'queued', copy: true });
    await expect(flaky(job('verify.scan@1', payload, f.tenantId, 3, 3))).rejects.toBeInstanceOf(
      JobFailure,
    );
    expect(await state(f.scanId)).toEqual({
      status: 'failed',
      code: 'page_load_failed',
      copy: false,
    });
  });

  it('leaves a finished scan alone and does not hide the original failure', async () => {
    const f = await scanWithCopy(true);
    await db.owner`update scans set status = 'succeeded', finished_at = now() where id = ${f.scanId}`;
    const wrapped = endingScanOnFailure(
      sql,
      () => Promise.reject(new JobFailure('permanent', { code: 'boom', message: 'x' })),
      { onLastAttempt: true },
    );
    await expect(
      wrapped(job('scan.finalize@1', { scan_id: f.scanId }, f.tenantId)),
    ).rejects.toMatchObject({ failure: { error: { code: 'boom' } } });
    expect((await state(f.scanId))?.status).toBe('succeeded');
  });
});
