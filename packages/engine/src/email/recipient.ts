/**
 * Resolves a recipient reference (`contracts::EmailRecipient`) to an address inside the job's
 * tenant transaction (ADR-272). The address exists only in the returned value and in the
 * database: it is never logged, put in an error or written anywhere else.
 */
import type { EmailRecipient } from '@rampsmith/contracts-ts';
import type postgres from 'postgres';
import { withTenant } from '../store.ts';
import type { SuppressionReason } from './suppression.ts';

export interface ResolvedRecipient {
  readonly address: string;
  /** Why the tenant's suppression list holds this address, when it does. */
  readonly suppression: SuppressionReason | null;
}

/** The recipient, or `undefined` when the reference names nothing this tenant owns. */
export async function resolveRecipient(
  sql: postgres.Sql,
  tenantId: string,
  recipient: EmailRecipient,
): Promise<ResolvedRecipient | undefined> {
  return withTenant(sql, tenantId, async (tx) => {
    // The tenant filter repeats what row-level security enforces: two layers (ADR-006).
    const [row] = await tx<{ email: string; reason: SuppressionReason | null }[]>`
      select c.email, s.reason
        from shop_contacts c
        left join email_suppressions s
               on s.tenant_id = c.tenant_id
              and s.address_hash = email_address_hash(c.tenant_id, c.email)
       where c.tenant_id = ${tenantId} and c.shop_id = ${recipient.shop_id}`;
    return row === undefined ? undefined : { address: row.email, suppression: row.reason };
  });
}
