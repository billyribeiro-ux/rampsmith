import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // The browser suite launches Chromium once and runs axe on every email in two schemes.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
