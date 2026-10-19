/**
 * Banned claims (PLAN §3). The product, its listing, emails and site never state or imply
 * that a store is compliant, certified, or protected from lawsuits.
 *
 * Each rule says what to write instead, taken from the "Use instead" column of the claims
 * policy, so a failing build also tells the author how to fix the copy.
 */

const RULE_IDS = [
  'compliance',
  'lawsuit-proof',
  'legal-protection',
  'guarantee',
  'certified',
  'absolute-accessibility',
] as const;

export type RuleId = (typeof RULE_IDS)[number];

export interface Rule {
  readonly id: RuleId;
  /** Matched case-insensitively; must use the `g` flag so every match on a line is found. */
  readonly pattern: RegExp;
  readonly message: string;
}

export const RULES: readonly Rule[] = [
  {
    id: 'compliance',
    pattern: /\b(?:complian(?:t|ce|tly)|conform(?:s|ant|ance)\b)/giu,
    message:
      'Compliance claims are banned. Write "Passes N of M automated WCAG 2.2 AA checks" instead.',
  },
  {
    id: 'lawsuit-proof',
    pattern: /\b(?:lawsuit|litigation|suit|sue|legal)[\s-]*(?:proof|free|safe)\b/giu,
    message: 'Lawsuit-proof claims are banned. Describe the dated remediation record instead.',
  },
  {
    id: 'legal-protection',
    pattern:
      /\b(?:protect(?:s|ed|ion|ing)?\s+(?:you\s+|your\s+(?:store|business|shop|site)\s+)?(?:from|against)\s+(?:ada\s+)?(?:lawsuits?|litigation|legal\s+action|demand\s+letters?|fines?)|(?:legal|lawsuit|litigation)\s+protection)\b/giu,
    message:
      'Claims of protection from lawsuits are banned. Describe the dated remediation record instead.',
  },
  {
    id: 'guarantee',
    pattern: /\bguarant(?:ee|eed|ees|eeing)\b/giu,
    message: 'Guarantees are banned. State what was checked and what was fixed, with dates.',
  },
  {
    id: 'certified',
    pattern: /\bcertif(?:y|ies|ied|ication|ications)\b/giu,
    message:
      'Certification claims are banned. Say "barriers removed" and list what automation cannot detect.',
  },
  {
    id: 'absolute-accessibility',
    pattern:
      /\b(?:100\s*%\s*(?:accessible|accessibility|compliant|compliance)|fully\s+(?:accessible|compliant)|completely\s+accessible)\b/giu,
    message:
      'Absolute accessibility claims are banned. Automated checks find only part of all issues; say so.',
  },
];

export function isRuleId(value: string): value is RuleId {
  return (RULE_IDS as readonly string[]).includes(value);
}
