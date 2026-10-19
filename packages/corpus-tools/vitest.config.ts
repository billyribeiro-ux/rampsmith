import { defineConfig } from 'vitest/config';

// Unit tests, the static corpus checks and the browser check (one Chromium, launched once per
// file). Files run one after another so at most one browser is open (2 vCPUs locally).
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
