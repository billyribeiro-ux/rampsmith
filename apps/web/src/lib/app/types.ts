/**
 * The embedded app's view of the api's `/v1/shopify/` operations (ADR-091).
 *
 * Phase 0 declared the operation ids but not their bodies (they answer 503 until lane A fills
 * them in), so these types are the contract the App Home is written against: lane A's handlers
 * return these shapes, the typed fake in `tests/app-fake-api.ts` serves them, and the BFF
 * (`routes/app/api/shopify`) decodes them before the pages see them. The names match the
 * database vocabulary (PLAN §9) and the entitlements function (`crates/billing`).
 */

export const IMPACTS = ['minor', 'moderate', 'serious', 'critical'] as const;
export type Impact = (typeof IMPACTS)[number];

export type PlanHandle = 'free' | 'starter' | 'growth' | 'pro';

export type FeatureKey =
  | 'data_fixes'
  | 'core_recipes'
  | 'github_pull_requests'
  | 'every_recipe'
  | 'description_rewrites'
  | 'regression_alerts'
  | 'ai_widget_proposals'
  | 'multi_language_statements'
  | 'priority_queue';

/** `billing::Gate`: allowed, locked until a plan, or not on any plan. */
export interface FeatureGate {
  readonly feature: FeatureKey;
  readonly gate: 'allowed' | 'locked' | 'unavailable';
  /** The lowest plan that unlocks the feature, when it is locked. */
  readonly unlocked_by: PlanHandle | null;
}

type ScanCadence = 'monthly' | 'weekly' | 'daily';

export interface Entitlements {
  readonly plan: PlanHandle;
  readonly scan_cadence: ScanCadence;
  /** The plan's AI draft allowance; `used` counts the current window (ADR-133). */
  readonly alt_text_drafts: {
    readonly limit: number;
    readonly used: number;
    readonly renews_at: string | null;
  };
  readonly features: readonly FeatureGate[];
}

export type ScanStatus = 'queued' | 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled';
type ScanTrigger = 'manual' | 'scheduled' | 'webhook' | 'verify' | 'free';

export interface ScanSummary {
  readonly id: string;
  readonly status: ScanStatus;
  readonly trigger: ScanTrigger;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly pages_planned: number;
  readonly pages_done: number;
  readonly checks_run: number;
  readonly checks_passed: number;
  /** A short code such as `store_unreachable`; never a message with store content. */
  readonly error_code: string | null;
  /** The scan's `ruleset_version` (the axe-core version and the custom rules' hash). */
  readonly ruleset_version: string;
  /** The coverage disclosure (ADR-225); `null` until the scan is finalised. */
  readonly coverage: {
    readonly automated: readonly string[];
    readonly partial: readonly string[];
    readonly review_queue: number | null;
  } | null;
}

export interface Overview {
  readonly shop: { readonly domain: string; readonly name: string | null };
  readonly entitlements: Entitlements;
  readonly latest_scan: ScanSummary | null;
  readonly next_scan_at: string | null;
  readonly open_by_impact: Readonly<Record<Impact, number>>;
  readonly fixes_awaiting_approval: number;
  readonly fixes_applied: number;
  /** The first applied fix, for the install-to-first-fix measure. */
  readonly first_fix_at: string | null;
}

export type FindingStatus = 'open' | 'fixed' | 'needs_review' | 'accepted_risk' | 'false_positive';
export type FindingOrigin = 'render' | 'data';
export type FixStatus =
  | 'proposed'
  | 'approved'
  | 'applying'
  | 'applied'
  | 'verified'
  | 'failed'
  | 'reverted'
  | 'rejected';

export interface FindingSummary {
  readonly id: string;
  readonly rule_id: string;
  /** One plain-language sentence naming the problem. */
  readonly title: string;
  readonly criteria: readonly string[];
  readonly impact: Impact;
  readonly status: FindingStatus;
  readonly origin: FindingOrigin;
  readonly occurrence_count: number;
  readonly templates_affected: number;
  readonly on_purchase_path: boolean;
  readonly priority_score: number | null;
  /** The newest fix for this finding, if any. */
  readonly fix: { readonly id: string; readonly status: FixStatus } | null;
}

export interface FindingList {
  readonly items: readonly FindingSummary[];
  readonly total: number;
  readonly next_cursor: string | null;
}

