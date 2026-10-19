import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 90_000,
    hookTimeout: 90_000,
    // Browser and database tests share one Chromium and one PostgreSQL; run files in turn.
    fileParallelism: false,
  },
});
