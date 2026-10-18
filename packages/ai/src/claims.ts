/**
 * The claims policy (PLAN §3) applied to model output. It reuses claims-lint's own rules, so
 * the build gate and this runtime guard can never disagree about what a banned claim is.
 */
import { scanText } from '@rampsmith/claims-lint/src/scan.ts';

export interface ClaimMatch {
  readonly rule: string;
  readonly match: string;
}

/**
 * Every banned claim in `text`, in order. claims-lint honours `claims-lint-allow` markers in
 * source files; in model output a marker is just text, so it is defanged before the scan and
 * can never suppress a match (security audit LOW-5).
 */
export function bannedClaims(text: string): ClaimMatch[] {
  const defanged = text.replace(/claims-lint-allow/giu, 'claims-lint-blocked');
  return scanText('model-output', defanged).violations.map((v) => ({
    rule: v.rule,
    match: v.match,
  }));
}

function key(claim: ClaimMatch): string {
  return `${claim.rule}\u0000${claim.match.toLowerCase().replace(/\s+/gu, ' ')}`;
}

/**
 * Banned claims in `output` that none of `sources` already contains. A product called
 * "Certified organic cotton tee" keeps its own words in a rewrite or in alt text; a model that
 * adds "fully accessible" or "compliant" to a store's copy is rejected (ADR-213).
 */
export function introducedClaims(output: string, sources: readonly string[]): ClaimMatch[] {
  const present = new Set(sources.flatMap((s) => bannedClaims(s).map(key)));
  return bannedClaims(output).filter((claim) => !present.has(key(claim)));
}
