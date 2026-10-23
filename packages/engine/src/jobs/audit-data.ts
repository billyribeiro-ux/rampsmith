/**
 * `audit.data@1` (ADR-035, ADR-036, ADR-070): audits one stored batch of store data with the
 * data rules of `@rampsmith/a11y-rules` and records the findings. No browser and no token: the
 * batch is what `ctl` read into `scan_inputs`. A missing or empty alt text also queues an
 * `ai.alt_text@1` job, so a draft is waiting by the time the merchant looks (ADR-035 item 5).
 */
import { JobFailure, enqueue } from '@rampsmith/queue';
import type postgres from 'postgres';
import { enqueueRoom } from '../ai/allowance.ts';
import { auditBatch } from '../pipeline/audit.ts';
import { finalizeWhenComplete } from '../pipeline/finalize-trigger.ts';
import { recordDataItems } from '../pipeline/data-store.ts';
import { readInput } from '../pipeline/inputs.ts';
import { advance } from '../pipeline/progress.ts';
import { AUDITED_KINDS, parseBatch, parseShop, type AuditedKind } from '../pipeline/snapshot.ts';
import { withTenant } from '../store.ts';
import { parsePayload, requireTenant, type JobHandler } from './payload.ts';

/**
 * Most alt-text drafts one batch queues; the rest are queued by the next scan. Never more than
 * the plan's draft allowance has room for (security audit M3, ADR-097).
 */
const MAX_ALT_TEXT_JOBS = 500;

const ALT_RULES = new Set(['rs-media-alt-empty', 'rs-media-alt-filename']);

function permanent(code: string, message: string): JobFailure {
  return new JobFailure('permanent', { code, message });
}

interface CoverageDocument {
  data_audit?: {
    done_inputs?: string[];
    resources?: number;
    not_audited?: number;
    skipped_rules?: string[];
  };
  [key: string]: unknown;
}

export interface AuditDeps {
  readonly sql: postgres.Sql;
}

export function auditDataHandler(deps: AuditDeps): JobHandler {
  return async (job) => {
    const payload = parsePayload(job, 'audit.data@1');
    const tenantId = requireTenant(job);
    const ctx = { tenantId, siteId: payload.site_id, scanId: payload.scan_id };
    const complete = await withTenant(deps.sql, tenantId, async (tx) => {
      const [scan] = await tx<{ coverage: CoverageDocument | null; locale: string }[]>`
        select s.coverage, st.primary_locale as locale
          from scans s join sites st on st.id = s.site_id and st.tenant_id = s.tenant_id
         where s.tenant_id = ${tenantId} and s.id = ${payload.scan_id}
           and s.site_id = ${payload.site_id}
         for update of s`;
      if (scan === undefined) throw permanent('scan_not_found', 'no such scan for this tenant');
      const input = await readInput(tx, tenantId, payload.input_id);
      if (input?.scanId !== payload.scan_id) {
        throw permanent('input_not_found', 'no such input for this scan');
      }
      if (!(AUDITED_KINDS as readonly string[]).includes(input.kind)) {
        throw permanent('input_not_auditable', `a ${input.kind} input is not audited`);
      }
      const coverage: CoverageDocument = scan.coverage ?? {};
      const audit = coverage.data_audit ?? {};
      const done = audit.done_inputs ?? [];
      if (done.includes(input.id)) return false; // an earlier attempt finished this input

      const [shopRow] = await tx<{ payload: unknown }[]>`
        select payload from scan_inputs
         where tenant_id = ${tenantId} and scan_id = ${payload.scan_id} and kind = 'shop'
         order by seq desc limit 1`;
      const locale = parseShop(shopRow?.payload, scan.locale).primaryLocale;
      const kind = input.kind as AuditedKind;
      const result = auditBatch(kind, parseBatch(kind, input.payload), locale);
      const recorded = await recordDataItems(tx, ctx, input.id, result.items);

      let queued = 0;
      const candidates = recorded.filter((r) => ALT_RULES.has(r.ruleId));
      const room =
        candidates.length === 0
          ? 0
          : Math.min(MAX_ALT_TEXT_JOBS, await enqueueRoom(tx, tenantId, payload.site_id));
      for (const r of candidates) {
        if (queued >= room) break;
        const created = await enqueue(tx, {
          queue: 'ai.alt_text',
          payloadSchema: 'ai.alt_text@1',
          payload: {
            site_id: payload.site_id,
            finding_id: r.findingId,
            input_id: input.id,
            resource_gid: r.resource,
          },
          tenantId,
          idempotencyKey: `ai.alt_text:${r.findingId}`,
        });
        if (created.created) queued += 1;
      }

      const merged: CoverageDocument = {
        ...coverage,
        version: 1,
        data_audit: {
          done_inputs: [...done, input.id],
          resources: (audit.resources ?? 0) + result.checksRun,
          not_audited: (audit.not_audited ?? 0) + result.notAudited,
          skipped_rules: [...new Set([...(audit.skipped_rules ?? []), ...result.skippedRules])],
        },
      };
      await tx`
        update scans set coverage = ${tx.json(merged as postgres.JSONValue)}
         where tenant_id = ${tenantId} and id = ${payload.scan_id}`;
      const progress = await advance(tx, tenantId, payload.scan_id, {
        inputs: 1,
        checksRun: result.checksRun,
        checksPassed: result.checksPassed,
      });
      return progress?.complete === true;
    });
    await finalizeWhenComplete(deps.sql, ctx, complete);
  };
}
