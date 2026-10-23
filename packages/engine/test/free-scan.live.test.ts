/**
 * The live check for the free scanner's anonymous path (LAUNCH.md section E, "Free scanner
 * end-to-end scan"): a deployed api and engine scan a real public site. It runs when the three
 * variables below are set and otherwise skips with a notice naming the rows; it never passes
 * silently. The substitutes that pass now are `free-scan.e2e.ts` (the engine over a local site
 * and egress) and `crates/api/tests/free_scan.rs` (the api against a Turnstile stand-in).
 *
 *   RAMPSMITH_LIVE_API_URL=https://… FREE_SCAN_SERVICE_TOKEN=… RAMPSMITH_LIVE_SCAN_DOMAIN=… \
 *     pnpm --filter @rampsmith/engine exec vitest run test/free-scan.live.test.ts
 *
 * The deployment under test must use Cloudflare's published always-pass Turnstile test secret
 * (`1x0000000000000000000000000000000AA`), so that the dummy token below verifies: staging only.
 * The scanned domain is a site the founder owns or has permission to scan.
 */
import process from 'node:process';
import { describe, expect, it } from 'vitest';

const api = process.env['RAMPSMITH_LIVE_API_URL']?.replace(/\/$/, '') ?? '';
const token = process.env['FREE_SCAN_SERVICE_TOKEN'] ?? '';
const domain = process.env['RAMPSMITH_LIVE_SCAN_DOMAIN'] ?? '';
const live = api !== '' && token !== '' && domain !== '';
const NOTICE =
  'needs RAMPSMITH_LIVE_API_URL, FREE_SCAN_SERVICE_TOKEN and RAMPSMITH_LIVE_SCAN_DOMAIN ' +
  '(LAUNCH.md section C, rows 6 and 12; section E, "Free scanner end-to-end scan")';

if (!live) {
  const annotation =
    process.env['GITHUB_ACTIONS'] === 'true'
      ? '::notice title=Free scanner live check skipped::'
      : '';
  process.stderr.write(`${annotation}free scanner live check skipped: ${NOTICE}\n`);
}

describe.skipIf(!live)(`live free scan (${NOTICE})`, () => {
  it('scans a real site through the api and the engine and returns a summary', async () => {
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const created = await fetch(`${api}/v1/free-scans`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        url: domain,
        turnstile_token: 'XXXX.DUMMY.TOKEN.XXXX',
        client_ip: '203.0.113.7',
      }),
    });
    expect([200, 201, 202]).toContain(created.status);
    const scan = (await created.json()) as { id: string; status: string };
    let state = scan;
    for (let i = 0; i < 60 && ['queued', 'running'].includes(state.status); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const polled = await fetch(`${api}/v1/free-scans/${scan.id}`, { headers });
      expect(polled.status).toBe(200);
      state = (await polled.json()) as typeof scan;
    }
    expect(state.status).toBe('complete');
    const result = (state as unknown as { result: { pages: string[]; checks_run: number } }).result;
    expect(result.pages.length).toBeGreaterThan(0);
    expect(result.checks_run).toBeGreaterThan(0);
  }, 240_000);
});
