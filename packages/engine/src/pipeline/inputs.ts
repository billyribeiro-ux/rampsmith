/**
 * Reads a scan's store data from `scan_inputs` (ADR-035), inside the caller's tenant-scoped
 * transaction, and parses it (`snapshot.ts`).
 */
import type postgres from 'postgres';
import {
  AUDITED_KINDS,
  mergeBatches,
  parseBatch,
  parseShop,
  type AuditedKind,
  type Batch,
  type InputKind,
  type ShopFacts,
} from './snapshot.ts';

export interface InputRow {
  readonly id: string;
  readonly kind: InputKind;
  readonly seq: number;
  readonly payload: unknown;
}

export interface ScanInputs {
  readonly rows: readonly InputRow[];
  readonly shop: ShopFacts;
  readonly batch: Batch;
}

function isAudited(kind: InputKind): kind is AuditedKind {
  return (AUDITED_KINDS as readonly string[]).includes(kind);
}

export async function readInputs(
  tx: postgres.TransactionSql,
  tenantId: string,
  scanId: string,
  fallbackLocale: string,
): Promise<ScanInputs> {
  const rows = await tx<InputRow[]>`
    select id, kind, seq, payload from scan_inputs
     where tenant_id = ${tenantId} and scan_id = ${scanId}
     order by kind, seq`;
  const shopRow = rows.filter((r) => r.kind === 'shop').at(-1);
  return {
    rows,
    shop: parseShop(shopRow?.payload, fallbackLocale),
    batch: mergeBatches(
      rows.flatMap((r) => (isAudited(r.kind) ? [parseBatch(r.kind, r.payload)] : [])),
    ),
  };
}

/** One stored input, by id. */
export async function readInput(
  tx: postgres.TransactionSql,
  tenantId: string,
  inputId: string,
): Promise<(InputRow & { readonly scanId: string }) | undefined> {
  const [row] = await tx<(InputRow & { scan_id: string })[]>`
    select id, kind, seq, payload, scan_id from scan_inputs
     where tenant_id = ${tenantId} and id = ${inputId}`;
  return row === undefined ? undefined : { ...row, scanId: row.scan_id };
}
