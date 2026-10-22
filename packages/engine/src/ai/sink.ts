/**
 * Writes one `ai_calls` row per model call (PLAN §9, §19): model, tokens, cost, prompt version
 * and outcome. Never the prompt, the image or the model's answer.
 */
import type { AiCallRecord, AiCallSink } from '@rampsmith/ai';
import { uuidv7 } from '@rampsmith/queue';
import type postgres from 'postgres';
import { withTenant } from '../store.ts';

export function postgresCallSink(sql: postgres.Sql): AiCallSink {
  return {
    async record(r: AiCallRecord): Promise<void> {
      await withTenant(sql, r.tenantId, async (tx) => {
        await tx`
          insert into ai_calls
            (id, tenant_id, task, model, mode, prompt_version, input_tokens, output_tokens,
             cache_read_tokens, cache_write_tokens, thinking_tokens, cost_micro_usd,
             cost_is_estimate, batch_id, request_id, outcome, error_code, attempts, duration_ms,
             started_at)
          values
            (${uuidv7()}, ${r.tenantId}, ${r.task}, ${r.model}, ${r.mode}, ${r.promptVersion},
             ${r.usage.input}, ${r.usage.output}, ${r.usage.cacheRead},
             ${r.usage.cacheWrite5m + r.usage.cacheWrite1h}, ${r.thinkingTokens},
             ${r.costMicroUsd}, ${r.costIsEstimate}, ${r.batchId}, ${r.requestId}, ${r.outcome},
             ${r.errorCode}, ${r.attempts}, ${Math.round(r.durationMs)}, ${r.startedAt})`;
      });
    },
  };
}
