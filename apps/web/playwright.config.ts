import process from 'node:process';
import { defineConfig, devices } from '@playwright/test';

// Sandboxes without Playwright's own browser download point this at a local Chromium
// (ADR-014); CI installs the pinned browser with `playwright install`.
const executablePath = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'];
const pgHost = process.env['PGHOST'] ?? '127.0.0.1';
const pgPort = process.env['PGPORT'] ?? '5432';

const browser = {
  ...devices['Desktop Chrome'],
  ...(executablePath === undefined ? {} : { launchOptions: { executablePath } }),
};

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  forbidOnly: process.env['CI'] !== undefined,
  retries: 0,
  workers: 1,
  reporter: process.env['CI'] === undefined ? 'list' : [['list'], ['github']],
  projects: [
    {
      // The embedded app against a stub api: Shopify cannot be reached from tests.
      name: 'embedded',
      testMatch: 'app.spec.ts',
      use: { ...browser, baseURL: 'http://127.0.0.1:3999' },
    },
    {
      // The App Home against the typed fake api, with the Polaris test shim (ADR-094).
      name: 'app-home',
      testMatch: 'app-*.spec.ts',
      use: { ...browser, baseURL: 'http://127.0.0.1:3995' },
    },
    {
      // The dashboard against the real api and database, with Chromium's virtual
      // authenticator. WebAuthn needs a secure context, which localhost is.
      name: 'dashboard',
      testMatch: 'dashboard.spec.ts',
      use: {
        ...browser,
        baseURL: 'http://localhost:3996',
        // What the production proxy sends, so SvelteKit sees the request's real scheme.
        extraHTTPHeaders: { 'x-forwarded-proto': 'http' },
      },
    },
  ],
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
        SHOPIFY_API_KEY: 'e2e-client-id',
      },
    },
    {
      command: 'node tests/app-fake-api.ts',
      url: 'http://127.0.0.1:3994/healthz',
      reuseExistingServer: false,
    },
    {
      command: 'node build',
      url: 'http://127.0.0.1:3995/',
      reuseExistingServer: false,
      env: {
        HOST: '127.0.0.1',
        PORT: '3995',
        API_URL: 'http://127.0.0.1:3994',
        SHOPIFY_API_KEY: 'e2e-client-id',
      },
    },
    {
      command: process.env['RAMPSMITH_API_BIN'] ?? '../../target/debug/api',
      url: 'http://127.0.0.1:3997/healthz',
      reuseExistingServer: false,
      env: {
        DATABASE_URL: `postgres://rampsmith_e2e_login:e2e@${pgHost}:${pgPort}/rampsmith_e2e`,
        BIND_ADDR: '127.0.0.1:3997',
        SHOPIFY_API_KEY: 'e2e-client-id',
        SHOPIFY_API_SECRET: 'e2e-client-secret',
        RAMPSMITH_MASTER_KEYS: 'e2e:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
        WEBAUTHN_RP_ID: 'localhost',
        WEBAUTHN_RP_ORIGIN: 'http://localhost:3996',
        RUST_LOG: 'warn',
      },
    },
    {
      command: 'node build',
      url: 'http://127.0.0.1:3996/',
      reuseExistingServer: false,
      env: {
        HOST: '127.0.0.1',
        PORT: '3996',
        API_URL: 'http://127.0.0.1:3997',
        SHOPIFY_API_KEY: 'e2e-client-id',
        PROTOCOL_HEADER: 'x-forwarded-proto',
      },
    },
  ],
});
