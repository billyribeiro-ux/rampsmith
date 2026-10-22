/** `verify.scan@1` (ADR-035, ADR-036): rescans after a fix. R1 lane B builds it. */
import { notBuilt, type JobHandler } from './payload.ts';

export function verifyScanHandler(): JobHandler {
  return notBuilt('verify.scan', 'verify.scan@1');
}
