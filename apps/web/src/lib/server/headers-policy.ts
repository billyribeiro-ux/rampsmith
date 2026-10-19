/**
 * The Content-Security-Policy for every page the web server renders (audit M3, ADR-054),
 * handed to SvelteKit's `csp` option in vite.config.ts. SvelteKit adds a nonce to its own
 * inline scripts (`mode: 'auto'`) and `hooks.server.ts` appends `frame-ancestors` per request
 * (ADR-023, `headers.ts`).
 *
 * Shopify serves the two scripts the embedded app loads, App Bridge and Polaris, from
 * `https://cdn.shopify.com/shopifycloud/`. The rest of that host serves files merchants upload
 * (`/s/files/...`), so allowing the host would let any script a merchant, or anyone with an
 * injection point, can host there run in this origin. Only that directory is allowed, and only
 * for what Shopify's own scripts need.
 */
import type { Config } from '@sveltejs/kit/vite';

/** Where Shopify publishes App Bridge and Polaris, and whatever those scripts load next. */
export const SHOPIFY_SCRIPTS = 'https://cdn.shopify.com/shopifycloud/';

/** Where Shopify publishes the admin's fonts, which Polaris uses. */
export const SHOPIFY_FONTS = 'https://cdn.shopify.com/static/fonts/';

export const contentSecurityPolicy = {
  mode: 'auto',
  directives: {
    // Anything not listed below can only come from this origin.
    'default-src': ['self'],
    // No `unsafe-inline` and no `unsafe-eval`: SvelteKit's nonce is the only way to run inline.
    'script-src': ['self', SHOPIFY_SCRIPTS],
    // Polaris' web components put their styles in shadow roots at run time, and Shopify
    // documents no nonce or hash for them (see ADR-054), so inline styles are allowed. They
    // cannot run script; scripts stay locked above.
    'style-src': ['self', 'unsafe-inline', SHOPIFY_SCRIPTS, SHOPIFY_FONTS],
    'img-src': ['self', 'data:', SHOPIFY_SCRIPTS],
    'font-src': ['self', SHOPIFY_SCRIPTS, SHOPIFY_FONTS],
    // The browser only talks to this origin: it never calls the api, `web` does (PLAN §16).
    'connect-src': ['self'],
    'object-src': ['none'],
    'base-uri': ['self'],
    'form-action': ['self'],
  },
} satisfies NonNullable<Config['csp']>;
