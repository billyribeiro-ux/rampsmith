/**
 * Audit M2: one page scan has an overall deadline that the page cannot defeat. Two hostile
 * pages: one replaces the timer functions the page-side `settle` relies on, one busy-loops its
 * main thread after it has loaded. Neither can be stopped from inside the page; the scan
 * must end in this process, close its context and leave the shared browser usable.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import process from 'node:process';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser } from '../src/browser.ts';
import { ScanDeadlineError, scanPage } from '../src/scan-page.ts';

const UA = 'RampsmithBot/test (accessibility scanner)';

const PAGES: Record<string, string> = {
  '/clean':
    '<!doctype html><html lang="en"><head><title>Clean</title></head><body><main><h1>Clean</h1></main></body></html>',
  // The page replaces its timers before anything runs: `settle`'s page-side timeouts never fire.
  '/timers': `<!doctype html><html lang="en"><head><title>Timers</title>
<script>
  window.setTimeout = () => 0; window.setInterval = () => 0;
  window.clearTimeout = () => undefined; window.clearInterval = () => undefined;
</script></head><body><main><h1>Timers</h1></main></body></html>`,
  // After it has loaded, the page never returns control to the browser's event loop.
  '/busy': `<!doctype html><html lang="en"><head><title>Busy</title></head><body><main><h1>Busy</h1></main>
<script>
  window.addEventListener('load', () => { setTimeout(() => { for (;;) { /* hostile */ } }, 50); });
</script></body></html>`,
};

let browser: Browser;
let server: Server;
let origin: string;

beforeAll(async () => {
  const executablePath = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'];
  browser = await launchBrowser({
    chromiumSandbox: false,
    ...(executablePath === undefined ? {} : { executablePath }),
  });
  server = createServer((req, res) => {
    const html = PAGES[req.url ?? ''];
    if (html === undefined) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' }).end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port.toString()}`;
});
afterAll(async () => {
  await browser.close();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
    server.closeAllConnections();
  });
});

describe('the page scan deadline (audit M2)', () => {
  for (const path of ['/timers', '/busy']) {
    it(`ends a hostile page (${path}) at the deadline, closes its context and keeps the browser`, async () => {
      const started = Date.now();
      await expect(
        scanPage(browser, {
          url: `${origin}${path}`,
          userAgent: UA,
          // The navigation budget is far longer than the deadline: only the deadline can end it.
          timeoutMs: 60_000,
          deadlineMs: 4_000,
        }),
      ).rejects.toBeInstanceOf(ScanDeadlineError);
      const took = Date.now() - started;
      expect(took).toBeGreaterThanOrEqual(3_900);
      expect(took).toBeLessThan(15_000);
      expect(browser.contexts().length, 'a context was left open').toBe(0);

      // The shared browser still works for the next job.
      const next = await scanPage(browser, { url: `${origin}/clean`, userAgent: UA });
      expect(next.states[0]?.result).toBe('opened');
    });
  }

  it('does not fire for a scan that finishes in time, and leaves no timer behind', async () => {
    const scan = await scanPage(browser, {
      url: `${origin}/clean`,
      userAgent: UA,
      deadlineMs: 60_000,
    });
    expect(scan.states[0]?.result).toBe('opened');
    expect(browser.contexts().length).toBe(0);
  });
});
