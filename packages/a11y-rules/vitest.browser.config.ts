import { defineConfig } from 'vitest/config';

// Browser checks and interactive-state scripts against local fixtures. One Chromium at a time:
// files run one after another in a single worker.
export default defineConfig({
  test: {
    include: ['test-browser/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
