import { defineConfig } from 'vitest/config';

// The pure checks: no browser, no network. Runs in ci.yml's node job (`pnpm run test`).
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
  },
});
