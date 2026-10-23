/**
 * Resolves a recipient reference (`contracts::EmailRecipient`) to an address inside the job's
 * tenant transaction (ADR-272). The address exists only in the returned value and in the
 * database: it is never logged, put in an error or written anywhere else.
 *
 * Which address (ADR-275): notification and marketing mail goes to the notification address the
 * merchant set in the App Home settings, when they set one; everything else (security,
 * transactional) goes to the shop owner's address Shopify reports, because a deletion notice or
 * an incident notice must reach the account holder.
 */
import { isEmailAddress, type Category, type OptOutCategory } from '@rampsmith/email';
import type { EmailRecipient } from '@rampsmith/contracts-ts';
import type postgres from 'postgres';
import { withTenant } from '../store.ts';
import type { SuppressionReason } from './suppression.ts';

export interface ResolvedRecipient {
  readonly address: string;
  /** `email_address_hash(tenant, address)`: what the suppression tables and links hold. */
  readonly addressHash: Uint8Array;
  /** The store the mail is about. */
  readonly shopId: string;
  /** Why the tenant's suppression list holds this address, when it does. */
  readonly suppression: SuppressionReason | null;
  /** The categories this address has switched off. */
  readonly optOuts: readonly OptOutCategory[];
}

/** The recipient, or `undefined` when the reference names nothing this tenant owns. */
export async function resolveRecipient(
  sql: postgres.Sql,
  tenantId: string,
  recipient: EmailRecipient,
  category: Category,
): Promise<ResolvedRecipient | undefined> {
  return withTenant(sql, tenantId, async (tx) => {
    // The tenant filter repeats what row-level security enforces: two layers (ADR-006).
    const [contact] = await tx<{ owner: string; notify: string | null }[]>`
      select c.email as owner, nullif(btrim(st.settings ->> 'notification_email'), '') as notify
        from shop_contacts c
        join shopify_shops sh on sh.id = c.shop_id and sh.tenant_id = c.tenant_id
        join sites st on st.id = sh.site_id and st.tenant_id = sh.tenant_id
       where c.tenant_id = ${tenantId} and c.shop_id = ${recipient.shop_id}`;
    if (contact === undefined) return undefined;
    const preferred = contact.notify?.toLowerCase() ?? null;
    const address =
      (category === 'notification' || category === 'marketing') &&
      preferred !== null &&
      isEmailAddress(preferred)
        ? preferred
        : contact.owner;
    const [row] = await tx<
      { hash: Buffer; reason: SuppressionReason | null; opt_outs: OptOutCategory[] }[]
    >`
      select email_address_hash(${tenantId}::uuid, ${address}) as hash,
             (select s.reason from email_suppressions s
               where s.tenant_id = ${tenantId}
                 and s.address_hash = email_address_hash(${tenantId}::uuid, ${address})) as reason,
             array(select o.category from email_opt_outs o
                    where o.tenant_id = ${tenantId}
                      and o.address_hash = email_address_hash(${tenantId}::uuid, ${address})
                    order by o.category) as opt_outs`;
    if (row === undefined) return undefined;
    return {
      address,
      addressHash: Uint8Array.from(row.hash),
      shopId: recipient.shop_id,
      suppression: row.reason,
      optOuts: row.opt_outs,
    };
  });
}
