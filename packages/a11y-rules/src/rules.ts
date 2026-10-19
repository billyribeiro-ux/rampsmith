// The rule catalog: one entry per custom check, the single source of each rule's criteria,
// impact and kind. Impacts follow the closest axe-core rule where one exists (ADR-112).
import type { FindingBase, Impact, Outcome, RuleId, WcagCriterion } from './types.ts';

export interface RuleMeta {
  readonly id: RuleId;
  /** Which audit runs the rule (PLAN §11): `data` reads store content, `browser` a live page. */
  readonly audit: 'data' | 'browser';
  readonly criteria: readonly WcagCriterion[];
  readonly impact: Impact;
  readonly bestPractice: boolean;
  /** One plain-language sentence for the merchant. */
  readonly summary: string;
}

const rule = (
  id: RuleId,
  audit: RuleMeta['audit'],
  criteria: readonly WcagCriterion[],
  impact: Impact,
  summary: string,
  bestPractice = false,
): RuleMeta => ({ id, audit, criteria, impact, bestPractice, summary });

export const RULES: Readonly<Record<RuleId, RuleMeta>> = {
  'rs-media-alt-empty': rule(
    'rs-media-alt-empty',
    'data',
    ['1.1.1'],
    'serious',
    'A product image has no alt text, so screen-reader users miss what it shows.',
  ),
  'rs-media-alt-filename': rule(
    'rs-media-alt-filename',
    'data',
    ['1.1.1'],
    'serious',
    'A product image uses a file name as its alt text instead of describing the image.',
  ),
  'rs-rich-text-heading-skip': rule(
    'rs-rich-text-heading-skip',
    'data',
    ['1.3.1'],
    'moderate',
    'A heading skips a level, which breaks the outline screen-reader users navigate by.',
    true,
  ),
  'rs-rich-text-link-empty': rule(
    'rs-rich-text-link-empty',
    'data',
    ['2.4.4', '4.1.2'],
    'serious',
    'A link has no text or accessible name, so its purpose cannot be announced.',
  ),
  'rs-rich-text-link-vague': rule(
    'rs-rich-text-link-vague',
    'data',
    ['2.4.4'],
    'moderate',
    'A link says something like "click here" and does not say where it goes.',
  ),
  'rs-rich-text-img-alt-missing': rule(
    'rs-rich-text-img-alt-missing',
    'data',
    ['1.1.1'],
    'critical',
    'An image in the text has no alt attribute.',
  ),
  'rs-rich-text-img-alt-filename': rule(
    'rs-rich-text-img-alt-filename',
    'data',
    ['1.1.1'],
    'serious',
    'An image in the text uses a file name as its alt text.',
  ),
  'rs-rich-text-table-no-headers': rule(
    'rs-rich-text-table-no-headers',
    'data',
    ['1.3.1'],
    'serious',
    'A data table has no header cells, so its rows and columns cannot be told apart by ear.',
  ),
  'rs-rich-text-color-only': rule(
    'rs-rich-text-color-only',
    'data',
    ['1.4.1'],
    'moderate',
    'Some text is set apart from the words around it by colour alone.',
  ),
  'rs-menu-item-label-empty': rule(
    'rs-menu-item-label-empty',
    'data',
    ['2.4.4', '4.1.2'],
    'serious',
    'A menu item has no label, so its link has no accessible name.',
  ),
  'rs-menu-item-label-duplicate': rule(
    'rs-menu-item-label-duplicate',
    'data',
    ['2.4.4'],
    'moderate',
    'Two items in the same menu level share a label, so they cannot be told apart.',
  ),
  'rs-keyboard-trap': rule(
    'rs-keyboard-trap',
    'browser',
    ['2.1.2'],
    'critical',
    'Keyboard focus gets stuck in part of the page and cannot move on with Tab or Escape.',
  ),
  'rs-focus-indicator-missing': rule(
    'rs-focus-indicator-missing',
    'browser',
    ['2.4.7'],
    'serious',
    'An element shows no visible change when it receives keyboard focus.',
  ),
  'rs-focus-stop-hidden': rule(
    'rs-focus-stop-hidden',
    'browser',
    ['2.4.7'],
    'serious',
    'Keyboard focus lands on an element that is off screen or invisible.',
  ),
  'rs-focus-obscured': rule(
    'rs-focus-obscured',
    'browser',
    ['2.4.11'],
    'serious',
    'A focused element is completely hidden behind a sticky header, banner or drawer.',
  ),
  'rs-reflow-horizontal-scroll': rule(
    'rs-reflow-horizontal-scroll',
    'browser',
    ['1.4.10'],
    'serious',
    'At 320 CSS pixels wide the page needs horizontal scrolling to read.',
  ),
  'rs-text-spacing-clipped': rule(
    'rs-text-spacing-clipped',
    'browser',
    ['1.4.12'],
    'serious',
    'Text is cut off when a reader increases line, letter, word or paragraph spacing.',
  ),
  'rs-text-spacing-overlap': rule(
    'rs-text-spacing-overlap',
    'browser',
    ['1.4.12'],
    'serious',
    'Text spills over other content when a reader increases text spacing.',
  ),
  'rs-media-autoplay-audio': rule(
    'rs-media-autoplay-audio',
    'browser',
    ['1.4.2'],
    'moderate',
    'Audio plays automatically for more than 3 seconds with no way to pause or mute it.',
  ),
};

/** The catalog fields every finding of `id` carries, with the outcome the check decided. */
export function findingBase(id: RuleId, outcome: Outcome): FindingBase {
  const meta = RULES[id];
  return {
    ruleId: id,
    criteria: meta.criteria,
    impact: meta.impact,
    outcome,
    bestPractice: meta.bestPractice,
  };
}
