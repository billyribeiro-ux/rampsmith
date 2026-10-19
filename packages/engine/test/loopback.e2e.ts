/**
 * Audit L2: loopback reached egress only because Playwright adds `<-loopback>` to the bypass
 * list by default. The engine now names the entry itself, so the setting that Playwright's
 * `PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK` switch turns off cannot expose loopback.
 */
import process from 'node:process';
import { chromium, type Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PROXIED_LOOPBACK_OVERRIDE, contextProxy } from '../src/browser.ts';
import { signScanToken } from '../src/egress-token.ts';
import { EGRESS_SECRET, startEgress, type Egress } from './egress.ts';
import { startSite, type Site } from './site.ts';

const executablePath = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'];
let site: Site;
let egress: Egress;

beforeAll(async () => {
  site = await startSite();
  egress = await startEgress(site.port);
});
afterAll(async () => {
  await egress.stop();
  await site.close();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

/** A token that does not name the site's host, so egress itself answers 403 for it. */
function foreignToken(): string {
  return signScanToken(EGRESS_SECRET, {
    v: 1,
    scan: 'loopback-e2e',
    hosts: ['shop.example'],
    budget: 5,
    exp: Math.floor(Date.now() / 1000) + 60,
  });
}

/**
 * Loads the local site with the override switch on. Returns the status the page answered with
 * and how many requests the site itself served: 403 and none means the request stopped at egress.
 */
async function load(
  launch: (browser: Browser) => Promise<{ status: number | undefined }>,
  browserBypass: string | undefined,
): Promise<{ status: number | undefined; served: number }> {
  vi.stubEnv(PROXIED_LOOPBACK_OVERRIDE, '1');
  const browser = await chromium.launch({
    proxy: {
      server: 'per-context',
      ...(browserBypass === undefined ? {} : { bypass: browserBypass }),
    },
    ...(executablePath === undefined ? {} : { executablePath }),
  });
  try {
    const before = site.requests.length;
    const { status } = await launch(browser);
    return { status, served: site.requests.length - before };
  } finally {
    await browser.close();
  }
}

describe('loopback goes through egress whatever Playwright defaults to (L2)', () => {
  it('stops at egress with the engine proxy settings, even with the override switch set', async () => {
    const result = await load(async (browser) => {
      const context = await browser.newContext({
        proxy: contextProxy(egress.url, foreignToken()),
        serviceWorkers: 'block',
      });
      const response = await (await context.newPage()).goto(`${site.origin}/clean`);
      await context.close();
      return { status: response?.status() };
    }, '<-loopback>');
    expect(result).toEqual({ status: 403, served: 0 });
  });

  it('would reach the site directly if the entry were left to the default (the finding)', async () => {
    const result = await load(async (browser) => {
      const context = await browser.newContext({
        proxy: {
          server: egress.url,
          username: 'rampsmith',
          password: foreignToken(),
        },
        serviceWorkers: 'block',
      });
      const response = await (await context.newPage()).goto(`${site.origin}/clean`);
      await context.close();
      return { status: response?.status() };
    }, undefined);
    expect(result).toEqual({ status: 200, served: 1 });
  });
});
