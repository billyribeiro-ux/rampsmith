// Launches the test Chromium. The browser tests run in ci.yml's node job, which installs no
// Playwright browser, so the Chromium comes from @sparticuz/chromium on npm (ADR-223).
// Only `--no-sandbox` is passed: containers and CI runners cannot start Chromium's sandbox.
// @sparticuz/chromium's own argument list is deliberately not used, because it includes
// --disable-web-security, under which a page can read local files (docs/evidence/ws-13-reports.md).
import { chromium, type Browser } from 'playwright-core';
import { inject } from 'vitest';

export async function launch(): Promise<Browser> {
  return chromium.launch({
    executablePath: inject('chromiumPath'),
    headless: true,
    args: ['--no-sandbox'],
  });
}
