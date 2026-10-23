// The version of the rule catalog, recorded with every scan (`scans.ruleset_version`, PLAN §11).
// It is a hash of the catalog's content, so a changed rule, criterion or impact changes the
// version without anyone remembering to bump a number. The browser checks' code is covered by
// the rule ids and the package's tests; a change to their logic that keeps the catalog the same
// does not change it.
import { RULES } from './rules.ts';

/** FNV-1a, 32 bits: stable, dependency-free, and not used for anything secret. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** `a11y-rules <hash>`, from the catalog sorted by rule id. */
export const RULES_VERSION = `a11y-rules ${fnv1a(
  JSON.stringify(
    Object.values(RULES)
      .map((r) => [r.id, r.audit, r.criteria, r.impact, r.bestPractice])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  ),
)}`;
