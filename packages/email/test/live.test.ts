/**
 * Live check for LAUNCH.md section E: a test email delivered through Amazon SES, which needs
 * section C row 7. Without those inputs the test skips with a notice naming the row; the
 * substitute that passes now is the rendering, guard and MemorySender suites (sender.test.ts,
 * render.test.ts). This package calls no mail provider (ADR-194): when row 7 is present and
 * no SES adapter is wired in yet, the test fails instead of passing silently.
 */
import { describe, expect, it } from 'vitest';
import { guardSender, type EmailSender } from '../src/index.ts';
import { renderer } from './helpers.ts';

const ROW_7 = ['SES_REGION', 'SES_ACCESS_KEY_ID', 'SES_SECRET_ACCESS_KEY', 'EMAIL_FROM'] as const;

/**
 * The SES adapter, once integration adds it (ADR-194, integration step 3). It returns null
 * until then.
 */
function liveSender(): EmailSender | null {
  return null;
}

describe('live: test email through Amazon SES (LAUNCH.md C row 7)', () => {
  it('delivers the delivery_test email to the founder', async (ctx) => {
    const missing = ROW_7.filter((name) => (process.env[name] ?? '') === '');
    if (missing.length > 0) {
      const notice = `skipped: needs LAUNCH.md section C row 7 (${missing.join(', ')}); substitute tests: sender.test.ts, render.test.ts`;
      process.stderr.write(`email live check ${notice}\n`);
      ctx.skip(notice);
    }
    const sender = liveSender();
    if (sender === null) {
      expect.fail(
        'LAUNCH.md C row 7 is set, but no SES adapter implements EmailSender yet (ADR-194, integration step 3)',
      );
    }
    const to = process.env['EMAIL_TEST_RECIPIENT'] ?? process.env['EMAIL_FROM'] ?? '';
    const email = renderer.render('delivery_test', { requestedAt: new Date().toISOString() });
    const receipt = await guardSender(sender).send({
      to: to.replace(/^.*<([^>]+)>$/u, '$1'),
      idempotencyKey: `delivery-test:${String(Date.now())}`,
      email,
    });
    expect(receipt.status).toBe('sent');
  });
});
