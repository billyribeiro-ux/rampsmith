import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { paraglideVitePlugin } from '@inlang/paraglide-js';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    paraglideVitePlugin({
      project: './project.inlang',
      outdir: './src/lib/paraglide',
      strategy: ['baseLocale'],
    }),
    sveltekit({
      adapter: adapter(),
      // SvelteKit's own spans (handle, load, endpoints), exported by instrumentation.server.ts
      // (PLAN §21, ADR-019).
      tracing: { server: true },
      // Nonces for SvelteKit's inline scripts; App Bridge and Polaris load from Shopify's CDN.
      // `frame-ancestors` is added per request in hooks.server.ts (ADR-023).
      csp: {
        mode: 'auto',
        directives: {
          'script-src': ['self', 'https://cdn.shopify.com'],
          'object-src': ['none'],
          'base-uri': ['self'],
          'form-action': ['self'],
        },
      },
      compilerOptions: { runes: true },
    }),
  ],
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
