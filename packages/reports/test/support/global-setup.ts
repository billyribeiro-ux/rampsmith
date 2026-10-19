// Unpacks the test Chromium once, before any test file starts, and hands its path to the
// browser suites. CHROMIUM_EXECUTABLE_PATH overrides it, for a machine with its own build.
//
// @sparticuz/chromium reuses any `chromium` it finds in the temporary directory without
// checking it, so a binary planted in a shared /tmp would run. It therefore unpacks into a
// fresh private directory (mode 0700) for each run, which the teardown removes.
//
// Text in a PDF depends on the fonts the machine has: on the GitHub runner, outline titles
// lost their spaces with the system fonts. The browser suites therefore use only the Open Sans
// files @sparticuz/chromium ships, through a fontconfig file of their own, on every machine.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import chromium from '@sparticuz/chromium';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    chromiumPath: string;
  }
}

export default async function setup(project: TestProject): Promise<() => void> {
  const fromEnv = process.env['CHROMIUM_EXECUTABLE_PATH'];
  if (fromEnv !== undefined && fromEnv !== '') {
    project.provide('chromiumPath', fromEnv);
    return () => undefined;
  }
  const own = mkdtempSync(join(tmpdir(), 'reports-chromium-'));
  const previous = process.env['TMPDIR'];
  process.env['TMPDIR'] = own;
  try {
    const path = await chromium.executablePath();
    if (!path.startsWith(own)) {
      throw new Error('the test Chromium was not unpacked into its private directory');
    }
    project.provide('chromiumPath', path);
    const fonts = join(own, 'fonts.conf');
    writeFileSync(
      fonts,
      `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig>\n  <dir>${join(own, 'fonts', 'fonts')}</dir>\n  <cachedir>${join(own, 'fonts-cache')}</cachedir>\n</fontconfig>\n`,
    );
    // Test workers start after this setup and pass their environment to Chromium.
    process.env['FONTCONFIG_FILE'] = fonts;
  } finally {
    if (previous === undefined) delete process.env['TMPDIR'];
    else process.env['TMPDIR'] = previous;
  }
  return () => {
    rmSync(own, { recursive: true, force: true });
  };
}
