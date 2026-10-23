/**
 * Every queue the engine serves, with its handler (PLAN §10, ADR-035, ADR-036). `ctl` serves
 * the queues that need a Shopify token; the engine never does. An R1 lane builds a queue by
 * replacing its stub in `jobs/` and, when the handler needs dependencies, its line below.
 * Every queue is built as of R1 (`email.send` is the mailer's, ADR-276). `free_scan.run` serves the marketing site's free scanner for no
 * tenant (ADR-267).
 */
import { FREE_SCAN_BUDGET_MS, freeScanHandler } from './free-scan.ts';
import { altTextHandler } from './jobs/alt-text.ts';
import { auditDataHandler } from './jobs/audit-data.ts';
import { codeFixPatchHandler } from './jobs/code-fix.ts';
import { scanFinalizeHandler } from './jobs/finalize.ts';
import type { JobHandler } from './jobs/payload.ts';
import { scanPlanHandler } from './jobs/plan.ts';
import { endingScanOnFailure } from './jobs/scan-cleanup.ts';
import { verifyScanHandler } from './jobs/verify.ts';
import type { SandboxMode } from './browser.ts';
import { scanPageHandler, type EngineDeps } from './worker.ts';

export const ENGINE_QUEUES = [
  'scan.plan',
  'scan.page',
  'scan.finalize',
  'audit.data',
  'ai.alt_text',
  'code_fix.patch',
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
  if (queue === 'free_scan.run') return FREE_SCAN_BUDGET_MS + 30_000;
  return queue === 'scan.page' ? 150_000 : 600_000;
}

/** The queues an engine whose Chromium has `sandbox` serves. */
export function queuesFor(sandbox: SandboxMode): readonly EngineQueue[] {
  return sandbox === 'on'
    ? ENGINE_QUEUES
    : ENGINE_QUEUES.filter((queue) => !SANDBOX_ONLY_QUEUES.includes(queue));
}

/**
 * Each engine queue's handler. `email.send` is not here: the mailer serves it (`mailer.ts`,
 * ADR-276), because the process that runs Chromium on strangers' pages must not hold the Amazon
 * SES keys.
 */
export function engineHandlers(deps: EngineDeps): Record<EngineQueue, JobHandler> {
  // A scan that cannot finish ends with its sealed password copy cleared (audit M3, ADR-283).
  const ending = (handler: JobHandler, onLastAttempt = true): JobHandler =>
    endingScanOnFailure(deps.sql, handler, { onLastAttempt });
  return {
    'scan.plan': ending(scanPlanHandler(deps)),
    'scan.page': ending(scanPageHandler(deps), false),
    'scan.finalize': ending(scanFinalizeHandler(deps)),
    'audit.data': ending(auditDataHandler(deps)),
    'ai.alt_text': altTextHandler({ sql: deps.sql, egress: deps.egress }),
    'code_fix.patch': codeFixPatchHandler({ sql: deps.sql }),
    'verify.scan': ending(verifyScanHandler(deps)),
    'free_scan.run': freeScanHandler(deps),
  };
}
