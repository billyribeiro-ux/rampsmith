/**
 * `ai.alt_text@1` (ADR-035, ADR-036, ADR-090): drafts alt text for one product image and
 * stores it as a pending fix for the merchant to approve, edit or reject. Nothing is written
 * to Shopify here, and an AI draft is never applied without approval (PLAN §13).
 *
 * Steps: read the finding and the stored store data (one tenant transaction); download the
 * image through egress; resize it and strip its metadata with `sharp`; ask `@rampsmith/ai`
 * (Haiku first, Sonnet when it flags embedded text or low confidence) inside the store's
 * monthly budget; store the draft, its diff and its snapshot (a second tenant transaction).
 * No transaction is open while the network is.
 */
import process from 'node:process';
import {
  CircuitBreaker,
  createAnthropicTransport,
  generateAltText,
  isAiError,
  type AiDeps,
  type AiTransport,
  type AltTextDraft,
  type AltTextOutcome,
} from '@rampsmith/ai';
import { JobFailure, uuidv7 } from '@rampsmith/queue';
import type postgres from 'postgres';
import { PostgresBudgetLedger } from '../ai/ledger.ts';
import { postgresCallSink } from '../ai/sink.ts';
import { findImageContext, primaryLocaleOf, type ImageContext } from '../ai/context.ts';
import { fetchImageViaEgress, MAX_IMAGE_BYTES } from '../ai/egress-fetch.ts';
import { prepareImage } from '../ai/image.ts';
import { withTenant } from '../store.ts';
import { parsePayload, requireTenant, type JobHandler } from './payload.ts';

/** The monthly AI budget of a store that has not set one: $0.50, the Free plan (ADR-214). */
export const DEFAULT_BUDGET_MICRO_USD = 500_000;

/** What the handler needs; `queues.ts` passes the engine's own dependencies. */
export interface AltTextRuntime {
  readonly sql: postgres.Sql;
  readonly egress: { readonly proxyUrl: string; readonly tokenSecret: string };
  /** Test seam: the model transport. Production builds one from `ANTHROPIC_API_KEY`. */
  readonly transport?: AiTransport;
  /** Test seam: the image download. Production goes through egress. */
  readonly fetchImage?: (url: string, scanId: string) => Promise<Uint8Array>;
  /** Shared across jobs so repeated provider failures pause the queue (PLAN §13). */
  readonly breaker?: CircuitBreaker;
  readonly defaultBudgetMicroUsd?: number;
}

const processBreaker = new CircuitBreaker();
let processTransport: AiTransport | undefined;

function transportFor(runtime: AltTextRuntime): AiTransport {
  if (runtime.transport !== undefined) return runtime.transport;
  if (processTransport !== undefined) return processTransport;
  const apiKey = process.env['ANTHROPIC_API_KEY'] ?? '';
  if (apiKey.trim() === '') {
    // Scans go on without drafts (PLAN §13); the founder input is LAUNCH.md section C, row 5.
    throw new JobFailure('permanent', {
      code: 'ai_not_configured',
      message: 'ANTHROPIC_API_KEY is not set (LAUNCH.md section C, row 5)',
    });
  }
  processTransport = createAnthropicTransport({ apiKey: apiKey.trim() });
  return processTransport;
}

interface Loaded {
  readonly image: ImageContext;
  readonly scanId: string;
  readonly primaryLocale: string;
  readonly maxCharacters: number | undefined;
  readonly budgetMicroUsd: number;
}

