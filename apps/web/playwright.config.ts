import process from 'node:process';
import { defineConfig, devices } from '@playwright/test';

// Sandboxes without Playwright's own browser download point this at a local Chromium
// (ADR-014); CI installs the pinned browser with `playwright install`.
const executablePath = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'];

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  forbidOnly: process.env['CI'] !== undefined,
  retries: 0,
  reporter: process.env['CI'] === undefined ? 'list' : [['list'], ['github']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:3999',
    ...(executablePath === undefined ? {} : { launchOptions: { executablePath } }),
  },
  webServer: [
    {
      command: 'node tests/mock-api.ts',
      url: 'http://127.0.0.1:3998/healthz',
      reuseExistingServer: false,
    },
    {
      command: 'node build',
      url: 'http://127.0.0.1:3999/',
      reuseExistingServer: false,
      env: {
        HOST: '127.0.0.1',
        PORT: '3999',
        API_URL: 'http://127.0.0.1:3998',
        SHOPIFY_CLIENT_ID: 'e2e-client-id',
      },
    },
  ],
});
