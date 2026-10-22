import process from 'node:process';
import { expect, test } from '@playwright/test';
import { verifyTurnstile } from '../src/lib/server/scanner/turnstile.ts';

/**
 * The live check for the free scanner's bot protection (LAUNCH.md section E): it asks Cloudflare's
 * real siteverify endpoint about a token that was never issued. A working secret key gets the
 * answer "invalid-input-response" (our verdict: `invalid`); a wrong key, or no reachable
 * Cloudflare, comes back as `unavailable`. It never passes silently: without the key it skips,
 * and the skip names the input that is missing.
 */
const secret = process.env['TURNSTILE_SECRET_KEY'];

test('Cloudflare accepts our Turnstile secret key and rejects a made-up token', async () => {
  test.skip(
    secret === undefined || secret === '',
    'SKIPPED: needs LAUNCH.md section C, row 6 (the Cloudflare Turnstile widget: TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY). The stand-in tests in site-scanner.spec.ts cover the code path.',
  );
  const verdict = await verifyTurnstile({
    secret: secret ?? '',
    token: 'rampsmith-live-check-not-a-real-token',
  });
  expect(verdict).toEqual({ ok: false, reason: 'invalid' });
});
