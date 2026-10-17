// @rampsmith/a11y-rules: the custom checks of PLAN §11.
export { DEFAULT_PARSE_LIMITS, type ParseFailure, type ParseLimits } from './data/html.ts';
export { supportedLinkTextLanguages } from './data/locale.ts';
export { auditMediaAlt, type MediaAltInput } from './data/media-alt.ts';
export { auditMenu, type MenuInput, type MenuItemInput } from './data/menu.ts';
export {
  auditRichText,
  type RichTextAudit,
  type RichTextInput,
  type RichTextOptions,
  type SkippedRule,
} from './data/rich-text.ts';
export { RULES, type RuleMeta } from './rules.ts';
export {
  IMPACTS,
  PAGE_STATES,
  type DataFinding,
  type DataLocation,
  type FindingBase,
  type FindingData,
  type Impact,
  type Outcome,
  type PageFinding,
  type PageState,
  type RuleId,
  type WcagCriterion,
} from './types.ts';
