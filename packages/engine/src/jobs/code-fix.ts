/**
 * `code_fix.patch@1` (ADR-295, ADR-296): maps a store's open code findings to the theme files
 * `ctl` read from the merchant's repository, runs the recipes through `@rampsmith/liquid-patch`,
 * checks the result with Theme Check, and stores the fixes and the files after each one for
 * `ctl` to turn into a pull request.
 *
 * The engine never talks to GitHub and never holds its key. It reads the files from
 * `code_fix_files` and writes there; the theme source is the merchant's own, kept only until the
 * pull request is opened (or the batch ends without one).
 *
 * One transaction does all the writing, so a retry after a crash finds the batch either still
 * `patching` (nothing was written) or done.
 */
import {
  planBatch,
  type BatchFinding,
  type BatchNode,
  type BatchPlan,
  type FixParams,
} from '@rampsmith/liquid-patch';
import { JobFailure, enqueue, uuidv7 } from '@rampsmith/queue';
import type postgres from 'postgres';
import { criterionOf, templateOf, wordingOf } from '../code-fix/wording.ts';
import { renderedElementOf } from '../code-fix/rendered.ts';
import { withTenant } from '../store.ts';
import { isLastAttempt, parsePayload, requireTenant, type JobHandler } from './payload.ts';

/** Most open findings one batch plans; the next batch takes the rest. */
const MAX_FINDINGS = 500;
/** Most occurrences of a finding the planner is given (the mapper uses at most five). */
const MAX_OCCURRENCES = 5;
/** Largest unified diff kept in a fix record. */
const MAX_DIFF_BYTES = 32_768;

function permanent(code: string, message: string): JobFailure {
  return new JobFailure('permanent', { code, message });
}

export interface CodeFixDeps {
  readonly sql: postgres.Sql;
}

interface BatchRow {
  readonly id: string;
  readonly site_id: string;
  readonly status: string;
  readonly recipes: 'core' | 'every';
  readonly judgements: unknown;
}

interface FindingRow {
  readonly id: string;
  readonly rule_id: string;
  readonly criteria: string[];
}

