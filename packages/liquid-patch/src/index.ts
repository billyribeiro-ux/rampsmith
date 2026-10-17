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
export { buildPatch, type FilePatch, type PatchError, type PatchResult } from './patch.ts';
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
