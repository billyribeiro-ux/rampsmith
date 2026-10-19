/** `scan.finalize@1` (ADR-035, ADR-036): ranks, closes and discloses coverage. R1 lane B builds it. */
import { notBuilt, type JobHandler } from './payload.ts';

export function scanFinalizeHandler(): JobHandler {
  return notBuilt('scan.finalize', 'scan.finalize@1');
}
