// @rampsmith/a11y-rules: the custom checks of PLAN §11.
export { checkFocusNotObscured, type FocusObscuredOptions } from './browser/focus-obscured.ts';
export { checkKeyboard, type KeyboardOptions } from './browser/keyboard.ts';
export { checkMediaAutoplay, type MediaAutoplayOptions } from './browser/media-autoplay.ts';
export type { Target } from './browser/protocol.ts';
export { checkReflow, type ReflowOptions } from './browser/reflow.ts';
export type { CheckName, CheckResult } from './browser/run.ts';
export { checkTextSpacing, type TextSpacingOptions } from './browser/text-spacing.ts';
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
export { RULES_VERSION } from './version.ts';
export {
  GuardSetupError,
  guardCheckout,
  scanContextOptions,
  type CheckoutGuard,
  type GuardKind,
  type GuardTrip,
} from './states/network-guard.ts';
export {
  changeVariant,
  openCartDrawer,
  openFirstModal,
  openMainNavigation,
  openState,
  type InteractiveState,
  type NotFoundReason,
  type StateOptions,
  type StateOutcome,
} from './states/states.ts';
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
