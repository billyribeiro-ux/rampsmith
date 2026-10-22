/**
 * Every queue the engine serves, with its handler (PLAN §10, ADR-035, ADR-036). `ctl` serves
 * the queues that need a Shopify token; the engine never does. An R1 lane builds a queue by
 * replacing its stub in `jobs/` and, when the handler needs dependencies, its line below.
 */
import { altTextHandler } from './jobs/alt-text.ts';
import { auditDataHandler } from './jobs/audit-data.ts';
import { scanFinalizeHandler } from './jobs/finalize.ts';
import type { JobHandler } from './jobs/payload.ts';
import { scanPlanHandler } from './jobs/plan.ts';
import { verifyScanHandler } from './jobs/verify.ts';
import { scanPageHandler, type EngineDeps } from './worker.ts';

export const ENGINE_QUEUES = [
  'scan.plan',
  'scan.page',
  'scan.finalize',
  'audit.data',
  'ai.alt_text',
  'verify.scan',
] as const;
export type EngineQueue = (typeof ENGINE_QUEUES)[number];

/** The handlers of queues no R1 lane has built yet. */
export function stubHandlers(): Record<'ai.alt_text', JobHandler> {
  return { 'ai.alt_text': altTextHandler() };
}

/** Each engine queue's handler. */
export function engineHandlers(deps: EngineDeps): Record<EngineQueue, JobHandler> {
  return {
    ...stubHandlers(),
    'scan.plan': scanPlanHandler(deps),
    'scan.page': scanPageHandler(deps),
    'scan.finalize': scanFinalizeHandler(deps),
    'audit.data': auditDataHandler(deps),
    'verify.scan': verifyScanHandler(deps),
  };
}
