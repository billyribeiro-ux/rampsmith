/**
 * The live check for the storefront password (LAUNCH.md section E, "Storefront password unlock
 * on a real closed store"): a real development store with the password page on is blocked
 * without the password and scanned with it. It runs when `RAMPSMITH_LIVE_STORE` and
 * `RAMPSMITH_LIVE_STORE_PASSWORD` are set (section C, row 3: `SHOPIFY_DEV_STORE_DOMAIN` and
 * `SHOPIFY_DEV_STORE_PASSWORD`) and otherwise skips with a notice naming the row; it never
 * passes silently. The substitute that passes now is the password tests of `scan.e2e.ts`, and
 * the sealed hand-off from ctl to the engine is `scan-secret.test.ts` (ADR-264).
 *
 *   RAMPSMITH_LIVE_STORE=$SHOPIFY_DEV_STORE_DOMAIN RAMPSMITH_LIVE_STORE_PASSWORD=$SHOPIFY_DEV_STORE_PASSWORD \
 *     pnpm --filter @rampsmith/engine exec vitest run test/storefront-password.live.test.ts
 */
import process from 'node:process';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser } from '../src/browser.ts';
import { scanPage } from '../src/scan-page.ts';

const store = process.env['RAMPSMITH_LIVE_STORE']?.trim() ?? '';
const password = process.env['RAMPSMITH_LIVE_STORE_PASSWORD'] ?? '';
const live = store !== '' && password !== '';
const NOTICE =
  'needs RAMPSMITH_LIVE_STORE and RAMPSMITH_LIVE_STORE_PASSWORD (LAUNCH.md section C, row 3; ' +
  'section E, "Storefront password unlock on a real closed store")';

if (!live) {
  const annotation =
    process.env['GITHUB_ACTIONS'] === 'true'
      ? '::notice title=Storefront password live check skipped::'
      : '';
  process.stderr.write(`${annotation}storefront password live check skipped: ${NOTICE}\n`);
}

describe.skipIf(!live)(`live storefront password (${NOTICE})`, () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await launchBrowser();
  });
  afterAll(async () => {
    await browser.close();
  });

  it('is blocked without the password and scanned with it', async () => {
    const url = `https://${store}/`;
    const userAgent = 'RampsmithBot/live (accessibility scanner)';
    const closed = await scanPage(browser, { url, userAgent });
    expect(closed.blocked).toBe('storefront_password');
    const open = await scanPage(browser, { url, userAgent, storefrontPassword: password });
    expect(open.blocked).toBeUndefined();
    expect(open.states.length).toBeGreaterThan(0);
  }, 120_000);
});
