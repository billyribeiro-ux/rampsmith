/**
 * The plan limits the alt-text job enforces (security audit M2, M3; ADR-096, ADR-097).
 *
 * The api writes the limits of a shop's plan into `shop_billing` from `billing::entitlements`
 * each time it stores the plan, and the engine reads them back here, so the budget and the
 * draft allowance the engine enforces are the ones the api enforces and shows. A shop with no
 * stored plan is on Free, as in the api.
 *
 * The draft allowance (PLAN §20: Free 25 once, Starter 2,000 a month, Growth 10,000, Pro 50,000)
 * counts `ai_calls` of the alt-text tasks, like `billing::remaining_alt_text_drafts`. Counting
 * `ai_calls` alone lets concurrent jobs all see room for the last draft, so a job takes a hold
 * under a per-tenant advisory lock before it calls the model; the hold counts against the
 * allowance until the job's calls are recorded.
 */
import type postgres from 'postgres';

/** What the api stores with the plan and the engine enforces. */
export interface PlanLimits {
  /** `free`, `starter`, `growth` or `pro`. */
  readonly plan: string;
  /** The most the monthly AI budget may be, in micro-dollars. */
  readonly aiBudgetMaxMicroUsd: number;
  /** AI alt-text drafts the plan includes. */
  readonly draftLimit: number;
  /** True when the allowance is granted once (Free) and never renews. */
  readonly draftLifetime: boolean;
  /** Where the monthly windows are anchored; calendar months when `null`. */
  readonly usageAnchor: Date | null;
}

/** Free's limits (PLAN §20, ADR-214): the plan of a shop whose plan was never confirmed. */
const FREE_LIMITS: PlanLimits = {
  plan: 'free',
  aiBudgetMaxMicroUsd: 500_000,
  draftLimit: 25,
  draftLifetime: true,
  usageAnchor: null,
};

/** How long a hold lasts if its job crashes before releasing it. */
const HOLD_MS = 10 * 60 * 1000;

const DRAFT_TASKS = ['alt_text', 'alt_text_escalated'];
const COUNTED_OUTCOMES = ['ok', 'needs_review'];

export type Tx = postgres.TransactionSql;

/** The limits of the plan the site's shop is on. */
export async function readLimits(tx: Tx, tenantId: string, siteId: string): Promise<PlanLimits> {
  const [row] = await tx<
    {
      effective_plan: string;
      budget: string;
      draft_limit: number;
      lifetime: boolean;
      anchor: Date | null;
    }[]
  >`
    select b.effective_plan, b.ai_budget_max_micro_usd::text as budget,
           b.alt_text_draft_limit as draft_limit, b.alt_text_draft_lifetime as lifetime,
           b.usage_anchor as anchor
      from shopify_shops s
      join shop_billing b on b.shop_id = s.id and b.tenant_id = s.tenant_id
     where s.tenant_id = ${tenantId} and s.site_id = ${siteId}
     order by s.installed_at desc
     limit 1`;
  if (row === undefined) return FREE_LIMITS;
  return {
    plan: row.effective_plan,
    aiBudgetMaxMicroUsd: Number(row.budget),
    draftLimit: row.draft_limit,
    draftLifetime: row.lifetime,
    usageAnchor: row.anchor,
  };
}

/**
 * The monthly budget the engine spends from: what the merchant set, never more than the plan
 * allows; the plan's ceiling when they set nothing. The api computes the same value.
 */
export function effectiveBudgetMicroUsd(setting: number | undefined, ceiling: number): number {
  return Math.min(setting ?? ceiling, ceiling);
}

/** `anchor` moved by `months` calendar months, keeping its day (clamped) and time, in UTC. */
function addMonths(anchor: Date, months: number): Date {
  const index = anchor.getUTCFullYear() * 12 + anchor.getUTCMonth() + months;
  const year = Math.floor(index / 12);
  const month = index - year * 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const out = new Date(anchor.getTime());
  out.setUTCFullYear(year, month, Math.min(anchor.getUTCDate(), lastDay));
  return out;
}

/**
 * The monthly window containing `now`: the twin of `billing::usage::monthly_window`. Windows
 * start each month on the anchor's day and time; a month too short for that day starts on its
 * last day. Without an anchor they are calendar months.
 */
export function monthlyWindow(anchor: Date | null, now: Date): { start: Date; end: Date } {
  const from = anchor ?? new Date(0);
  const monthIndex = (d: Date): number => d.getUTCFullYear() * 12 + d.getUTCMonth();
  let months = monthIndex(now) - monthIndex(from);
  if (addMonths(from, months) > now) months -= 1;
  return { start: addMonths(from, months), end: addMonths(from, months + 1) };
}

