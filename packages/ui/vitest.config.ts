import process from 'node:process';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { playwright } from '@vitest/browser-playwright';
import type { BrowserCommand } from 'vitest/node';
import { defineConfig } from 'vitest/config';

// Every primitive is tested in a real Chromium: axe needs layout and colour, and keyboard
// tests need real key events (PLAN §16).
const executablePath = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'];

/** Emulates `prefers-reduced-motion` for the page that hosts the tests. */
const reducedMotion: BrowserCommand<[reduce: boolean]> = async (ctx, reduce) => {
  await ctx.page.emulateMedia({ reducedMotion: reduce ? 'reduce' : 'no-preference' });
};

export default defineConfig({
  plugins: [
    svelte({
      configFile: false,
      // Runes mode for this package only; dependencies keep their own mode.
      dynamicCompileOptions: ({ filename }) =>
        filename.includes('/node_modules/') ? undefined : { runes: true },
    }),
  ],
  // Pre-bundled up front, so Vite never reloads a running test to optimise them.
  optimizeDeps: { include: ['axe-core', 'vitest-browser-svelte'] },
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(
        executablePath === undefined ? {} : { launchOptions: { executablePath } },
      ),
      instances: [{ browser: 'chromium' }],
      commands: { reducedMotion },
    },
  },
});
