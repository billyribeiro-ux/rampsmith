/**
 * Live check for LAUNCH.md section E: a test email delivered through Amazon SES, which needs
 * section C row 7. Without those inputs the test skips with a notice naming the row; the
 * substitute that passes now is the rendering, guard and MemorySender suites (sender.test.ts,
 * render.test.ts) and the SES adapter against a stand-in endpoint that checks the SigV4
 * signature and the request shape (ses.test.ts, sigv4.test.ts, ADR-270). With row 7 set the test
 * sends the `delivery_test` email for real.
 *
 * Run it live: `pnpm --filter @rampsmith/email exec vitest run test/live.test.ts`, then open the
 * message, read its source, and check the three things only a delivered message shows (E row
 * "Test email delivered through Amazon SES"): `multipart/alternative` with an encoding, no
 * tracking pixel and no rewritten links, and a `DKIM-Signature` whose `h=` lists the headers.
 */
import { describe, expect, it } from 'vitest';
import {
  createSesSender,
  guardSender,
  MemoryLedger,
  sesConfigFromEnv,
  withLedger,
} from '../src/index.ts';
import { renderer } from './helpers.ts';

describe('live: test email through Amazon SES (LAUNCH.md C row 7)', () => {
  it('delivers the delivery_test email to the founder', async (ctx) => {
    const config = sesConfigFromEnv(process.env);
    if ('missing' in config) {
      const notice = `skipped: needs LAUNCH.md section C row 7 (${config.missing.join(', ')}); substitute tests: ses.test.ts, sigv4.test.ts, sender.test.ts, render.test.ts`;
      process.stderr.write(`email live check ${notice}\n`);
      ctx.skip(notice);
      return;
    }
    const sender = guardSender(withLedger(createSesSender(config), new MemoryLedger()));
    const to = process.env['EMAIL_TEST_RECIPIENT'] ?? config.from;
    const email = renderer.render('delivery_test', { requestedAt: new Date().toISOString() });
    const receipt = await sender.send({
      to: to.replace(/^.*<([^>]+)>$/u, '$1').trim(),
      idempotencyKey: `delivery-test:${String(Date.now())}`,
      email,
    });
    expect(receipt.status).toBe('sent');
  });
});
