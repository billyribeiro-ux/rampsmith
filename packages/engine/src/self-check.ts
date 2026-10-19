#!/usr/bin/env node
/**
 * Image self-check (PLAN §22): launches the bundled Chromium with its sandbox on, scans a page
 * with one known failure through the real `scanPage`, and exits non-zero unless axe reports
 * it. CI runs it inside the engine image; it opens no network connection.
 */
import process from 'node:process';
import { launchBrowser } from './browser.ts';
import { scanPage } from './scan-page.ts';
import { userAgent } from './user-agent.ts';

const PAGE = [
  '<!doctype html><html lang="en"><head><title>Self-check</title></head>',
  '<body><main><h1>Self-check</h1>',
  '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">',
  '</main></body></html>',
].join('');

const executablePath = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'];
const browser = await launchBrowser(executablePath === undefined ? {} : { executablePath });
try {
  const scan = await scanPage(browser, {
    url: `data:text/html,${encodeURIComponent(PAGE)}`,
    userAgent: userAgent('self-check'),
  });
  const rules = [...new Set(scan.violations.map((v) => v.ruleId))];
  process.stdout.write(
    `${JSON.stringify({ node: process.version, chromium: browser.version(), rules })}\n`,
  );
  if (!rules.includes('image-alt')) process.exitCode = 1;
} finally {
  await browser.close();
}
