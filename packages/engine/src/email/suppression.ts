/**
 * Which suppressions stop which emails (ADR-191, ADR-272). An unsubscribe is the recipient's
 * choice about optional mail: it stops notifications and marketing, never a sign-in link or a
 * notice the law or the product requires. A bounce, a complaint and an operator's entry stop
 * everything, because sending to an address that cannot receive or has complained only harms the
 * sender's reputation with the mail provider.
 */
import type { Category } from '@rampsmith/email';

export type SuppressionReason = 'unsubscribed' | 'bounced' | 'complained' | 'manual';

export function blocks(reason: SuppressionReason, category: Category): boolean {
  if (reason === 'unsubscribed') {
    return category === 'notification' || category === 'marketing';
  }
  return true;
}
