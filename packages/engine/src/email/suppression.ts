/**
 * Which suppressions and opt-outs stop which emails (ADR-191, ADR-273, ADR-275). An unsubscribe
 * is the recipient's choice about optional mail: it stops the category they switched off, never
 * a sign-in link or a notice the law or the product requires. A bounce, a complaint and an
 * operator's entry stop everything, because sending to an address that cannot receive or has
 * complained only harms the sender's reputation with the mail provider.
 */
import type { Category, OptOutCategory } from '@rampsmith/email';

export type SuppressionReason = 'unsubscribed' | 'bounced' | 'complained' | 'manual';

/** What is recorded when the recipient turned the message's category off. */
export const OPTED_OUT = 'opted_out';

/** Whether a suppression of `reason` stops mail of `category`. */
export function blocks(reason: SuppressionReason, category: Category): boolean {
  if (reason === 'unsubscribed') {
    return category === 'notification' || category === 'marketing';
  }
  return true;
}

/**
 * Why a message of `category` must not be sent to this address, or `null` when it may be: the
 * suppression's reason, else {@link OPTED_OUT} when the recipient switched the category off.
 * Security and transactional mail has no opt-out (a sign-in link, a deletion notice).
 */
export function refusalFor(
  category: Category,
  suppression: SuppressionReason | null,
  optOuts: readonly OptOutCategory[],
): SuppressionReason | typeof OPTED_OUT | null {
  if (suppression !== null && blocks(suppression, category)) return suppression;
  if ((category === 'notification' || category === 'marketing') && optOuts.includes(category)) {
    return OPTED_OUT;
  }
  return null;
}
