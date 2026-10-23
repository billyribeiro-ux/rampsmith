export {
  contrastCandidates,
  LIGHTNESS_STEP,
  smallestChange,
  strongerRatio,
  type CandidateId,
  type CandidateRequest,
  type ColorCandidate,
} from './color/candidates.ts';
export {
  clampChroma,
  contrastRatio,
  formatColor,
  fromOklab,
  fromOklch,
  inSrgbGamut,
  isLargeText,
  parseColor,
  relativeLuminance,
  toOklab,
  toOklch,
  type ColorFormat,
  type Oklab,
  type Oklch,
  type ParsedColor,
  type Rgb,
} from './color/color.ts';
export {
  planBatch,
  type BatchFinding,
  type BatchNode,
  type BatchOptions,
  type BatchPlan,
  type BatchStep,
  type PlannedFix,
  type SkipCode,
  type Skipped,
  type StepFile,
} from './batch.ts';
export { unifiedDiff } from './diff.ts';
export {
  applyEdits,
  fileKind,
  mapOffset,
  spliceEdits,
  type ApplyResult,
  type Edit,
  type EditError,
  type EditErrorCode,
} from './edits.ts';
export {
  countUnparsedLiquid,
  parseLiquid,
  parseThemeFile,
  type LineColumn,
  type ParsedFile,
  type ParsedFileResult,
  type ParseFailure,
  type ParseResult,
} from './parse.ts';
export {
  elementAt,
  elementName,
  firstElement,
  type ElementNode,
  type LocatedElement,
} from './html.ts';
export {
  locateJsonValue,
  parseJsonTree,
  pointerSegments,
  toPointer,
  type JsonValue,
} from './json.ts';
export { Mapper } from './map/map.ts';
export {
  CONFIDENCE_THRESHOLD,
  type DataSpan,
  type ElementSpan,
  type FindingToMap,
  type MapCandidate,
  type MapEvidence,
  type MapOutcome,
  type MappedJsonValue,
  type MappedSpan,
  type RenderedElement,
  type RenderedNode,
  type RenderedResource,
  type Sibling,
} from './map/types.ts';
export { buildPatch, type FilePatch, type PatchError, type PatchResult } from './patch.ts';
export {
  hasRecipe,
  planFix,
  type ContrastEvidence,
  type FixParams,
  type FixRequest,
} from './plan.ts';
export {
  chooseCandidate,
  contrast,
  type ColorSpan,
  type ContrastCandidate,
  type ContrastOutcome,
  type ContrastParams,
  type CssDeclarationSpan,
  type JsonValueSpan,
} from './recipes/contrast.ts';
export { documentLanguage, LANG_VALUE } from './recipes/document-language.ts';
export { emptyButton, type ButtonParams } from './recipes/empty-button.ts';
export { emptyLink, type LabelParams } from './recipes/empty-link.ts';
export { formLabel, type FormLabelParams } from './recipes/form-label.ts';
export { imageAlt, type ImageAltParams } from './recipes/image-alt.ts';
export { SKIP_LINK_LABEL, skipLink, type SkipLinkParams } from './recipes/skip-link.ts';
export {
  DEFAULT_VISUALLY_HIDDEN_CLASS,
  type Recipe,
  type RecipeId,
  type RecipeOutcome,
  type RecipeTarget,
  type RefusalCode,
} from './recipes/types.ts';
export {
  OFFLINE_CHECKS,
  themeOffenses,
  validateNoNewOffenses,
  type ThemeFiles,
  type ThemeOffense,
  type ValidateOptions,
  type ValidationResult,
} from './theme-check.ts';
export {
  localeEdits,
  translationKeyProblem,
  translationOutput,
  translationTextProblem,
  type LocaleEditsResult,
  type LocaleError,
  type LocaleErrorCode,
  type LocaleFile,
  type LocaleText,
  type TranslationRequirement,
  type Untranslated,
} from './translations.ts';
