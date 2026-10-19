// Makes sure the browser check has a Chromium before `vitest run` (ADR-204).
// - CHROMIUM_EXECUTABLE_PATH set (environments where Playwright's download is blocked,
//   docs/ENVIRONMENT.md): the file must exist.
// - In CI (GitHub Actions sets CI=true): installs the Chromium headless shell that the locked
//   playwright-core 1.64.1 bundles, with playwright-core's own installer. ci.yml's node job runs
//   `pnpm -r test`, so this is how the browser check gets the pinned Chromium there.
// - Elsewhere: the bundled Chromium must already launch; otherwise this fails with the fix.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

function fail(message: string): never {
  process.stderr.write(`ensure-chromium: ${message}\n`);
  process.exit(1);
}

const override = process.env['CHROMIUM_EXECUTABLE_PATH'];
if (override !== undefined && override !== '') {
  if (!existsSync(override)) fail(`CHROMIUM_EXECUTABLE_PATH=${override} does not exist`);
  process.stdout.write(`ensure-chromium: using ${override}\n`);
} else if (process.env['CI'] === 'true') {
  const pkg = fileURLToPath(import.meta.resolve('playwright-core/package.json'));
  const cli = join(dirname(pkg), 'cli.js');
  const result = spawnSync(process.execPath, [cli, 'install', '--only-shell', 'chromium'], {
    stdio: 'inherit',
  });
  if (result.status !== 0) fail('playwright-core could not install its Chromium headless shell');
} else {
  try {
    const browser = await chromium.launch({ headless: true });
    await browser.close();
  } catch (error: unknown) {
    const reason = error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error);
    fail(
      `no Chromium for playwright-core (${reason}). Run \`pnpm --filter @rampsmith/corpus-tools exec playwright-core install --only-shell chromium\`, or set CHROMIUM_EXECUTABLE_PATH and CHROMIUM_ARGS as docs/ENVIRONMENT.md describes.`,
    );
  }
}
