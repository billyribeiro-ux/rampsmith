/**
 * Writes data-audit findings (origin `data`) for a tenant, inside the caller's transaction
 * (ADR-070). Shared by `audit.data` and `verify.scan`.
 */
import { uuidv7 } from '@rampsmith/queue';
import type postgres from 'postgres';
import type { DataItem } from './audit.ts';
import { fixabilityOf } from './rank.ts';

export interface DataRecorded {
  readonly findingId: string;
  readonly ruleId: string;
  readonly resource: string;
}

/** Upserts one finding per item, with its single occurrence. */
export async function recordDataItems(
  tx: postgres.TransactionSql,
  ctx: { readonly tenantId: string; readonly siteId: string; readonly scanId: string },
  inputId: string,
  items: readonly DataItem[],
  capturedAt: Date = new Date(),
): Promise<DataRecorded[]> {
  const recorded: DataRecorded[] = [];
  for (const item of items) {
    const f = item.finding;
    const status = f.outcome === 'incomplete' ? 'needs_review' : 'open';
    const fix = fixabilityOf(f.ruleId, 'data');
    const location = {
      resource: f.location.resource,
      field: f.location.field,
      start: f.location.start,
      end: f.location.end,
      owner: item.owner,
      input_id: inputId,
      ...(f.data === undefined ? {} : { data: f.data }),
    };
    const [row] = await tx<{ id: string }[]>`
      insert into findings (id, tenant_id, site_id, fingerprint, rule_id, criteria, impact, status,
                            source_location, first_seen_scan, last_seen_scan, occurrence_count,
                            origin, best_practice, fix_kind, fix_recipe, on_purchase_path)
      values (${uuidv7()}, ${ctx.tenantId}, ${ctx.siteId}, ${Buffer.from(item.fingerprint)},
              ${f.ruleId}, ${tx.array([...f.criteria])}, ${f.impact}, ${status},
              ${tx.json(location)}, ${ctx.scanId}, ${ctx.scanId}, 1, 'data',
              ${f.bestPractice}, ${fix.kind}, ${fix.recipe}, ${item.purchasePath})
      on conflict (site_id, fingerprint) do update
         set last_seen_scan = excluded.last_seen_scan,
             occurrence_count = 1,
             impact = excluded.impact,
             criteria = excluded.criteria,
             source_location = excluded.source_location,
             on_purchase_path = excluded.on_purchase_path,
             status = case
               when excluded.status = 'open' and findings.status in ('fixed', 'needs_review')
                 then 'open'
               when excluded.status = 'needs_review' and findings.status = 'fixed'
                 then 'needs_review'
               else findings.status end
       where findings.tenant_id = excluded.tenant_id
      returning id`;
    if (row === undefined) continue;
    await tx`
      insert into finding_occurrences
        (finding_id, scan_id, tenant_id, page_url, page_state, target, html_excerpt, captured_at)
      values (${row.id}, ${ctx.scanId}, ${ctx.tenantId}, ${f.location.resource}, 'default',
              ${`${f.location.field}:${String(f.location.start)}-${String(f.location.end)}`},
              ${item.excerpt}, ${capturedAt})`;
    recorded.push({ findingId: row.id, ruleId: f.ruleId, resource: f.location.resource });
  }
  return recorded;
}
