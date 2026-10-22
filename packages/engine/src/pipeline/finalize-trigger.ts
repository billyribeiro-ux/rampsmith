import { enqueue } from '@rampsmith/queue';
import type postgres from 'postgres';

/** Enqueues `scan.finalize@1` once; the idempotency key makes a second call a no-op. */
export async function finalizeWhenComplete(
  sql: postgres.Sql,
  ctx: { readonly tenantId: string; readonly siteId: string; readonly scanId: string },
  complete: boolean,
): Promise<void> {
  if (!complete) return;
  await enqueue(sql, {
    queue: 'scan.finalize',
    payloadSchema: 'scan.finalize@1',
    payload: { scan_id: ctx.scanId, site_id: ctx.siteId },
    tenantId: ctx.tenantId,
    idempotencyKey: `scan.finalize:${ctx.scanId}`,
  });
}
