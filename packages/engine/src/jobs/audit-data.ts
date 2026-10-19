/** `audit.data@1` (ADR-035, ADR-036): audits stored store data. R1 lane B builds it. */
import { notBuilt, type JobHandler } from './payload.ts';

export function auditDataHandler(): JobHandler {
  return notBuilt('audit.data', 'audit.data@1');
}
