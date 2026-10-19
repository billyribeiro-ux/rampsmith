import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['test/support/global-setup.ts'],
    // The browser suites launch Chromium once per file; two vCPUs run two files at a time.
    maxWorkers: 2,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
