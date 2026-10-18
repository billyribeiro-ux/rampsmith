// Sections every report shares: the limits of automated testing and the coverage disclosure
// (PLAN §3: "Every report states that automated checks find only part of all issues, citing
// the axe-core figure"; PLAN §11 "Coverage disclosure").
import type { Block } from './blocks.ts';
import type { Coverage } from './coverage.ts';
import type { MessageKey, Translator } from './i18n.ts';
import { criterionNameKey, type SuccessCriterion } from './wcag.ts';

function criterionLabel(t: Translator, c: SuccessCriterion): string {
  return t.text('coverage_criterion', {
    id: c.id,
    name: t.text(criterionNameKey(c.id) as MessageKey),
    level: c.level,
  });
}

export function automationLimitBlock(t: Translator): Block {
  return { kind: 'paragraph', content: [t.text('automation_limit')] };
}

/**
 * The three groups of criteria under h3 headings, then the review queue and the ruleset.
 * `heading` adds the section's own h2 first.
 */
export function coverageBlocks(t: Translator, coverage: Coverage, heading: boolean): Block[] {
  const blocks: Block[] = [];
  if (heading) {
    blocks.push({ kind: 'heading', level: 2, content: [t.text('coverage_heading')] });
  }
  blocks.push({ kind: 'paragraph', content: [t.text('coverage_intro')] });
  const groups: [MessageKey, readonly SuccessCriterion[]][] = [
    ['coverage_automated_heading', coverage.automated],
    ['coverage_partial_heading', coverage.partial],
    ['coverage_manual_heading', coverage.manual],
  ];
  for (const [key, criteria] of groups) {
    blocks.push({ kind: 'heading', level: 3, content: [t.text(key, { count: criteria.length })] });
    blocks.push(
      criteria.length === 0
        ? { kind: 'paragraph', content: [t.text('coverage_none')] }
        : { kind: 'list', items: criteria.map((c) => [criterionLabel(t, c)]) },
    );
  }
  blocks.push({
    kind: 'paragraph',
    content: [
      coverage.reviewQueue === undefined
        ? t.text('coverage_review_queue_empty')
        : t.text('coverage_review_queue', { count: coverage.reviewQueue }),
    ],
  });
  blocks.push({
    kind: 'paragraph',
    meta: true,
    content: [t.text('coverage_ruleset', { ruleset: coverage.rulesetVersion })],
  });
  return blocks;
}
