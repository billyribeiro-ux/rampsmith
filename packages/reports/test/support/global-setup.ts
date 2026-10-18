// Unpacks the test Chromium once, before any test file starts, and hands its path to the
// browser suites. CHROMIUM_EXECUTABLE_PATH overrides it, for a machine with its own build.
import chromium from '@sparticuz/chromium';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    chromiumPath: string;
  }
}

export default async function setup(project: TestProject): Promise<void> {
  const fromEnv = process.env['CHROMIUM_EXECUTABLE_PATH'];
  project.provide(
    'chromiumPath',
    fromEnv !== undefined && fromEnv !== '' ? fromEnv : await chromium.executablePath(),
  );
}
