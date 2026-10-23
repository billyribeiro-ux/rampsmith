import process from 'node:process';
import { defineConfig } from '@playwright/test';
import base from './playwright.config.ts';

/**
 * The App Store listing screenshots (LAUNCH.md section B, listing/screenshots/). Not part of
 * the pull-request gate: run `pnpm --filter @rampsmith/web run listing:screenshots` to retake
 * them. It reuses the App Home project's servers (the built app and the typed fake api).
 */
const appHome = base.projects?.find((p) => p.name === 'app-home');
if (appHome === undefined) throw new Error('playwright.config.ts has no app-home project');

export default defineConfig({
  ...base,
  projects: [{ ...appHome, name: 'listing', testMatch: 'listing-*.spec.ts' }],
  webServer: (Array.isArray(base.webServer) ? base.webServer : []).filter((server) =>
    /:398[45]\//u.test(server.url ?? ''),
  ),
  reporter: process.env['CI'] === undefined ? 'list' : 'github',
});