interface FindingOccurrence {
  readonly page_url: string;
  readonly page_state: string;
  /** A scrubbed CSS selector (ADR-051). */
  readonly target: string;
  /** A scrubbed HTML excerpt of at most 512 characters. */
  readonly html_excerpt: string;
}

interface EvidenceRef {
  readonly id: string;
  readonly kind: 'before' | 'after';
}

export interface FindingDetail extends FindingSummary {
  /** The rule's plain-language explanation (PLAN §13), one paragraph. */
  readonly explanation: string;
  readonly occurrences: readonly FindingOccurrence[];
  readonly templates: readonly string[];
  readonly evidence: readonly EvidenceRef[];
  readonly fixes: readonly FixSummary[];
}

/** The change an alt-text fix makes (`fixes.diff`, ADR-090). */
export interface AltTextChange {
  readonly type: 'alt_text';
  readonly resource_gid: string;
  readonly field: 'alt';
  readonly before: string | null;
  readonly after: string;
  readonly language: string;
  readonly contains_text: boolean;
  readonly escalated: boolean;
}

interface FixFinding {
  readonly id: string;
  readonly rule_id: string;
  readonly title: string;
  readonly criteria: readonly string[];
  readonly impact: Impact;
}

export interface FixSummary {
  readonly id: string;
  readonly status: FixStatus;
  readonly origin: 'rule' | 'ai' | 'human';
  readonly kind: 'data' | 'code';
  readonly channel: 'admin_api' | 'github_pr' | 'theme_package';
  readonly model: string | null;
  readonly confidence: number | null;
  readonly change: AltTextChange;
  /** The product the image belongs to, for the review card. */
  readonly product_title: string;
  /** The image on Shopify's CDN; shown through the app's media route. */
  readonly image_url: string | null;
  readonly findings: readonly FixFinding[];
  readonly edited: boolean;
  readonly proposed_at: string;
  readonly approved_at: string | null;
  readonly approver_name: string | null;
  readonly applied_at: string | null;
  readonly verified_at: string | null;
  readonly verified_scan: string | null;
  readonly reverts: string | null;
  readonly error_code: string | null;
  readonly before_evidence_id: string | null;
  readonly after_evidence_id: string | null;
}

export interface FixList {
  readonly items: readonly FixSummary[];
  readonly next_cursor: string | null;
}

export type FixFilter = 'queue' | 'applied' | 'all';

export interface Settings {
  readonly weekly_rescan: boolean;
  readonly notification_email: string | null;
  /** 40 to 300; PLAN §13 targets 150. */
  readonly alt_text_max_characters: number;
  readonly ai_budget_micro_usd: number;
  /** The plan's ceiling for the budget (the entitlements function). */
  readonly ai_budget_max_micro_usd: number;
  readonly storefront_password_set: boolean;
  readonly entitlements: Entitlements;
}

/** Fields not listed stay as they are; `storefront_password: null` clears the saved one. */
export interface SettingsUpdate {
  readonly weekly_rescan?: boolean;
  readonly notification_email?: string | null;
  readonly alt_text_max_characters?: number;
  readonly ai_budget_micro_usd?: number;
  readonly storefront_password?: string | null;
}

export interface StatementContent {
  readonly organization: string;
  readonly contact: {
    readonly email: string;
    readonly phone: string;
    readonly postal_address: string;
    readonly form_url: string;
    readonly response_time: string;
  };
  readonly measures: readonly string[];
  readonly limitations: readonly {
    readonly description: string;
    readonly reason: string;
    readonly alternative: string;
  }[];
  readonly compatibility: string;
}

interface StatementVersion {
  readonly id: string;
  readonly version: number;
  readonly status: 'draft' | 'published';
  readonly created_at: string;
  readonly published_at: string | null;
}

export interface StatementState {
  readonly draft: StatementContent | null;
  readonly versions: readonly StatementVersion[];
}

export interface StartedScan {
  readonly scan: ScanSummary;
}

/** An RFC 9457 problem as the api sends it (`Problem` in the OpenAPI document). */
export interface ProblemBody {
  readonly code: string;
  readonly title: string;
  readonly status: number;
  readonly errors?: readonly { readonly field: string; readonly message: string }[];
}

/** A form's working copy of a read-only view model. */
export type Draft<T> = {
  -readonly [K in keyof T]: T[K] extends readonly (infer U)[]
    ? Draft<U>[]
    : T[K] extends object
      ? Draft<T[K]>
      : T[K];
};
