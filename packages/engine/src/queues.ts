/**
 * Every queue the engine serves, with its handler (PLAN §10, ADR-035, ADR-036). `ctl` serves
 * the queues that need a Shopify token; the engine never does. An R1 lane builds a queue by
 * replacing its stub in `jobs/` and, when the handler needs dependencies, its line below.
 * Every queue is built as of R1. `free_scan.run` serves the marketing site's free scanner for no
 * tenant (ADR-267).
 */
import { freeScanHandler } from './free-scan.ts';
import { altTextHandler } from './jobs/alt-text.ts';
import { auditDataHandler } from './jobs/audit-data.ts';
import type { EmailRuntime } from './email/runtime.ts';
import { emailSendHandler } from './jobs/email-send.ts';
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
  'email.send',
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

/** The queues an engine whose Chromium has `sandbox` serves. */
export function queuesFor(sandbox: SandboxMode): readonly EngineQueue[] {
  return sandbox === 'on'
    ? ENGINE_QUEUES
    : ENGINE_QUEUES.filter((queue) => !SANDBOX_ONLY_QUEUES.includes(queue));
}

/** Each engine queue's handler. */
export function engineHandlers(
  deps: EngineDeps,
  /** Absent: `email.send` jobs fail retryably naming the missing settings (ADR-273). */
  email?: EmailRuntime,
): Record<EngineQueue, JobHandler> {
  return {
    'scan.plan': scanPlanHandler(deps),
    'scan.page': scanPageHandler(deps),
    'scan.finalize': scanFinalizeHandler(deps),
    'audit.data': auditDataHandler(deps),
    'ai.alt_text': altTextHandler({ sql: deps.sql, egress: deps.egress }),
    'verify.scan': verifyScanHandler(deps),
    'email.send': emailSendHandler({ sql: deps.sql, email }),
    'free_scan.run': freeScanHandler(deps),
  };
}