export interface Standing {
  readonly limit: number;
  readonly used: number;
  readonly held: number;
  /** Drafts still available now, holds included. */
  readonly remaining: number;
  /** When the allowance renews; `null` for a lifetime allowance. */
  readonly renewsAt: Date | null;
}

/** Where the tenant stands against its draft allowance, holds included. */
export async function standing(
  tx: Tx,
  tenantId: string,
  limits: PlanLimits,
  now: Date = new Date(),
): Promise<Standing> {
  const window = limits.draftLifetime ? null : monthlyWindow(limits.usageAnchor, now);
  const [used] =
    window === null
      ? await tx<{ n: number }[]>`
          select count(*)::int as n from ai_calls
           where tenant_id = ${tenantId} and task in ${tx(DRAFT_TASKS)}
             and outcome in ${tx(COUNTED_OUTCOMES)}`
      : await tx<{ n: number }[]>`
          select count(*)::int as n from ai_calls
           where tenant_id = ${tenantId} and task in ${tx(DRAFT_TASKS)}
             and outcome in ${tx(COUNTED_OUTCOMES)}
             and started_at >= ${window.start} and started_at < ${window.end}`;
  const [held] = await tx<{ n: number }[]>`
    select coalesce(sum(units), 0)::int as n from ai_draft_holds
     where tenant_id = ${tenantId} and expires_at > now()`;
  const usedN = used?.n ?? 0;
  const heldN = held?.n ?? 0;
  return {
    limit: limits.draftLimit,
    used: usedN,
    held: heldN,
    remaining: Math.max(0, limits.draftLimit - usedN - heldN),
    renewsAt: window?.end ?? null,
  };
}

/** The tenant's alt-text jobs that are queued or running and have not drafted yet. */
async function pendingJobs(tx: Tx, tenantId: string): Promise<number> {
  const [row] = await tx<{ n: number }[]>`
    select count(*)::int as n from jobs
     where tenant_id = ${tenantId} and queue = 'ai.alt_text' and state in ('ready', 'running')`;
  return row?.n ?? 0;
}

/**
 * How many more alt-text jobs `audit.data` may queue for the tenant: the allowance left after
 * the drafts in flight and the jobs already waiting. The draft itself checks again before it
 * calls the model; this keeps a store from queueing thousands of jobs that cannot run.
 */
export async function enqueueRoom(tx: Tx, tenantId: string, siteId: string): Promise<number> {
  const limits = await readLimits(tx, tenantId, siteId);
  const now = await standing(tx, tenantId, limits);
  return Math.max(0, now.remaining - (await pendingJobs(tx, tenantId)));
}

export type Reservation =
  | { readonly ok: true; readonly holdId: string; readonly units: 1 | 2 }
  | {
      readonly ok: false;
      /** True when the allowance is used up; false when only other jobs' holds are in the way. */
      readonly spent: boolean;
      readonly lifetime: boolean;
      readonly renewsAt: Date | null;
    };

/**
 * Takes the hold for one draft job: two units when the allowance has room for an escalation to
 * the stronger model, one otherwise. Serialised per tenant by an advisory lock, so two jobs can
 * never both take the last draft.
 */
export async function reserveDrafts(
  sql: postgres.Sql,
  tenantId: string,
  siteId: string,
  holdId: string,
  now: Date = new Date(),
): Promise<Reservation> {
  return sql.begin(async (tx) => {
    await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
    await tx`select pg_advisory_xact_lock(hashtextextended(${`ai_allowance:${tenantId}`}, 0))`;
    const limits = await readLimits(tx, tenantId, siteId);
    const current = await standing(tx, tenantId, limits, now);
    if (current.remaining < 1) {
      return {
        ok: false,
        spent: current.used >= current.limit,
        lifetime: limits.draftLifetime,
        renewsAt: current.renewsAt,
      } as const;
    }
    const units = current.remaining >= 2 ? 2 : 1;
    await tx`
      insert into ai_draft_holds (id, tenant_id, units, expires_at)
      values (${holdId}, ${tenantId}, ${units}, now() + make_interval(secs => ${HOLD_MS / 1000}))`;
    return { ok: true, holdId, units } as const;
  });
}

/** Releases a hold once the job's calls are recorded (or it gave up). Idempotent. */
export async function releaseHold(
  sql: postgres.Sql,
  tenantId: string,
  holdId: string,
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
    await tx`delete from ai_draft_holds where id = ${holdId} and tenant_id = ${tenantId}`;
  });
}