interface OccurrenceRow {
  readonly finding_id: string;
  readonly page_type: string | null;
  readonly html_excerpt: string;
  readonly section_id: string | null;
  readonly ancestors: unknown;
  readonly evidence: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** What the person brought for each finding (`code_fix_batches.judgements`). */
export function judgementsOf(raw: unknown): Map<string, FixParams> {
  const out = new Map<string, FixParams>();
  if (!Array.isArray(raw)) return out;
  for (const item of raw as unknown[]) {
    if (!isRecord(item) || typeof item['finding_id'] !== 'string') continue;
    const label = item['label'];
    const reason = item['decorative_reason'];
    const id = item['id'];
    const params: FixParams = {
      ...(isRecord(label) && typeof label['key'] === 'string' && typeof label['text'] === 'string'
        ? { label: { key: label['key'], text: label['text'] } }
        : {}),
      ...(typeof reason === 'string' && reason !== '' ? { decorative: { reason } } : {}),
      ...(typeof id === 'string' && id !== '' ? { id } : {}),
    };
    out.set(item['finding_id'], params);
  }
  return out;
}

/** What axe-core measured for a contrast node, as stored by the scanner (`evidence`). */
function contrastOf(evidence: unknown): BatchNode['contrast'] {
  if (!isRecord(evidence)) return undefined;
  const background = evidence['background'];
  const size = evidence['font_size_px'];
  if (typeof background !== 'string' || typeof size !== 'number' || !(size > 0)) return undefined;
  return { background, fontSizePx: size, bold: evidence['bold'] === true };
}

function foregroundOf(evidence: unknown): { foreground: string } | undefined {
  if (!isRecord(evidence)) return undefined;
  const foreground = evidence['foreground'];
  return typeof foreground === 'string' ? { foreground } : undefined;
}

/** The planner's findings from the stored rows. A finding with no usable occurrence has no nodes. */
export function batchFindings(
  findings: readonly FindingRow[],
  occurrences: readonly OccurrenceRow[],
  judgements: ReadonlyMap<string, FixParams>,
): BatchFinding[] {
  const byFinding = new Map<string, OccurrenceRow[]>();
  for (const o of occurrences) {
    const list = byFinding.get(o.finding_id) ?? [];
    if (list.length < MAX_OCCURRENCES) list.push(o);
    byFinding.set(o.finding_id, list);
  }
  return findings.map((f) => {
    const nodes: BatchNode[] = [];
    let template = 'index';
    for (const [i, o] of (byFinding.get(f.id) ?? []).entries()) {
      const element = renderedElementOf(o.html_excerpt, o.section_id, o.ancestors);
      if (element === null) continue;
      if (i === 0) template = templateOf(o.page_type);
      const contrast = contrastOf(o.evidence);
      const foreground = foregroundOf(o.evidence);
      nodes.push({
        element,
        template: templateOf(o.page_type),
        ...(foreground === undefined ? {} : { evidence: foreground }),
        ...(contrast === undefined ? {} : { contrast }),
      });
    }
    const params = judgements.get(f.id);
    return {
      id: f.id,
      rule: f.rule_id,
      template,
      nodes,
      ...(params === undefined ? {} : { params }),
    };
  });
}

function cap(text: string): string {
  return text.length <= MAX_DIFF_BYTES ? text : `${text.slice(0, MAX_DIFF_BYTES)}\n`;
}

type Tx = postgres.TransactionSql;

async function store(
  tx: Tx,
  tenantId: string,
  batch: BatchRow,
  plan: BatchPlan,
  findings: ReadonlyMap<string, FindingRow>,
): Promise<number> {
  let ordinal = 0;
  for (const step of plan.steps) {
    const finding = findings.get(step.fix.findingId);
    const wording = wordingOf(step.fix.rule);
    const criterion = criterionOf(step.fix.rule, finding?.criteria ?? []);
    if (finding === undefined || wording === null || criterion === null) continue;
    ordinal += 1;
    const fixId = uuidv7();
    const diff = {
      rule: step.fix.rule,
      notes: step.fix.notes,
      files: step.files.map((f) => ({ file: f.file, diff: cap(f.diff) })),
    };
    await tx`
      insert into fixes (id, tenant_id, site_id, kind, channel, status, origin, confidence, diff)
      values (${fixId}, ${tenantId}, ${batch.site_id}, 'code', 'github_pr', 'proposed', 'rule',
              ${step.fix.confidence.toFixed(3)}, ${tx.json(diff)})`;
    await tx`
      insert into fix_findings (fix_id, finding_id, tenant_id)
      values (${fixId}, ${finding.id}, ${tenantId})`;
    await tx`
      insert into code_fix_batch_fixes
        (batch_row, tenant_id, fix_id, ordinal, rule_id, criterion, summary, finding)
      values (${batch.id}, ${tenantId}, ${fixId}, ${ordinal}, ${step.fix.rule}, ${criterion},
              ${wording.summary}, ${wording.finding})`;
    for (const file of step.files) {
      await tx`
        insert into code_fix_files (batch_row, tenant_id, path, ordinal, content)
        values (${batch.id}, ${tenantId}, ${file.file}, ${ordinal}, ${file.after})`;
    }
  }
  return ordinal;
}

/** The outcome document: counts and, for each finding not fixed, a code. No finding text. */
function outcomeOf(considered: number, fixed: number, plan: BatchPlan): postgres.JSONValue {
  return {
    considered,
    fixed,
    skipped: plan.skipped.slice(0, 500).map((s) => ({
      finding_id: s.findingId,
      code: s.code,
      detail: s.detail.slice(0, 120),
    })),
  };
}

async function patch(deps: CodeFixDeps, tenantId: string, batchRow: string): Promise<void> {
  await withTenant(deps.sql, tenantId, async (tx) => {
    const [batch] = await tx<BatchRow[]>`
      select id, site_id, status, recipes, judgements
        from code_fix_batches
       where tenant_id = ${tenantId} and id = ${batchRow}
         for update`;
    if (batch === undefined) throw permanent('batch_not_found', 'no such batch for this tenant');
    // Done, or not yet read: another attempt, or `ctl`, owns it.
    if (batch.status !== 'patching') return;

    const sources = await tx<{ path: string; content: string }[]>`
      select path, content from code_fix_files
       where tenant_id = ${tenantId} and batch_row = ${batchRow} and ordinal = 0
       order by path`;
    if (sources.length === 0) throw permanent('files_missing', 'the batch has no theme files');
    const files = new Map(sources.map((s) => [s.path, s.content]));

    const findings = await tx<FindingRow[]>`
      select id, rule_id, criteria from findings
       where tenant_id = ${tenantId} and site_id = ${batch.site_id}
         and status = 'open' and fix_kind = 'code'
       order by id
       limit ${MAX_FINDINGS}`;
    const occurrences =
      findings.length === 0
        ? []
        : await tx<OccurrenceRow[]>`
            select o.finding_id, o.page_type, o.html_excerpt, o.section_id, o.ancestors, o.evidence
              from finding_occurrences o
              join findings f on f.id = o.finding_id and f.tenant_id = o.tenant_id
                             and f.last_seen_scan = o.scan_id
             where o.tenant_id = ${tenantId}
               and o.finding_id in ${tx(findings.map((f) => f.id))}
             order by o.finding_id, o.captured_at desc`;

    const plan = await planBatch(
      files,
      batchFindings(findings, occurrences, judgementsOf(batch.judgements)),
      { contrast: batch.recipes === 'every' },
    );
    const byId = new Map(findings.map((f) => [f.id, f]));
    const fixed = await store(tx, tenantId, batch, plan, byId);
    const outcome = outcomeOf(findings.length, fixed, plan);
    if (fixed === 0) {
      // Nothing to open: the merchant's source is not kept.
      await tx`delete from code_fix_files where tenant_id = ${tenantId} and batch_row = ${batchRow}`;
      await tx`
        update code_fix_batches
           set status = 'nothing_to_fix', outcome = ${tx.json(outcome)}, updated_at = now()
         where tenant_id = ${tenantId} and id = ${batchRow}`;
      return;
    }
    await tx`
      update code_fix_batches
         set status = 'ready', outcome = ${tx.json(outcome)}, updated_at = now()
       where tenant_id = ${tenantId} and id = ${batchRow}`;
    await enqueue(tx, {
      queue: 'github.open_pr',
      payloadSchema: 'github.open_pr@1',
      payload: { batch_row: batchRow },
      tenantId,
      idempotencyKey: `github.open_pr:${batchRow}`,
      maxAttempts: 8,
    });
  });
}

/** Ends the batch without a pull request and drops the stored source. */
async function fail(deps: CodeFixDeps, tenantId: string, batchRow: string, code: string) {
  await withTenant(deps.sql, tenantId, async (tx) => {
    await tx`delete from code_fix_files where tenant_id = ${tenantId} and batch_row = ${batchRow}`;
    await tx`
      update code_fix_batches
         set status = 'failed', failure_code = ${code}, updated_at = now()
       where tenant_id = ${tenantId} and id = ${batchRow} and status = 'patching'`;
  });
}

export function codeFixPatchHandler(deps: CodeFixDeps): JobHandler {
  return async (job) => {
    const payload = parsePayload(job, 'code_fix.patch@1');
    const tenantId = requireTenant(job);
    try {
      await patch(deps, tenantId, payload.batch_row);
    } catch (error: unknown) {
      const last =
        isLastAttempt(job) || (error instanceof JobFailure && error.failure.kind === 'permanent');
      if (last) {
        const code = error instanceof JobFailure ? error.failure.error.code : 'patch_failed';
        await fail(deps, tenantId, payload.batch_row, code.replaceAll(/[^a-z0-9_]/gu, '_'));
      }
      throw error;
    }
  };
}
