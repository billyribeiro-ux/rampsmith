//! The stored form of [`BillingState`]: one row per shop (`shop_billing`, ADR-084).
//!
//! Plain text and timestamps, so the database layer needs nothing else from this crate. The row
//! is written only from a Partner API answer, never from the `plan_handle` redirect (audit M3).

use time::OffsetDateTime;

use crate::entitlements::{DraftAllowance, Entitlements, Feature, entitlements};
use crate::partner_api::BillingCycle;
use crate::plan::{BillingInterval, Plan};
use crate::reconcile::{BillingState, FreeSource, PaidPlan, ScheduledChange, Standing};

/// The stored plan state of one shop.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredBilling {
    /// `unknown`, `no_active_plan`, `free_selected`, `free_subscription`, `paid` or
    /// `unrecognized`.
    pub standing: String,
    /// `free`, `starter`, `growth` or `pro`.
    pub plan: Option<String>,
    /// `monthly` or `yearly`.
    pub plan_interval: Option<String>,
    /// Whether the subscription ends with the cycle.
    pub cancel_at_end_of_cycle: bool,
    /// When the trial ends.
    pub trial_ends_at: Option<OffsetDateTime>,
    /// The cycle's start.
    pub cycle_start: Option<OffsetDateTime>,
    /// The cycle's end.
    pub cycle_end: Option<OffsetDateTime>,
    /// The plan a pending change moves to.
    pub scheduled_plan: Option<String>,
    /// The interval of that change.
    pub scheduled_interval: Option<String>,
    /// The first item handle of an unrecognised subscription.
    pub unrecognized_handle: Option<String>,
    /// The anchor of the monthly allowance windows.
    pub usage_anchor: Option<OffsetDateTime>,
    /// The last time the Partner API answered.
    pub last_confirmed_at: Option<OffsetDateTime>,
    /// The last time it was asked.
    pub last_attempt_at: Option<OffsetDateTime>,
    /// Failed attempts since the last answer.
    pub consecutive_failures: i32,
}

fn plan_of(text: Option<&str>) -> Option<Plan> {
    text.and_then(|handle| Plan::from_handle(handle).ok())
}

fn interval_of(text: Option<&str>) -> Option<BillingInterval> {
    match text {
        Some("monthly") => Some(BillingInterval::Monthly),
        Some("yearly") => Some(BillingInterval::Yearly),
        _ => None,
    }
}

/// The plan state a stored row describes. No row, or a row that does not parse, is a shop
/// whose plan was never confirmed.
#[must_use]
pub fn state_of(stored: Option<&StoredBilling>) -> BillingState {
    let Some(row) = stored else {
        return BillingState::new();
    };
    let standing = match row.standing.as_str() {
        "no_active_plan" => Standing::NoActivePlan,
        "free_selected" => Standing::Free(FreeSource::Selected),
        "free_subscription" => Standing::Free(FreeSource::Subscription),
        "unrecognized" => Standing::Unrecognized {
            handle: row.unrecognized_handle.clone().unwrap_or_default(),
        },
        "paid" => match (
            plan_of(row.plan.as_deref()).filter(|plan| plan.is_paid()),
            interval_of(row.plan_interval.as_deref()),
        ) {
            (Some(plan), Some(interval)) => Standing::Paid(PaidPlan {
                plan,
                interval,
                cancel_at_end_of_cycle: row.cancel_at_end_of_cycle,
                trial_ends_at: row.trial_ends_at,
                cycle: row
                    .cycle_start
                    .zip(row.cycle_end)
                    .map(|(start, end)| BillingCycle { start, end }),
                scheduled: interval_of(row.scheduled_interval.as_deref()).map(|interval| {
                    ScheduledChange {
                        plan: plan_of(row.scheduled_plan.as_deref()),
                        interval,
                    }
                }),
            }),
            _ => Standing::Unknown,
        },
        _ => Standing::Unknown,
    };
    BillingState {
        standing,
        usage_anchor: row.usage_anchor,
        last_confirmed_at: row.last_confirmed_at,
        last_attempt_at: row.last_attempt_at,
        consecutive_failures: u32::try_from(row.consecutive_failures).unwrap_or(0),
    }
}

