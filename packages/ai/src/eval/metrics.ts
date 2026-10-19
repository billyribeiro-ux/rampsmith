/**
 * Metrics of the evaluation harness (PLAN §13; ADR-217):
 * - automatic checks on every candidate: length, banned phrases, language, unsupported
 *   attributes, people never identified;
 * - an offline proxy for "approved unedited", the R1 target of at least 80%;
 * - the production signal itself, the share of drafts approved without edits per prompt
 *   version;
 * - the human rating sample (50 images, two raters, 1 to 5) and the release gate: the mean
 *   rating does not fall and unsupported attributes stay under 2%.
 */
import { createHash } from 'node:crypto';
import type { TaskResult } from '../calls.ts';
import type { AltTextDraft } from '../tasks/alt-text.ts';
import type { DatasetImage } from './dataset.ts';

/** PLAN §13 and §5 R1: at least 80% of drafts approved unedited. */
export const APPROVAL_TARGET = 0.8;
/** PLAN §13 gate: unsupported attributes under 2%. */
export const UNSUPPORTED_LIMIT = 0.02;
/** A draft must cover this share of an image's required attribute groups. */
export const COVERAGE_THRESHOLD = 0.75;

function escape(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** Whole-word, case-insensitive match of a term or phrase. */
export function mentions(text: string, term: string): boolean {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escape(term)}(?![\\p{L}\\p{N}])`, 'iu').test(text);
}

export interface CandidateScore {
  readonly id: string;
  readonly category: string;
  /** What the pipeline produced: a draft for approval, or review with reasons. */
  readonly status: 'draft' | 'needs_review' | 'failed';
  readonly alt: string;
  readonly decorative: boolean;
  readonly reasons: readonly string[];
  readonly coverage: number;
  readonly unsupported: readonly string[];
  readonly namesPerson: boolean;
  /** The offline proxy for a merchant approving the draft without editing it. */
  readonly approvable: boolean;
  readonly escalated: boolean;
  readonly costMicroUsd: number;
}

export interface GraderVerdict {
  readonly unsupported: readonly string[];
  readonly namesPerson: boolean;
}

/**
 * Scores one candidate against its labels. A decorative label is met only by a decorative
 * answer; any other image needs a draft that passed the pipeline's checks, covers the required
 * attributes, adds nothing unsupported and names no one. A grader verdict (live mode, Sonnet
 * 5.5) adds to the label-based findings.
 */
export function scoreCandidate(
  label: DatasetImage,
  outcome: {
    readonly result: TaskResult<AltTextDraft> | null;
    readonly escalated: boolean;
    readonly costMicroUsd: number;
    readonly decorative: boolean;
    readonly alt: string;
  },
  grader?: GraderVerdict,
): CandidateScore {
  const { result } = outcome;
  const alt = outcome.alt;
  const status = result === null ? 'failed' : result.status;
  const reasons =
    result === null ? ['ai_error'] : result.status === 'needs_review' ? result.reasons : [];
  const required = label.required;
  const met = required.filter((group) => group.some((term) => mentions(alt, term))).length;
  const coverage = required.length === 0 ? 1 : met / required.length;
  const unsupported = [
    ...new Set([
      ...label.absent.filter((term) => mentions(alt, term)),
      ...(grader?.unsupported ?? []),
    ]),
  ];
  const namesPerson =
    label.forbidden_names.some((name) => mentions(alt, name)) || (grader?.namesPerson ?? false);
  const approvable = label.expected.decorative
    ? outcome.decorative
    : status === 'draft' &&
      !outcome.decorative &&
      coverage >= COVERAGE_THRESHOLD &&
      unsupported.length === 0 &&
      !namesPerson;
  return {
    id: label.id,
    category: label.category,
    status,
    alt,
    decorative: outcome.decorative,
    reasons,
    coverage,
    unsupported,
    namesPerson,
    approvable,
    escalated: outcome.escalated,
    costMicroUsd: outcome.costMicroUsd,
  };
}

export interface EvalSummary {
  readonly images: number;
  readonly approvable: number;
  readonly approvalRate: number;
  /** Share of non-decorative candidates with at least one unsupported attribute. */
  readonly unsupportedRate: number;
  readonly namedPeople: number;
  readonly escalationRate: number;
  readonly failed: number;
  readonly meanCoverage: number;
  readonly totalCostMicroUsd: number;
  readonly costPerThousandImagesMicroUsd: number;
  readonly byCategory: Readonly<
    Record<string, { readonly images: number; readonly approvable: number }>
  >;
  readonly gate: { readonly passed: boolean; readonly failures: readonly string[] };
}

export function summarize(scores: readonly CandidateScore[]): EvalSummary {
  const n = scores.length;
  const approvable = scores.filter((s) => s.approvable).length;
  const described = scores.filter((s) => !s.decorative);
  const unsupported = described.filter((s) => s.unsupported.length > 0).length;
  const total = scores.reduce((sum, s) => sum + s.costMicroUsd, 0);
  const byCategory: Record<string, { images: number; approvable: number }> = {};
  for (const s of scores) {
    const c = (byCategory[s.category] ??= { images: 0, approvable: 0 });
    c.images += 1;
    c.approvable += s.approvable ? 1 : 0;
  }
  const approvalRate = n === 0 ? 0 : approvable / n;
  const unsupportedRate = described.length === 0 ? 0 : unsupported / described.length;
  const namedPeople = scores.filter((s) => s.namesPerson).length;
  const failures: string[] = [];
  if (approvalRate < APPROVAL_TARGET) failures.push('approval rate below 80%');
  if (unsupportedRate >= UNSUPPORTED_LIMIT) failures.push('unsupported attributes at or above 2%');
  if (namedPeople > 0) failures.push('a draft named a person');
  return {
    images: n,
    approvable,
    approvalRate,
    unsupportedRate,
    namedPeople,
    escalationRate: n === 0 ? 0 : scores.filter((s) => s.escalated).length / n,
    failed: scores.filter((s) => s.status === 'failed').length,
    meanCoverage: n === 0 ? 0 : scores.reduce((sum, s) => sum + s.coverage, 0) / n,
    totalCostMicroUsd: total,
    costPerThousandImagesMicroUsd: n === 0 ? 0 : Math.round((total / n) * 1000),
    byCategory,
    gate: { passed: failures.length === 0, failures },
  };
}

export interface ReviewEvent {
  readonly promptVersion: string;
  readonly action: 'approved' | 'edited' | 'rejected';
}

/**
 * The production signal (PLAN §13): per prompt version, the share of reviewed drafts that a
 * merchant approved without editing.
 */
export function approvedUneditedRate(
  events: readonly ReviewEvent[],
): Readonly<
  Record<
    string,
    { readonly reviewed: number; readonly approvedUnedited: number; readonly rate: number }
  >
> {
  const out: Record<string, { reviewed: number; approvedUnedited: number; rate: number }> = {};
  for (const e of events) {
    const row = (out[e.promptVersion] ??= { reviewed: 0, approvedUnedited: 0, rate: 0 });
    row.reviewed += 1;
    row.approvedUnedited += e.action === 'approved' ? 1 : 0;
    row.rate = row.approvedUnedited / row.reviewed;
  }
  return out;
}

/**
 * The images two people rate for a release: a deterministic sample, so both raters and a
 * rerun see the same images (PLAN §13: 50 per release).
 */
export function selectRatingSample(ids: readonly string[], size = 50, seed = 'release'): string[] {
  const key = (id: string) => createHash('sha256').update(`${seed}\u0000${id}`).digest('hex');
  return [...ids].sort((a, b) => key(a).localeCompare(key(b))).slice(0, size);
}

export interface Rating {
  readonly imageId: string;
  readonly rater: string;
  /** 1 (unusable) to 5 (approve as is). */
  readonly score: number;
}

export interface RatingSummary {
  readonly mean: number;
  readonly byRater: Readonly<Record<string, number>>;
  /** Share of images where the two raters are within one point of each other. */
  readonly agreement: number;
  readonly images: number;
}

export function summarizeRatings(ratings: readonly Rating[]): RatingSummary {
  for (const r of ratings) {
    if (!Number.isInteger(r.score) || r.score < 1 || r.score > 5) {
      throw new RangeError('ratings are integers from 1 to 5');
    }
  }
  const byImage = new Map<string, number[]>();
  const raters = new Map<string, number[]>();
  for (const r of ratings) {
    byImage.set(r.imageId, [...(byImage.get(r.imageId) ?? []), r.score]);
    raters.set(r.rater, [...(raters.get(r.rater) ?? []), r.score]);
  }
  const mean = (xs: readonly number[]) =>
    xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
  const paired = [...byImage.values()].filter((s) => s.length >= 2);
  const close = paired.filter((s) => Math.max(...s) - Math.min(...s) <= 1).length;
  return {
    mean: mean(ratings.map((r) => r.score)),
    byRater: Object.fromEntries([...raters].map(([k, v]) => [k, mean(v)])),
    agreement: paired.length === 0 ? 0 : close / paired.length,
    images: byImage.size,
  };
}

/** The release gate: the mean rating does not fall and unsupported attributes stay under 2%. */
export function releaseGate(
  current: { readonly rating: RatingSummary; readonly unsupportedRate: number },
  previous: { readonly rating: RatingSummary } | null,
): { readonly passed: boolean; readonly failures: readonly string[] } {
  const failures: string[] = [];
  if (previous !== null && current.rating.mean < previous.rating.mean) {
    failures.push('mean human rating fell');
  }
  if (current.unsupportedRate >= UNSUPPORTED_LIMIT) {
    failures.push('unsupported attributes at or above 2%');
  }
  return { passed: failures.length === 0, failures };
}
