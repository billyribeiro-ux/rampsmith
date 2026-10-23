/**
 * A free scan end to end (ADR-265): the real `free_scan.run` handler loads a local site in
 * Chromium through the real egress proxy, reads its robots.txt through the same proxy, and
 * writes the summary to a `free_scans` row. LAUNCH.md section E keeps the live version, against
 * a real public site, until it passes.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import process from 'node:process';
import { enqueue, runWorker, uuidv7 } from '@rampsmith/queue';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser } from '../src/browser.ts';
import { engineHandlers } from '../src/queues.ts';
import { freshDatabase, type TestDatabase } from './db.ts';
import { EGRESS_SECRET, startEgress, type Egress } from './egress.ts';

const UA = 'RampsmithBot/test (accessibility scanner)';

const LAYOUT = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>
<body><main><h1>${title}</h1>${body}</main></body></html>`;

const PAGES: Record<string, string> = {
  '/': LAYOUT(
    'Home',
    `<a href="/collections/all">All products</a> <a href="/pages/about">About</a>
     <a href="/cart">Cart</a> <a href="/account/login">Sign in</a>
     <img src="/pixel.png"><p style="color:#bbb;background:#fff">Low contrast</p>`,
  ),
  '/collections/all': LAYOUT('Collection', '<img src="/pixel.png"><img src="/pixel.png">'),
  '/pages/about': LAYOUT('About', '<p>Nothing wrong here.</p>'),
};

let browser: Browser;
let db: TestDatabase;
let egress: Egress;
let server: Server;
let origin = '';
let robots = 'User-agent: *\nDisallow: /cart\n';
const visited: string[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://local').pathname;
    visited.push(path);
    if (path === '/robots.txt') {
      response.writeHead(200, { 'content-type': 'text/plain' }).end(robots);
      return;
    }
    if (path === '/pixel.png') {
      response.writeHead(200, { 'content-type': 'image/png' }).end();
      return;
    }
    const html = PAGES[path];
    if (html === undefined) {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  origin = `https://127.0.0.1:${port.toString()}/`;
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

async function runScan(): Promise<string> {
  const sql = db.as('rampsmith_worker');
  const id = uuidv7();
  await db.owner`
    insert into free_scans (id, domain, origin, ip_hash, status)
    values (${id}, '127.0.0.1', ${origin}, ${Buffer.alloc(32, 3)}, 'queued')`;
  const handlers = engineHandlers({
    sql,
    browser,
    egress: { proxyUrl: egress.url, tokenSecret: EGRESS_SECRET },
    userAgent: UA,
    rewriteUrl: (url) => new URL(url.href.replace('https:', 'http:')),
  });
  const stop = new AbortController();
  const worker = runWorker({
    sql,
    queue: 'free_scan.run',
    workerId: 'e2e-free-scan',
    pollMs: 100,
    signal: stop.signal,
    handler: handlers['free_scan.run'],
  });
  await enqueue(sql, {
    queue: 'free_scan.run',
    payloadSchema: 'free_scan.run@1',
    payload: { free_scan_id: id },
    maxAttempts: 1,
  });
  for (let i = 0; i < 400; i += 1) {
    const [row] = await db.owner<{ status: string }[]>`
      select status from free_scans where id = ${id}`;
    if (row !== undefined && !['queued', 'running'].includes(row.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  stop.abort();
  await worker;
  return id;
}

describe('the free scanner over a local site', () => {
  it('scans the home page and two linked pages through egress and stores a summary', async () => {
    visited.length = 0;
    const id = await runScan();
    const [row] = await db.owner<
      { status: string; result: Record<string, unknown> | null }[]
    >`select status, result from free_scans where id = ${id}`;
    expect(row?.status).toBe('complete');
    const result = row?.result as {
      pages: string[];
      checks_run: number;
      checks_passed: number;
      failures: { rule_id: string; count: number; examples: unknown[] }[];
    };
    expect(result.pages).toHaveLength(3);
    expect(result.pages[0]).toBe(origin);
    expect(result.pages.some((p) => p.endsWith('/collections/all'))).toBe(true);
    expect(result.pages.some((p) => p.endsWith('/pages/about'))).toBe(true);
    const rules = result.failures.map((f) => f.rule_id);
    expect(rules).toContain('image-alt');
    expect(rules).toContain('color-contrast');
    const alt = result.failures.find((f) => f.rule_id === 'image-alt');
    expect(alt?.count).toBe(3);
    expect(alt?.examples).toHaveLength(3);
    expect(result.checks_passed).toBeGreaterThan(0);
    expect(result.checks_passed).toBeLessThan(result.checks_run);
    // robots.txt was read, and the disallowed cart and the sign-in page were never visited.
    expect(visited).toContain('/robots.txt');
    expect(visited).not.toContain('/cart');
    expect(visited).not.toContain('/account/login');
  });

  it('refuses a site whose robots.txt disallows the agent, without loading a page', async () => {
    robots = 'User-agent: RampsmithBot\nDisallow: /\n';
    visited.length = 0;
    const id = await runScan();
    robots = 'User-agent: *\nDisallow: /cart\n';
    const [row] = await db.owner<{ status: string; refusal: string | null }[]>`
      select status, refusal from free_scans where id = ${id}`;
    expect(row).toMatchObject({ status: 'refused', refusal: 'robots' });
    expect(visited).toEqual(['/robots.txt']);
  });
});
