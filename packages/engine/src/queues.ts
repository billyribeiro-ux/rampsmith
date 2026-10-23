/**
 * Every queue the engine serves, with its handler (PLAN §10, ADR-035, ADR-036). `ctl` serves
 * the queues that need a Shopify token; the engine never does. An R1 lane builds a queue by
 * replacing its stub in `jobs/` and, when the handler needs dependencies, its line below.
 * Every queue is built as of R1. `free_scan.run` serves the marketing site's free scanner for no
 * tenant (ADR-267).
 */
import { FREE_SCAN_BUDGET_MS, freeScanHandler } from './free-scan.ts';
import { altTextHandler } from './jobs/alt-text.ts';
import { auditDataHandler } from './jobs/audit-data.ts';
import { scanFinalizeHandler } from './jobs/finalize.ts';
import type { JobHandler } from './jobs/payload.ts';
import { scanPlanHandler } from './jobs/plan.ts';
import { verifyScanHandler } from './jobs/verify.ts';
import type { SandboxMode } from './browser.ts';
import { scanPageHandler, type EngineDeps } from './worker.ts';

export const ENGINE_QUEUES = [
  'scan.plan',
  'scan.page',
  'scan.finalize',
  'audit.data',
  'ai.alt_text',
  'verify.scan',
  'free_scan.run',
] as const;
export type EngineQueue = (typeof ENGINE_QUEUES)[number];

/**
 * The queues whose pages come from anyone on the internet, not from a merchant's own store.
 * They run only in a Chromium that has its own sandbox (audit H1, ADR-280): an engine whose host
 * refused the sandbox (ADR-265) holds the database login, the egress secret, the Claude key and
 * the evidence keys in a process one renderer exploit from a stranger's page away, so it never
 * serves them.
 */
const SANDBOX_ONLY_QUEUES: readonly EngineQueue[] = ['free_scan.run'];

/**
 * The longest one attempt of a queue may run (audit M2). Each is above what the handler bounds
 * itself to (a page scan's own deadline, the free scan's budget), so the handler's own failure
 * handling runs first and this is the backstop for a handler that never returns.
 */
export function deadlineMs(queue: EngineQueue): number {
  switch (queue) {
    case 'free_scan.run':
      return FREE_SCAN_BUDGET_MS + 30_000;
    case 'scan.page':
      return 150_000;
    default:
      return 600_000;
  }
}

/** The queues an engine whose Chromium has `sandbox` serves. */
export function queuesFor(sandbox: SandboxMode): readonly EngineQueue[] {
  return sandbox === 'on'
    ? ENGINE_QUEUES
    : ENGINE_QUEUES.filter((queue) => !SANDBOX_ONLY_QUEUES.includes(queue));
}

/** Each engine queue's handler. */
export function engineHandlers(deps: EngineDeps): Record<EngineQueue, JobHandler> {
  return {
    'scan.plan': scanPlanHandler(deps),
    'scan.page': scanPageHandler(deps),
    'scan.finalize': scanFinalizeHandler(deps),
    'audit.data': auditDataHandler(deps),
    'ai.alt_text': altTextHandler({ sql: deps.sql, egress: deps.egress }),
    'verify.scan': verifyScanHandler(deps),
    'free_scan.run': freeScanHandler(deps),
  };
}
