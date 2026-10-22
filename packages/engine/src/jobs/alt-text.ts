/** `ai.alt_text@1` (ADR-035, ADR-036): drafts alt text for approval. R1 lane C builds it. */
import { notBuilt, type JobHandler } from './payload.ts';

export function altTextHandler(): JobHandler {
  return notBuilt('ai.alt_text', 'ai.alt_text@1');
}