function integerSetting(settings: unknown, key: string): number | undefined {
  if (typeof settings !== 'object' || settings === null) return undefined;
  const value = (settings as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Reads what the draft needs, or returns `undefined` when a fix for the finding exists. */
async function load(
  runtime: AltTextRuntime,
  tenantId: string,
  payload: { site_id: string; finding_id: string; input_id: string; resource_gid: string },
): Promise<Loaded | undefined> {
  return withTenant(runtime.sql, tenantId, async (tx) => {
    const [site] = await tx<{ settings: unknown }[]>`
      select settings from sites where tenant_id = ${tenantId} and id = ${payload.site_id}`;
    if (site === undefined) {
      throw new JobFailure('permanent', { code: 'site_not_found', message: 'no such site' });
    }
    const [finding] = await tx<{ status: string }[]>`
      select status from findings
       where tenant_id = ${tenantId} and id = ${payload.finding_id} and site_id = ${payload.site_id}`;
    if (finding === undefined) {
      throw new JobFailure('permanent', { code: 'finding_not_found', message: 'no such finding' });
    }
    const existing = await tx`
      select 1 from fix_findings
       where tenant_id = ${tenantId} and finding_id = ${payload.finding_id} limit 1`;
    if (existing.length > 0 || finding.status !== 'open') return undefined;
    const [input] = await tx<{ payload: unknown; scan_id: string }[]>`
      select payload, scan_id from scan_inputs
       where tenant_id = ${tenantId} and id = ${payload.input_id} and site_id = ${payload.site_id}`;
    if (input === undefined) {
      throw new JobFailure('permanent', {
        code: 'input_not_found',
        message: 'the stored store data is gone (swept after 30 days) or not this site',
      });
    }
    const image = findImageContext(input.payload, payload.resource_gid);
    if (image === undefined) {
      throw new JobFailure('permanent', {
        code: 'image_not_found',
        message: 'the stored store data holds no such image',
      });
    }
    const [shop] = await tx<{ payload: unknown }[]>`
      select payload from scan_inputs
       where tenant_id = ${tenantId} and scan_id = ${input.scan_id} and kind = 'shop' and seq = 0`;
    return {
      image,
      scanId: input.scan_id,
      primaryLocale: primaryLocaleOf(shop?.payload),
      maxCharacters: integerSetting(site.settings, 'alt_text_max_characters'),
      budgetMicroUsd:
        integerSetting(site.settings, 'ai_budget_micro_usd') ??
        runtime.defaultBudgetMicroUsd ??
        DEFAULT_BUDGET_MICRO_USD,
    };
  });
}

/** The fix's data diff, read by the api's approve, edit and undo and by the remediation log. */
function diffOf(gid: string, before: string | null, draft: AltTextDraft, outcome: AltTextOutcome) {
  return {
    type: 'alt_text',
    resource_gid: gid,
    field: 'alt',
    before,
    after: draft.alt,
    language: draft.language,
    contains_text: draft.containsText,
    escalated: outcome.escalated,
  };
}

async function store(
  runtime: AltTextRuntime,
  tenantId: string,
  payload: { site_id: string; finding_id: string; resource_gid: string },
  before: string | null,
  draft: AltTextDraft,
  outcome: AltTextOutcome,
): Promise<void> {
  const diff = diffOf(payload.resource_gid, before, draft, outcome);
  await withTenant(runtime.sql, tenantId, async (tx) => {
    // Two drafts of one finding (a retry racing a rescan) serialise on the finding row.
    const locked = await tx`
      select id from findings where tenant_id = ${tenantId} and id = ${payload.finding_id}
       for update`;
    if (locked.length === 0) return;
    const existing = await tx`
      select 1 from fix_findings
       where tenant_id = ${tenantId} and finding_id = ${payload.finding_id} limit 1`;
    if (existing.length > 0) return;
    const fixId = uuidv7();
    await tx`
      insert into fixes (id, tenant_id, site_id, kind, channel, status, origin, model,
                         prompt_version, confidence, diff)
      values (${fixId}, ${tenantId}, ${payload.site_id}, 'data', 'admin_api', 'proposed', 'ai',
              ${outcome.model}, ${outcome.promptVersion}, ${draft.confidence},
              ${tx.json(diff)})`;
    await tx`
      insert into fix_findings (fix_id, finding_id, tenant_id)
      values (${fixId}, ${payload.finding_id}, ${tenantId})`;
    await tx`
      insert into data_fix_snapshots (fix_id, tenant_id, resource_gid, field, before_value,
                                      after_value)
      values (${fixId}, ${tenantId}, ${payload.resource_gid}, 'alt',
              ${before === null ? tx`'null'::jsonb` : tx.json(before)}, ${tx.json(draft.alt)})`;
  });
}

function aiFailure(error: unknown): JobFailure {
  if (error instanceof JobFailure) return error;
  if (isAiError(error)) {
    return new JobFailure(error.retryable ? 'retryable' : 'permanent', {
      code: error.code,
      message: error.message,
    });
  }
  return new JobFailure('retryable', { code: 'alt_text_failed', message: 'drafting failed' });
}

export function altTextHandler(runtime: AltTextRuntime): JobHandler {
  return async (job) => {
    const payload = parsePayload(job, 'ai.alt_text@1');
    const tenantId = requireTenant(job);
    try {
      const loaded = await load(runtime, tenantId, payload);
      if (loaded === undefined) return;
      const transport = transportFor(runtime);
      const bytes = await (
        runtime.fetchImage ??
        ((url, scan) =>
          fetchImageViaEgress(url, {
            proxyUrl: runtime.egress.proxyUrl,
            tokenSecret: runtime.egress.tokenSecret,
            scanId: scan,
            maxBytes: MAX_IMAGE_BYTES,
          }))
      )(loaded.image.url, loaded.scanId);
      const image = await prepareImage(bytes);
      const deps: AiDeps = {
        transport,
        ledger: new PostgresBudgetLedger(runtime.sql, tenantId),
        breaker: runtime.breaker ?? processBreaker,
        sink: postgresCallSink(runtime.sql),
        budgetLimit: () => Promise.resolve(loaded.budgetMicroUsd),
      };
      const outcome = await generateAltText(
        deps,
        {
          image,
          productTitle: loaded.image.productTitle,
          productType: loaded.image.productType,
          primaryLocale: loaded.primaryLocale,
          ...(loaded.maxCharacters === undefined ? {} : { maxCharacters: loaded.maxCharacters }),
        },
        // A synchronous call, one per image job; the Batch API is a later bulk path (ADR-090).
        { tenantId, interactive: true },
      );
      // A draft that failed the PLAN §13 checks never reaches the approval queue; the finding
      // stays open for the merchant to write the text by hand.
      if (outcome.result.status !== 'draft') return;
      await store(
        runtime,
        tenantId,
        payload,
        loaded.image.currentAlt,
        outcome.result.value,
        outcome,
      );
    } catch (error) {
      throw aiFailure(error);
    }
  };
}
