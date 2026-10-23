import { fail } from '@sveltejs/kit';
import {
  API_URL,
  FREE_SCAN_SERVICE_TOKEN,
  FREE_SCANNER_BACKEND,
  TURNSTILE_ORIGIN,
  TURNSTILE_SECRET_KEY,
  TURNSTILE_SITE_KEY,
} from '$app/env/private';
import {
  createFreeScanService,
  scannerFor,
  type FreeScanOutcomeForPage,
} from '#lib/server/scanner/service.ts';
import { apiClient } from '#lib/server/api.ts';
import { apiDelegate } from '#lib/server/scanner/delegate.ts';
import { verifyTurnstile } from '#lib/server/scanner/turnstile.ts';
import type { Actions, PageServerLoad } from './$types';

/**
 * Whether the scanner is open. It stays closed, not open and unprotected, while the challenge is
 * not set up (LAUNCH.md C row 6). With the api running the scans (ADR-265) the widget's site key
 * and the service token are what this server needs; the secret key lives with the api, which
 * verifies the challenge itself.
 */
const OPEN =
  FREE_SCANNER_BACKEND === 'api'
    ? TURNSTILE_SITE_KEY !== '' && FREE_SCAN_SERVICE_TOKEN !== ''
    : TURNSTILE_SITE_KEY !== '' && TURNSTILE_SECRET_KEY !== '';

/** What the page needs to know about the free scanner, with the secret left out. */
export const load: PageServerLoad = () => ({
  open: OPEN,
  siteKey: TURNSTILE_SITE_KEY,
  turnstileOrigin: TURNSTILE_ORIGIN,
});

// One service per server process. With the api backend it keeps nothing: the api holds the
// limits and the cache. Otherwise its caps and its cache live here (ADR-262).
const service = createFreeScanService({
  scanner: scannerFor(FREE_SCANNER_BACKEND),
  ...(FREE_SCANNER_BACKEND === 'api'
    ? {
        delegate: apiDelegate({
          client: apiClient(API_URL),
          serviceToken: FREE_SCAN_SERVICE_TOKEN,
        }),
      }
    : {}),
  verifyChallenge: (token, ip) =>
    verifyTurnstile({
      secret: TURNSTILE_SECRET_KEY,
      token,
      remoteIp: ip,
      origin: TURNSTILE_ORIGIN,
    }),
  now: () => Date.now(),
});

/** What a form post gives back to the page: the outcome, and the address as typed. */
export type ScanFormData = FreeScanOutcomeForPage & { readonly url: string };

const STATUS: Record<Exclude<FreeScanOutcomeForPage['kind'], 'result'>, number> = {
  'invalid-url': 400,
  'challenge-failed': 400,
  'challenge-unavailable': 503,
  'rate-limited': 429,
  'not-connected': 503,
  busy: 503,
  'still-running': 200,
  refused: 200,
  'scanner-error': 502,
};

const SCAN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const actions: Actions = {
  default: async ({ request, getClientAddress, setHeaders }) => {
    // Results and refusals belong to the visitor who asked: no cache, no index (PLAN §16).
    setHeaders({ 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex, nofollow' });

    if (!OPEN) {
      return fail(503, { kind: 'challenge-unavailable', url: '' } satisfies ScanFormData);
    }
    const form = await request.formData();
    const url = form.get('url');
    const token = form.get('cf-turnstile-response');
    const address = typeof url === 'string' ? url.slice(0, 2048) : '';

    // A form with a scan id asks again about a scan that was still running when the first request
    // gave up waiting. SvelteKit allows no named action next to the default one, so it is a field.
    const scan = form.get('scan');
    if (scan !== null) {
      if (typeof scan !== 'string' || !SCAN_ID.test(scan)) {
        return fail(400, { kind: 'scanner-error', url: address } satisfies ScanFormData);
      }
      const known = await service.status(scan);
      const answer: ScanFormData = { ...known, url: address };
      if (known.kind === 'result' || known.kind === 'still-running') return answer;
      return fail(STATUS[known.kind], answer);
    }

    const outcome = await service.run({
      url: address,
      ip: getClientAddress(),
      token: typeof token === 'string' ? token : '',
    });
    const data: ScanFormData = { ...outcome, url: address };
    if (outcome.kind === 'result' || outcome.kind === 'still-running') return data;
    if (outcome.kind === 'rate-limited') {
      setHeaders({ 'retry-after': outcome.retryAfterSeconds.toString() });
    }
    return fail(STATUS[outcome.kind], data);
  },
};
