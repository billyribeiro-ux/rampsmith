// @rampsmith/corpus-tools: the theme test corpus's checks and the runner contract's scoring
// (PLAN §23, corpus/CONTRACT.md).
export {
  BUILT_RECIPES,
  CATEGORIES,
  RECIPES,
  REFUSAL_CODES,
  TOP_SIX_CATEGORIES,
  type Category,
  type Engine,
  type ExpectedFix,
  type FixChannel,
  type GoldenFile,
  type GoldenFinding,
  type Impact,
  type MappingExpectation,
  type Occurrence,
  type Outcome,
  type RecipeName,
  type RefusalCode,
  type Span,
  type SpanKind,
} from './golden.ts';
export {
  FIX_RATE_GATE,
  MAPPING_ACCURACY_GATE,
  MAPPING_THRESHOLD,
  buildReport,
  findRegressions,
  scoreFixes,
  scoreMapping,
  scored,
  spansEqual,
  type CorpusReport,
  type FixRecord,
  type FixScore,
  type FixVerdict,
  type MappingRecord,
  type MappingScore,
  type MappingVerdict,
  type PageScan,
  type Regression,
  type ScoredFinding,
} from './contract/metrics.ts';
export {
  comparePage,
  summarizeCounts,
  type AxeNode,
  type PageComparison,
  type ResolvedOccurrence,
} from './browser/compare.ts';
export {
  A11Y_RULES_COMMIT,
  AXE_VERSION,
  CUSTOM_RULES,
  SCANNER_TAGS,
  ruleCatalog,
  type KnownRule,
} from './rules.ts';
export { validate, type SchemaName } from './schema.ts';
export { CORPUS_ROOT } from './paths.ts';