/// The row that stores `state`.
#[must_use]
pub fn stored_of(state: &BillingState) -> StoredBilling {
    let mut row = StoredBilling {
        standing: String::new(),
        plan: None,
        plan_interval: None,
        cancel_at_end_of_cycle: false,
        trial_ends_at: None,
        cycle_start: None,
        cycle_end: None,
        scheduled_plan: None,
        scheduled_interval: None,
        unrecognized_handle: None,
        usage_anchor: state.usage_anchor,
        last_confirmed_at: state.last_confirmed_at,
        last_attempt_at: state.last_attempt_at,
        consecutive_failures: i32::try_from(state.consecutive_failures).unwrap_or(i32::MAX),
    };
    match &state.standing {
        Standing::Unknown => "unknown",
        Standing::NoActivePlan => "no_active_plan",
        Standing::Free(FreeSource::Selected) => "free_selected",
        Standing::Free(FreeSource::Subscription) => "free_subscription",
        Standing::Unrecognized { handle } => {
            row.unrecognized_handle = Some(handle.clone());
            "unrecognized"
        }
        Standing::Paid(paid) => {
            row.plan = Some(paid.plan.handle().to_owned());
            row.plan_interval = Some(paid.interval.as_str().to_owned());
            row.cancel_at_end_of_cycle = paid.cancel_at_end_of_cycle;
            row.trial_ends_at = paid.trial_ends_at;
            row.cycle_start = paid.cycle.map(|cycle| cycle.start);
            row.cycle_end = paid.cycle.map(|cycle| cycle.end);
            if let Some(change) = paid.scheduled {
                row.scheduled_plan = change.plan.map(|plan| plan.handle().to_owned());
                row.scheduled_interval = Some(change.interval.as_str().to_owned());
            }
            "paid"
        }
    }
    .clone_into(&mut row.standing);
    row
}

/// The entitlements that apply to a shop in `state`: the confirmed plan's, and Free's while no
/// plan is confirmed.
#[must_use]
pub fn entitlements_of(state: &BillingState) -> Entitlements {
    entitlements(state.effective_plan().unwrap_or(Plan::Free))
}

/// The limits of a shop's plan that the engine enforces without linking this crate: stored
/// beside the plan (`shop_billing`, ADR-096) every time the state is, so the api and the engine
/// read one source (security audit M2, M3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StoredLimits {
    /// The plan the limits are those of: the confirmed plan, or Free while none is.
    pub plan: Plan,
    /// The most the store's monthly AI budget may be, in micro-dollars.
    pub ai_budget_max_micro_usd: i64,
    /// AI alt-text drafts the plan includes.
    pub alt_text_draft_limit: i32,
    /// Whether that allowance is granted once for the shop's lifetime (Free) rather than monthly.
    pub alt_text_draft_lifetime: bool,
    /// Whether the plan includes regression alerts (ADR-310).
    pub regression_alerts: bool,
}

