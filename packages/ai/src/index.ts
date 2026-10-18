// Public entry point of @rampsmith/ai (PLAN §13; ADR-211). The engine's ai worker imports
// from here only.
export {
  ALT_TEXT_LONG_EDGE,
  costMicroUsd,
  estimateTextTokens,
  imageTokens,
  planImageResize,
  promptTokens,
  worstCaseCostMicroUsd,
  type CallMode,
  type ResizePlan,
  type TokenUsage,
} from './cost.ts';
export { AiError, isAiError, type AiErrorCode } from './errors.ts';
export {
  MODELS,
  acceptsThinking,
  isModelId,
  priceTier,
  type Effort,
  type ModelId,
  type ModelSpec,
  type PriceTier,
  type ThinkingMode,
} from './models.ts';
export { PROMPT_IDS, loadPrompts, prompt, type Prompt, type PromptId } from './prompts.ts';
export {
  classifyError,
  createAnthropicTransport,
  parseRetryAfter,
  type AiTransport,
  type AnthropicTransportOptions,
  type BatchItemResult,
  type BatchRequest,
  type BatchStatus,
  type CallOptions,
  type TransportResponse,
} from './transport.ts';
export {
  detectInstructionLikeText,
  encodeDataBlock,
  sanitizeUntrustedText,
  scrubPersonalData,
  stripQueryAndFragment,
  type DataTag,
} from './untrusted.ts';
export {
  InMemoryBudgetLedger,
  budgetPeriod,
  type BudgetLedger,
  type Reservation,
  type ReserveRequest,
  type ReserveResult,
} from './budget.ts';
export {
  runCall,
  type AiCallOutcome,
  type AiCallRecord,
  type AiCallSink,
  type AiDeps,
  type CallContext,
  type CallOutcome,
  type PreparedCall,
  type TaskResult,
} from './calls.ts';
export { bannedClaims, introducedClaims, type ClaimMatch } from './claims.ts';
export {
  MAX_IMAGE_BASE64_BYTES,
  validateImage,
  type ImageInput,
  type ImageMediaType,
} from './images.ts';
export {
  CircuitBreaker,
  DEFAULT_RETRY_POLICY,
  type BreakerOptions,
  type BreakerState,
  type RetryPolicy,
} from './resilience.ts';
export { ROUTES, TASKS, routeFor, type Route, type Task } from './routing.ts';
export {
  ALT_TEXT_DEFAULT_MAX,
  ALT_TEXT_MAX_LIMIT,
  ALT_TEXT_MIN_LIMIT,
  ESCALATION_CONFIDENCE,
  checkAltText,
  generateAltText,
  needsEscalation,
  prepareAltText,
  type AltTextDraft,
  type AltTextInput,
  type AltTextOutcome,
} from './tasks/alt-text.ts';
export {
  CUSTOM_ID,
  MAX_BATCH_BYTES,
  MAX_BATCH_REQUESTS,
  chunkBatchItems,
  collectBatch,
  pollBatch,
  retireBatch,
  submitBatch,
  type BatchItem,
  type BatchItemOutcome,
  type BatchTicket,
  type SubmitResult,
} from './batch.ts';
