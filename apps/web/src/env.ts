// Environment variables for the web app (SvelteKit 3: `$app/env/*`, PLAN §22).
import { building } from '$app/env';
import { defineEnvVars } from '@sveltejs/kit/env';

const required = (name: string) => (value: string | undefined) => {
  if (building) return value ?? '';
  if (value === undefined || value.trim() === '') throw new Error(`${name} must be set`);
  return value.trim();
};

const optional = (value: string | undefined) => value?.trim() ?? '';

const turnstileOrigin = (value: string | undefined) => {
  const text = value?.trim() ?? '';
  if (text === '') return 'https://challenges.cloudflare.com';
  const url = new URL(text);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('TURNSTILE_ORIGIN must be an http(s) origin');
  }
  return url.origin;
};

const scannerBackend = (value: string | undefined): 'not-connected' | 'fixture' => {
  const text = value?.trim() ?? '';
  if (text === '' || text === 'not-connected') return 'not-connected';
  if (text === 'fixture') return 'fixture';
  throw new Error("FREE_SCANNER_BACKEND must be 'not-connected' or 'fixture'");
};

export const variables = defineEnvVars({
  API_URL: {
    description:
      "The api's base URL on the private network, such as http://api.railway.internal:8080",
    schema: required('API_URL'),
  },
  SHOPIFY_API_KEY: {
    description: "The Shopify app's public client id, rendered for App Bridge",
    public: true,
    schema: required('SHOPIFY_API_KEY'),
  },
  TURNSTILE_SITE_KEY: {
    description:
      "The free scanner's Cloudflare Turnstile widget site key (LAUNCH.md section C, row 6); the scanner stays closed while this or the secret key is unset",
    schema: optional,
  },
  TURNSTILE_SECRET_KEY: {
    description:
      "The Turnstile widget's secret key, used only for server-side siteverify calls (LAUNCH.md section C, row 6)",
    schema: optional,
  },
  TURNSTILE_ORIGIN: {
    description:
      "Where Turnstile's script, frame and siteverify live; Cloudflare's own origin unless the end-to-end test fake replaces it",
    schema: turnstileOrigin,
  },
  FREE_SCANNER_BACKEND: {
    description:
      "'not-connected' (the default) until the engine accepts anonymous scans; 'fixture' serves a fixed sample result and exists for the end-to-end tests only (ADR-260)",
    schema: scannerBackend,
  },
  SERVICE_VERSION: {
    description: 'Reported as service.version, normally the image commit',
    schema: (value: string | undefined) => value ?? '0.0.0',
  },
});
