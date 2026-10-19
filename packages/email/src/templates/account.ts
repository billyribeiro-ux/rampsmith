/** Dashboard account emails: the sign-in link, address confirmation and the delivery test. */
import { instant, int, link, object } from '../schema.ts';
import { action, COMMON, defineTemplate, facts, msg, paragraph, value } from '../template.ts';

/**
 * The single-use sign-in link, the passkey fallback (PLAN §16). The link carries the token;
 * nothing else in the email does: not the subject, the preview text or any header.
 */
export const signInLink = defineTemplate({
  category: 'security',
  schema: object({
    ...COMMON,
    /** The full sign-in link, token included, on the app origin. */
    signInUrl: link(['app']),
    /** Minutes until the link expires (PLAN §16: 15). */
    expiresInMinutes: int(1, 60),
  }),
  build(input, t) {
    const minutes = input.expiresInMinutes;
    return {
      subject: t.text('sign_in_link_subject'),
      preheader: t.text('sign_in_link_preheader', { minutes }),
      title: t.text('sign_in_link_title'),
      blocks: [
        paragraph(msg(t, 'sign_in_link_intro')),
        action(t, t.text('sign_in_link_button'), input.signInUrl, true),
        paragraph(msg(t, 'common_link_expiry_minutes', { minutes })),
        paragraph(msg(t, 'sign_in_link_do_not_forward')),
        paragraph(msg(t, 'sign_in_link_not_you')),
      ],
      reason: msg(t, 'sign_in_link_reason'),
    };
  },
});

/** Confirms that a new dashboard account's address belongs to the person (ADR-024). */
export const emailVerification = defineTemplate({
  category: 'security',
  schema: object({
    ...COMMON,
    /** The confirmation link, token included, on the app origin. */
    verifyUrl: link(['app']),
    expiresInMinutes: int(1, 1440),
  }),
  build(input, t) {
    const minutes = input.expiresInMinutes;
    return {
      subject: t.text('email_verification_subject'),
      preheader: t.text('email_verification_preheader'),
      title: t.text('email_verification_title'),
      blocks: [
        paragraph(msg(t, 'email_verification_intro')),
        action(t, t.text('email_verification_button'), input.verifyUrl, true),
        paragraph(msg(t, 'common_link_expiry_minutes', { minutes })),
        paragraph(msg(t, 'email_verification_not_you')),
      ],
      reason: msg(t, 'email_verification_reason'),
    };
  },
});

/** A test message for `rsctl doctor` and the live delivery check (LAUNCH.md C row 7). */
export const deliveryTest = defineTemplate({
  category: 'security',
  schema: object({
    ...COMMON,
    requestedAt: instant(),
  }),
  build(input, t) {
    return {
      subject: t.text('delivery_test_subject'),
      preheader: t.text('delivery_test_preheader'),
      title: t.text('delivery_test_title'),
      blocks: [
        paragraph(msg(t, 'delivery_test_intro')),
        facts([
          {
            label: msg(t, 'delivery_test_requested_label'),
            value: value(t.dateTime(input.requestedAt)),
          },
        ]),
      ],
      reason: msg(t, 'delivery_test_reason'),
    };
  },
});
