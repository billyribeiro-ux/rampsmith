import { fail } from '@sveltejs/kit';
import {
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
import { verifyTurnstile } from '#lib/server/scanner/turnstile.ts';
import type { Actions, PageServerLoad } from './$types';

/** What the page needs to know about the free scanner, with the secret left out. */
export const load: PageServerLoad = () => ({
  // Closed, not open and unprotected, while either Turnstile key is missing (LAUNCH.md C row 6).
  open: TURNSTILE_SITE_KEY !== '' && TURNSTILE_SECRET_KEY !== '',
  siteKey: TURNSTILE_SITE_KEY,
  turnstileOrigin: TURNSTILE_ORIGIN,
});

// One service per server process: its caps and its cache live here (ADR-262).
const service = createFreeScanService({
  scanner: scannerFor(FREE_SCANNER_BACKEND),
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
  refused: 200,
  'scanner-error': 502,
};

export const actions: Actions = {
  default: async ({ request, getClientAddress, setHeaders }) => {
    // Results and refusals belong to the visitor who asked: no cache, no index (PLAN §16).
    setHeaders({ 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex, nofollow' });

    if (TURNSTILE_SITE_KEY === '' || TURNSTILE_SECRET_KEY === '') {
      return fail(503, { kind: 'challenge-unavailable', url: '' } satisfies ScanFormData);
    }
    const form = await request.formData();
    const url = form.get('url');
    const token = form.get('cf-turnstile-response');
    const address = typeof url === 'string' ? url.slice(0, 2048) : '';

    const outcome = await service.run({
      url: address,
      ip: getClientAddress(),
      token: typeof token === 'string' ? token : '',
    });
    const data: ScanFormData = { ...outcome, url: address };
    if (outcome.kind === 'result') return data;
    if (outcome.kind === 'rate-limited') {
      setHeaders({ 'retry-after': outcome.retryAfterSeconds.toString() });
    }
    return fail(STATUS[outcome.kind], data);
  },
};
