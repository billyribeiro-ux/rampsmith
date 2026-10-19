//! When to ask the Partner API (ADR-131). The Partner API allows four requests per second per
//! client across every shop, so the app asks on load only when the answer could have changed,
//! and the sweep spreads its checks across the day.

use time::{Duration, OffsetDateTime};

use crate::reconcile::{BillingState, RedirectParam, Standing};

/// How long an app load trusts a confirmed plan. Shopify's own sample caches confirmed
/// subscriptions "with a short expiry such as five minutes".
pub const APP_LOAD_FRESHNESS: Duration = Duration::minutes(5);

/// The sweep re-confirms a shop once its last confirmation is this old. Evaluate the sweep
/// hourly so that every installed shop is confirmed at least once a day.
pub const SWEEP_MAX_AGE: Duration = Duration::hours(24);

/// Time allowed after a billing-cycle or trial boundary for Shopify to roll the subscription
/// before re-confirming.
pub const BOUNDARY_GRACE: Duration = Duration::minutes(2);

/// The first retry delay after a failed check; it doubles per consecutive failure.
pub const RETRY_BASE: Duration = Duration::minutes(1);

/// The longest retry delay.
pub const RETRY_MAX: Duration = Duration::hours(6);

/// Why the Partner API should be asked now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfirmReason {
    /// The request carries a `plan_handle` parameter: the merchant just chose a plan.
    PlanRedirect,
    /// No plan is confirmed; a "no plan" answer is never cached.
    NoConfirmedPlan,
    /// A billing-cycle or trial boundary passed since the last confirmation.
    BoundaryPassed,
    /// The last confirmation is older than the freshness limit.
    Stale,
}

/// Whether to ask the Partner API now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// Ask now, then reconcile.
    Confirm(ConfirmReason),
    /// Use the stored state; the next check is due at `next_check_at`.
    UseStored {
        /// When a check is next due.
        next_check_at: OffsetDateTime,
    },
}

/// The delay before retrying after `consecutive_failures` failed checks: 1 minute, doubling,
/// at most 6 hours. Zero failures means no delay.
#[must_use]
pub fn retry_delay(consecutive_failures: u32) -> Duration {
    if consecutive_failures == 0 {
        return Duration::ZERO;
    }
    let doublings = (consecutive_failures - 1).min(16);
    (RETRY_BASE * (1_i32 << doublings)).min(RETRY_MAX)
}

/// The earliest billing-cycle end or trial end after the last confirmation, plus the grace
/// period: the moment a re-check is due because the subscription may have changed (a renewal,
/// a scheduled change taking effect, a trial ending).
#[must_use]
pub fn next_boundary_check(state: &BillingState) -> Option<OffsetDateTime> {
    let Standing::Paid(paid) = &state.standing else {
        return None;
    };
    let confirmed_at = state.last_confirmed_at?;
    [paid.trial_ends_at, paid.cycle.map(|cycle| cycle.end)]
        .into_iter()
        .flatten()
        .filter(|boundary| *boundary > confirmed_at)
        .min()
        .map(|boundary| boundary + BOUNDARY_GRACE)
}

fn retry_at(state: &BillingState) -> Option<OffsetDateTime> {
    if state.consecutive_failures == 0 {
        return None;
    }
    state
        .last_attempt_at
        .map(|attempt| attempt + retry_delay(state.consecutive_failures))
}

fn age_based(state: &BillingState, max_age: Duration, now: OffsetDateTime) -> Decision {
    let boundary = next_boundary_check(state);
    if boundary.is_some_and(|due| due <= now) {
        return Decision::Confirm(ConfirmReason::BoundaryPassed);
    }
    let Some(confirmed_at) = state.last_confirmed_at else {
        return Decision::Confirm(ConfirmReason::NoConfirmedPlan);
    };
    let stale_at = confirmed_at + max_age;
    if stale_at <= now {
        return Decision::Confirm(ConfirmReason::Stale);
    }
    Decision::UseStored {
        next_check_at: boundary.map_or(stale_at, |due| due.min(stale_at)),
    }
}

/// The decision when the embedded app loads (its root route, before serving a page).
#[must_use]
pub fn on_app_load(
    state: &BillingState,
    redirect: &RedirectParam,
    now: OffsetDateTime,
) -> Decision {
    if *redirect != RedirectParam::Absent {
        return Decision::Confirm(ConfirmReason::PlanRedirect);
    }
    if let Some(retry_at) = retry_at(state)
        && now < retry_at
    {
        return Decision::UseStored {
            next_check_at: retry_at,
        };
    }
    if state.effective_plan().is_none() {
        return Decision::Confirm(ConfirmReason::NoConfirmedPlan);
    }
    age_based(state, APP_LOAD_FRESHNESS, now)
}

/// The decision for one installed shop in the background sweep.
#[must_use]
pub fn in_sweep(state: &BillingState, now: OffsetDateTime) -> Decision {
    if let Some(retry_at) = retry_at(state)
        && now < retry_at
    {
        return Decision::UseStored {
            next_check_at: retry_at,
        };
    }
    age_based(state, SWEEP_MAX_AGE, now)
}
