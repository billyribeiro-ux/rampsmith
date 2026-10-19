import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // The machine is shared by several builders; one worker keeps property tests predictable.
    maxWorkers: 1,
    testTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text-summary'],
      // PLAN §23: at least 95% line coverage on liquid-patch; `pnpm test` fails below it.
      thresholds: { lines: 95 },
    },
  },
});
