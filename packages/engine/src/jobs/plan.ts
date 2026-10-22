/** `scan.plan@1` (ADR-035, ADR-036): chooses the pages to scan. R1 lane B builds it. */
import { notBuilt, type JobHandler } from './payload.ts';

export function scanPlanHandler(): JobHandler {
  return notBuilt('scan.plan', 'scan.plan@1');
}
