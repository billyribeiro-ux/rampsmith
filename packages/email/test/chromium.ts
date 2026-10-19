/**
 * Launches Chromium for the browser tests (ADR-194). In order: the binary named by
 * `RAMPSMITH_CHROMIUM_PATH`; the Chromium that the locked playwright-core installs with
 * `playwright-core install chromium`, when present; otherwise the Chromium build that
 * `@sparticuz/chromium` ships inside its npm package, which needs no download and runs in CI's
 * `node` job and in the sandbox where Playwright's browser CDN is blocked (ENVIRONMENT.md).
 */
import { existsSync } from 'node:fs';
import sparticuz from '@sparticuz/chromium';
import { chromium, type Browser } from 'playwright-core';

export interface LaunchedBrowser {
  readonly browser: Browser;
  /** Which binary ran, for the test log and the evidence file. */
  readonly source: string;
}

export async function launchChromium(): Promise<LaunchedBrowser> {
  const explicit = process.env['RAMPSMITH_CHROMIUM_PATH'];
  if (explicit !== undefined && explicit !== '') {
    return { browser: await chromium.launch({ executablePath: explicit }), source: explicit };
  }
  const bundled = chromium.executablePath();
  if (existsSync(bundled)) {
    return { browser: await chromium.launch(), source: `playwright-core (${bundled})` };
  }
  sparticuz.setGraphicsMode = false;
  const executablePath = await sparticuz.executablePath();
  return {
    browser: await chromium.launch({ executablePath, args: sparticuz.args }),
    source: `@sparticuz/chromium (${executablePath})`,
  };
}
