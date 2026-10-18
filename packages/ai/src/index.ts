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
