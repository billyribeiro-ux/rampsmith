/**
 * Audit H1 (ADR-280): free scans run only in a Chromium with its own sandbox. The queue is
 * registered only then, the heartbeat that lets the api accept free scans is written only then,
 * and the heartbeat goes stale or is withdrawn when the engine stops.
 */
import { EventEmitter } from 'node:events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDatabase, type TestDatabase } from './db.ts';
import { startFreeScanBeat } from '../src/free-scan-beat.ts';
import { startHealthServer } from '../src/health.ts';
import { exitWhenBrowserLost } from '../src/lifecycle.ts';
import { FREE_SCAN_BUDGET_MS } from '../src/free-scan.ts';
import { deadlineMs, ENGINE_QUEUES, queuesFor } from '../src/queues.ts';
import { DEFAULT_DEADLINE_MS, type ScanOptions } from '../src/scan-page.ts';
import { PAGE_TOKEN_TTL_SECONDS } from '../src/egress-token.ts';
import { scanThroughEgress } from '../src/worker.ts';

describe('which queues an engine serves', () => {
  it('serves every queue, free scans included, with the sandbox on', () => {
    expect(queuesFor('on')).toEqual(ENGINE_QUEUES);
    expect(queuesFor('on')).toContain('free_scan.run');
  });

  it('never serves free scans without the sandbox, and serves everything else', () => {
    const queues = queuesFor('off');
    expect(queues).not.toContain('free_scan.run');
    expect(queues).toEqual(ENGINE_QUEUES.filter((queue) => queue !== 'free_scan.run'));
    expect(queues.length).toBe(ENGINE_QUEUES.length - 1);
  });
});

describe('the free-scan heartbeat', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await freshDatabase();
  });
  afterAll(async () => {
    await db.drop();
  });

  const available = async (): Promise<boolean> => {
    const app = db.as('rampsmith_app');
    const [row] = await app<{ ok: boolean }[]>`select free_scan_engine_available() as ok`;
    return row?.ok === true;
  };

  it('is written at once, repeated, and withdrawn on a clean stop', async () => {
    expect(await available()).toBe(false);
    const worker = db.as('rampsmith_worker');
    const beat = await startFreeScanBeat(worker, 'engine-a', { intervalMs: 50 });
    expect(await available()).toBe(true);
    const [first] = await db.owner<{ beat_at: Date }[]>`
      select beat_at from free_scan_engines where worker_id = 'engine-a'`;
    await new Promise((resolve) => setTimeout(resolve, 400));
    const [later] = await db.owner<{ beat_at: Date }[]>`
      select beat_at from free_scan_engines where worker_id = 'engine-a'`;
    expect(later?.beat_at.getTime()).toBeGreaterThan(first?.beat_at.getTime() ?? Infinity);
    await beat.stop();
    expect(await available()).toBe(false);
    const rows = await db.owner`select 1 from free_scan_engines`;
    expect(rows.length).toBe(0);
  });

  it('goes stale after 45 seconds without a beat, as when the engine was killed', async () => {
    await db.owner`
      insert into free_scan_engines (worker_id, beat_at)
      values ('engine-killed', now() - interval '46 seconds')`;
    expect(await available()).toBe(false);
    await db.owner`update free_scan_engines set beat_at = now() - interval '44 seconds'`;
    expect(await available()).toBe(true);
    await db.owner`delete from free_scan_engines`;
  });

  it('is not writable by the api, and the sweep forgets engines gone for an hour', async () => {
    const app = db.as('rampsmith_app');
    await expect(
      app`insert into free_scan_engines (worker_id) values ('forged')`,
    ).rejects.toMatchObject({ code: '42501' });
    await db.owner`insert into free_scan_engines (worker_id, beat_at)
                   values ('old', now() - interval '2 hours'), ('new', now())`;
    await db.as('rampsmith_worker')`select free_scans_sweep()`;
    const left = await db.owner<{ worker_id: string }[]>`select worker_id from free_scan_engines`;
    expect(left.map((row) => row.worker_id)).toEqual(['new']);
  });
});

describe('the engine does not outlive its browser (audit L6)', () => {
  it('exits with 1 and turns /healthz to 503 when the browser disconnects', async () => {
    const health = await startHealthServer('0');
    try {
      const browser = new EventEmitter();
      const written: string[] = [];
      const codes: number[] = [];
      exitWhenBrowserLost(
        browser as never,
        health,
        (line) => written.push(line),
        (code) => codes.push(code),
      );
      const url = `http://127.0.0.1:${health.port.toString()}/healthz`;
      expect((await fetch(url)).status).toBe(200);
      browser.emit('disconnected');
      expect(codes).toEqual([1]);
      expect(written.join('')).toMatch(/chromium disconnected/);
      expect((await fetch(url)).status).toBe(503);
    } finally {
      await health.close();
    }
  });

  it('stays quiet when the engine closes the browser itself', async () => {
    const health = await startHealthServer('0');
    try {
      const browser = new EventEmitter();
      const codes: number[] = [];
      const watch = exitWhenBrowserLost(
        browser as never,
        health,
        () => undefined,
        (c) => codes.push(c),
      );
      watch.stopping();
      browser.emit('disconnected');
      expect(codes).toEqual([]);
      expect((await fetch(`http://127.0.0.1:${health.port.toString()}/healthz`)).status).toBe(200);
    } finally {
      await health.close();
    }
  });
});

describe('every queue has a job deadline (audit M2)', () => {
  it('is above what its handler bounds itself to, and finite', () => {
    for (const queue of ENGINE_QUEUES) {
      expect(Number.isFinite(deadlineMs(queue)), queue).toBe(true);
      expect(deadlineMs(queue), queue).toBeGreaterThan(0);
    }
    expect(deadlineMs('scan.page')).toBeGreaterThan(DEFAULT_DEADLINE_MS);
    expect(deadlineMs('verify.scan')).toBeGreaterThan(DEFAULT_DEADLINE_MS);
    expect(deadlineMs('free_scan.run')).toBeGreaterThan(FREE_SCAN_BUDGET_MS);
  });
});

describe('page egress tokens live 120 seconds (audit L8, PLAN §18)', () => {
  it('signs the tenant page scan token for 120 s, longer than the page deadline', async () => {
    expect(PAGE_TOKEN_TTL_SECONDS).toBe(120);
    expect(DEFAULT_DEADLINE_MS / 1000).toBeLessThan(PAGE_TOKEN_TTL_SECONDS);
    let seen: ScanOptions | undefined;
    await scanThroughEgress(
      {
        sql: {} as never,
        browser: {} as never,
        egress: { proxyUrl: 'http://127.0.0.1:1', tokenSecret: 'x'.repeat(40) },
        userAgent: 'x',
        scan: (_browser, options) => {
          seen = options;
          return Promise.reject(new Error('stop here'));
        },
      },
      {
        tenantId: 't',
        siteId: 's',
        scanId: 'c',
        target: new URL('https://shop.com/'),
        viewport: 'desktop',
        states: ['default'],
        deep: false,
      },
    ).catch(() => undefined);
    const claims = JSON.parse(
      Buffer.from((seen?.proxy?.token ?? '').split('.')[0] ?? '', 'base64url').toString('utf8'),
    ) as { exp: number };
    const ttl = claims.exp - Math.floor(Date.now() / 1000);
    expect(ttl).toBeGreaterThan(110);
    expect(ttl).toBeLessThanOrEqual(120);
  });
});