/// The limits that apply to a shop in `state`.
#[must_use]
pub fn limits_of(state: &BillingState) -> StoredLimits {
    let granted = entitlements_of(state);
    let (limit, lifetime) = match granted.alt_text_drafts() {
        DraftAllowance::Lifetime(limit) => (limit, true),
        DraftAllowance::Monthly(limit) => (limit, false),
    };
    StoredLimits {
        plan: granted.plan(),
        ai_budget_max_micro_usd: i64::try_from(granted.ai_budget_micro_usd()).unwrap_or(i64::MAX),
        alt_text_draft_limit: i32::try_from(limit).unwrap_or(i32::MAX),
        alt_text_draft_lifetime: lifetime,
        regression_alerts: granted.allows(Feature::RegressionAlerts),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::datetime;

    #[test]
    fn stored_limits_follow_the_plan_table() {
        let paid = |plan| BillingState {
            standing: Standing::Paid(PaidPlan {
                plan,
                interval: BillingInterval::Monthly,
                cancel_at_end_of_cycle: false,
                trial_ends_at: None,
                cycle: None,
                scheduled: None,
            }),
            ..BillingState::new()
        };
        let free = limits_of(&BillingState::new());
        assert_eq!(free.plan, Plan::Free, "an unconfirmed shop is on Free");
        assert!(!free.regression_alerts, "Free has no regression alerts");
        assert_eq!(
            (
                free.ai_budget_max_micro_usd,
                free.alt_text_draft_limit,
                free.alt_text_draft_lifetime
            ),
            (500_000, 25, true)
        );
        let table = [
            (Plan::Starter, 5_000_000, 2_000),
            (Plan::Growth, 20_000_000, 10_000),
            (Plan::Pro, 60_000_000, 50_000),
        ];
        for (plan, budget, drafts) in table {
            let limits = limits_of(&paid(plan));
            assert_eq!(limits.plan, plan);
            assert_eq!(limits.ai_budget_max_micro_usd, budget);
            assert_eq!(limits.alt_text_draft_limit, drafts);
            assert!(!limits.alt_text_draft_lifetime, "{plan:?} renews monthly");
            assert_eq!(
                limits.regression_alerts,
                plan != Plan::Starter,
                "{plan:?}: regression alerts start at Growth"
            );
        }
    }

    #[test]
    fn a_shop_without_a_row_is_on_free_until_confirmed() {
        let state = state_of(None);
        assert_eq!(state.standing, Standing::Unknown);
        assert_eq!(state.effective_plan(), None);
    }

    #[test]
    fn every_standing_survives_storage() {
        let cycle = BillingCycle {
            start: datetime!(2026-10-01 00:00 UTC),
            end: datetime!(2026-10-31 00:00 UTC),
        };
        let standings = [
            Standing::Unknown,
            Standing::NoActivePlan,
            Standing::Free(FreeSource::Selected),
            Standing::Free(FreeSource::Subscription),
            Standing::Unrecognized {
                handle: "custom".to_owned(),
            },
            Standing::Paid(PaidPlan {
                plan: Plan::Growth,
                interval: BillingInterval::Yearly,
                cancel_at_end_of_cycle: true,
                trial_ends_at: Some(datetime!(2026-10-08 00:00 UTC)),
                cycle: Some(cycle),
                scheduled: Some(ScheduledChange {
                    plan: Some(Plan::Starter),
                    interval: BillingInterval::Monthly,
                }),
            }),
        ];
        for standing in standings {
            let state = BillingState {
                standing,
                usage_anchor: Some(datetime!(2026-09-15 12:00 UTC)),
                last_confirmed_at: Some(datetime!(2026-10-20 09:00 UTC)),
                last_attempt_at: Some(datetime!(2026-10-20 09:00 UTC)),
                consecutive_failures: 2,
            };
            assert_eq!(state_of(Some(&stored_of(&state))), state);
        }
    }

    #[test]
    fn a_paid_row_without_a_paid_plan_is_not_trusted() {
        let mut row = stored_of(&BillingState::new());
        "paid".clone_into(&mut row.standing);
        row.plan = Some("free".to_owned());
        row.plan_interval = Some("monthly".to_owned());
        assert_eq!(state_of(Some(&row)).standing, Standing::Unknown);
    }

    #[test]
    fn paid_standing_gives_that_plans_entitlements() {
        let state = BillingState {
            standing: Standing::Paid(PaidPlan {
                plan: Plan::Pro,
                interval: BillingInterval::Monthly,
                cancel_at_end_of_cycle: false,
                trial_ends_at: None,
                cycle: None,
                scheduled: None,
            }),
            ..BillingState::new()
        };
        assert_eq!(state.effective_plan(), Some(Plan::Pro));
        assert_eq!(entitlements(Plan::Pro).ai_budget_micro_usd(), 60_000_000);
    }
}
