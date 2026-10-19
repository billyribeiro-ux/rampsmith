// Shared vocabulary of the custom checks. Spellings match crates/domain (Impact, PageState) and
// the `findings` table of PLAN §9; test/spellings.test.ts reads the Rust source to prove it.

/** Severity, spelled as axe-core's `impact` and the domain's `Impact` (crates/domain/src/impact.rs). */
export const IMPACTS = ['minor', 'moderate', 'serious', 'critical'] as const;
export type Impact = (typeof IMPACTS)[number];

/** The interactive state a page was in when checked (PLAN §5 R1; crates/domain/src/enums.rs). */
export const PAGE_STATES = [
  'default',
  'nav_open',
  'cart_drawer',
  'variant_changed',
  'modal',
] as const;
export type PageState = (typeof PAGE_STATES)[number];

/**
 * A WCAG 2.2 success criterion number, as stored in `findings.criteria` (PLAN §9).
 * Normative text: https://www.w3.org/TR/WCAG22/
 */
export type WcagCriterion =
  | '1.1.1'
  | '1.3.1'
  | '1.4.1'
  | '1.4.2'
  | '1.4.10'
  | '1.4.12'
  | '2.1.2'
  | '2.4.4'
  | '2.4.7'
  | '2.4.11'
  | '4.1.2';

/**
 * `violation`: the check is certain the criterion fails here. `incomplete`: the check found a
 * likely failure it cannot confirm; it goes to the review queue, like axe-core's "incomplete"
 * results (PLAN §11, coverage disclosure), and is never counted as a failure.
 */
export type Outcome = 'violation' | 'incomplete';

/** Fields every finding carries, copied from the rule catalog (src/rules.ts). */
export interface FindingBase {
  readonly ruleId: RuleId;
  readonly criteria: readonly WcagCriterion[];
  readonly impact: Impact;
  readonly outcome: Outcome;
  /**
   * True when the rule reports a best practice related to the criteria rather than a failure
   * of them. Stored separately and never counted as a WCAG failure (PLAN §11, step 4).
   */
  readonly bestPractice: boolean;
}

/**
 * Where a data finding sits, precise enough for a data fix (PLAN §12): `start` and `end` are
 * UTF-16 code-unit offsets into the field's string value, half-open, so
 * `value.slice(start, end)` is the offending element or text.
 */
export interface DataLocation {
  /** The resource that owns the field, such as a Shopify GID. Passed through unchanged. */
  readonly resource: string;
  /** The field holding the value, such as `descriptionHtml`, `body`, `alt` or `title`. */
  readonly field: string;
  readonly start: number;
  readonly end: number;
}

/** Rule-specific facts that help the merchant or a fix recipe; never personal data. */
export type FindingData = Readonly<Record<string, string | number | boolean>>;

/** A finding from the data audit (PLAN §11, "Data audit"). */
export interface DataFinding extends FindingBase {
  readonly location: DataLocation;
  readonly data?: FindingData;
}

/**
 * A finding from a browser check. `target` uses axe-core's format: one CSS selector per
 * shadow-root boundary, the last one naming the element.
 */
export interface PageFinding extends FindingBase {
  readonly target: readonly string[];
  readonly data?: FindingData;
}

/** Stable rule identifiers. They are stored in `findings.rule_id`; never rename one. */
export type RuleId =
  | 'rs-media-alt-empty'
  | 'rs-media-alt-filename'
  | 'rs-rich-text-heading-skip'
  | 'rs-rich-text-link-empty'
  | 'rs-rich-text-link-vague'
  | 'rs-rich-text-img-alt-missing'
  | 'rs-rich-text-img-alt-filename'
  | 'rs-rich-text-table-no-headers'
  | 'rs-rich-text-color-only'
  | 'rs-menu-item-label-empty'
  | 'rs-menu-item-label-duplicate'
  | 'rs-keyboard-trap'
  | 'rs-focus-indicator-missing'
  | 'rs-focus-stop-hidden'
  | 'rs-focus-obscured'
  | 'rs-reflow-horizontal-scroll'
  | 'rs-text-spacing-clipped'
  | 'rs-text-spacing-overlap'
  | 'rs-media-autoplay-audio';
