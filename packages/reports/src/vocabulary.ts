// The closed sets of values the reports render. Each spelling matches crates/domain
// (src/enums.rs and src/impact.rs) and the `check` constraints of PLAN §9;
// test/spellings.test.ts reads the Rust source to prove it, so a rename there fails here.

/** Severity, least severe first, as axe-core and `domain::Impact` spell it. */
export const IMPACTS = ['minor', 'moderate', 'serious', 'critical'] as const;
export type Impact = (typeof IMPACTS)[number];

/** `domain::FindingStatus`. */
export const FINDING_STATUSES = [
  'open',
  'fixed',
  'needs_review',
  'accepted_risk',
  'false_positive',
] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

/** `domain::FixKind`. */
export const FIX_KINDS = ['data', 'code'] as const;
export type FixKind = (typeof FIX_KINDS)[number];

/** `domain::FixChannel`. */
export const FIX_CHANNELS = ['admin_api', 'github_pr', 'theme_package'] as const;
export type FixChannel = (typeof FIX_CHANNELS)[number];

/** `domain::FixStatus`. */
export const FIX_STATUSES = [
  'proposed',
  'approved',
  'applying',
  'applied',
  'verified',
  'failed',
  'reverted',
  'rejected',
] as const;
export type FixStatus = (typeof FIX_STATUSES)[number];

/** `domain::FixOrigin`. */
export const FIX_ORIGINS = ['rule', 'ai', 'human'] as const;
export type FixOrigin = (typeof FIX_ORIGINS)[number];

/** `domain::ScanStatus`. */
export const SCAN_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'partial',
  'failed',
  'cancelled',
] as const;
export type ScanStatus = (typeof SCAN_STATUSES)[number];

/** `domain::Platform`. */
export const PLATFORMS = ['shopify', 'wordpress', 'git', 'generic'] as const;
export type Platform = (typeof PLATFORMS)[number];

/** `domain::FixChannel::carries`: data fixes only through the Admin API, code fixes never. */
export function channelCarries(channel: FixChannel, kind: FixKind): boolean {
  return kind === 'data' ? channel === 'admin_api' : channel !== 'admin_api';
}

/** The scans whose results a report may use: finished, with at least some pages checked. */
export function scanHasResults(status: ScanStatus): boolean {
  return status === 'succeeded' || status === 'partial';
}
