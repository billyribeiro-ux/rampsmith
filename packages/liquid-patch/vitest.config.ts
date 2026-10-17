import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // The machine is shared by several builders; one worker keeps property tests predictable.
    maxWorkers: 1,
    testTimeout: 60_000,
  },
});
