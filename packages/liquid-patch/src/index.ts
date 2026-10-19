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
export { buildPatch, type FilePatch, type PatchError, type PatchResult } from './patch.ts';
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
