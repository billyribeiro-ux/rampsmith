import { defineConfig } from 'vitest/config';

// Browser tests: Chromium, the real egress binary, and PostgreSQL (mise run test:e2e).
export default defineConfig({
  test: {
    include: ['test/**/*.e2e.ts'],
    environment: 'node',
    testTimeout: 90_000,
    hookTimeout: 90_000,
    fileParallelism: false,
  },
});
