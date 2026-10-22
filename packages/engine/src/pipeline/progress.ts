/**
 * A scan's progress counters, advanced inside the transaction that records the work, so a
 * counter never gets ahead of the rows it counts (ADR-070). A scan is complete, and ready to be
 * finalised, when every planned page and every data input is done.
 */
import type postgres from 'postgres';

export interface Progress {
  readonly pagesDone: number;
  readonly pagesPlanned: number;
  readonly inputsDone: number;
  readonly inputsPlanned: number;
  /** True when finalising may begin: a plan exists and all of it is done. */
  readonly complete: boolean;
}

interface Row {
  pages_done: number;
  pages_planned: number;
  data_inputs_done: number;
  data_inputs_planned: number;
}

function toProgress(row: Row): Progress {
  return {
    pagesDone: row.pages_done,
    pagesPlanned: row.pages_planned,
    inputsDone: row.data_inputs_done,
    inputsPlanned: row.data_inputs_planned,
    complete:
      row.pages_planned > 0 &&
      row.pages_done >= row.pages_planned &&
      row.data_inputs_done >= row.data_inputs_planned,
  };
}

/**
 * Adds finished work to the scan. `checks` are added to `checks_run` and `checks_passed`. A data
 * input done before the plan counted the inputs raises the planned count to match, so the
 * counters stay consistent whichever job finishes first.
 */
export async function advance(
  tx: postgres.TransactionSql,
  tenantId: string,
  scanId: string,
  work: {
    readonly pages?: number;
    readonly inputs?: number;
    readonly checksRun?: number;
    readonly checksPassed?: number;
  },
): Promise<Progress | undefined> {
  const pages = work.pages ?? 0;
  const inputs = work.inputs ?? 0;
  const [row] = await tx<Row[]>`
    update scans
       set pages_done = pages_done + ${pages},
           data_inputs_done = data_inputs_done + ${inputs},
           data_inputs_planned = greatest(data_inputs_planned, data_inputs_done + ${inputs}),
           checks_run = checks_run + ${work.checksRun ?? 0},
           checks_passed = checks_passed + ${work.checksPassed ?? 0},
           started_at = coalesce(started_at, now()),
           status = case when status = 'queued' then 'running' else status end
     where tenant_id = ${tenantId} and id = ${scanId}
       and status in ('queued', 'running')
       and pages_done + ${pages} <= pages_planned
    returning pages_done, pages_planned, data_inputs_done, data_inputs_planned`;
  return row === undefined ? undefined : toProgress(row);
}

/** The scan's current progress, or `undefined` when it does not exist for this tenant. */
export async function progressOf(
  tx: postgres.TransactionSql,
  tenantId: string,
  scanId: string,
): Promise<Progress | undefined> {
  const [row] = await tx<Row[]>`
    select pages_done, pages_planned, data_inputs_done, data_inputs_planned
      from scans where tenant_id = ${tenantId} and id = ${scanId}`;
  return row === undefined ? undefined : toProgress(row);
}
