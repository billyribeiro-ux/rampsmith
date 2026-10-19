//! When the app and the sweep ask the Partner API (ADR-131).

// Integration tests are test code: PLAN §8 denies these lints outside tests only.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use billing::partner_api::BillingCycle;
use billing::reconcile::{BillingState, FreeSource, PaidPlan, RedirectParam, Standing};
use billing::sweep::{
    APP_LOAD_FRESHNESS, BOUNDARY_GRACE, ConfirmReason, Decision, RETRY_MAX, SWEEP_MAX_AGE,
    in_sweep, next_boundary_check, on_app_load, retry_delay,
};
use billing::{BillingInterval, Plan};
use time::macros::datetime;
use time::{Duration, OffsetDateTime};

const CONFIRMED: OffsetDateTime = datetime!(2026-10-17 12:00 UTC);
const CYCLE_END: OffsetDateTime = datetime!(2026-11-02 14:20 UTC);

fn paid_state() -> BillingState {
    BillingState {
        standing: Standing::Paid(PaidPlan {
            plan: Plan::Growth,
            interval: BillingInterval::Monthly,
            cancel_at_end_of_cycle: false,
            trial_ends_at: None,
            cycle: Some(BillingCycle {
                start: datetime!(2026-10-03 14:20 UTC),
                end: CYCLE_END,
            }),
            scheduled: None,
        }),
        usage_anchor: Some(datetime!(2026-10-03 14:20 UTC)),
        last_confirmed_at: Some(CONFIRMED),
        last_attempt_at: Some(CONFIRMED),
        consecutive_failures: 0,
    }
}

fn failing(mut state: BillingState, failures: u32, attempt: OffsetDateTime) -> BillingState {
    state.consecutive_failures = failures;
    state.last_attempt_at = Some(attempt);
    state
}

const NO_REDIRECT: RedirectParam = RedirectParam::Absent;

#[test]
fn a_plan_redirect_is_always_confirmed() {
    let state = failing(paid_state(), 5, CONFIRMED);
    let redirect = RedirectParam::Plan(Plan::Pro);
    assert_eq!(
        on_app_load(&state, &redirect, CONFIRMED),
        Decision::Confirm(ConfirmReason::PlanRedirect),
        "even during a retry backoff: the merchant just chose a plan"
    );
    let typo = RedirectParam::Unrecognized("x".to_owned());
    assert_eq!(
        on_app_load(&paid_state(), &typo, CONFIRMED),
        Decision::Confirm(ConfirmReason::PlanRedirect)
    );
}

#[test]
fn no_confirmed_plan_is_never_served_from_cache() {
    assert_eq!(
        on_app_load(&BillingState::new(), &NO_REDIRECT, CONFIRMED),
        Decision::Confirm(ConfirmReason::NoConfirmedPlan)
    );
    let mut none = paid_state();
    none.standing = Standing::NoActivePlan;
    assert_eq!(
        on_app_load(&none, &NO_REDIRECT, CONFIRMED + Duration::SECOND),
        Decision::Confirm(ConfirmReason::NoConfirmedPlan)
    );
    let mut unconfirmed_free = BillingState::new();
    unconfirmed_free.standing = Standing::Free(FreeSource::Selected);
    assert_eq!(
        on_app_load(&unconfirmed_free, &NO_REDIRECT, CONFIRMED),
        Decision::Confirm(ConfirmReason::NoConfirmedPlan)
    );
}

#[test]
fn app_loads_trust_a_confirmation_for_five_minutes() {
    let state = paid_state();
    assert_eq!(APP_LOAD_FRESHNESS, Duration::minutes(5));
    assert_eq!(
        on_app_load(&state, &NO_REDIRECT, CONFIRMED + Duration::minutes(4)),
        Decision::UseStored {
            next_check_at: CONFIRMED + APP_LOAD_FRESHNESS
        }
    );
    assert_eq!(
        on_app_load(&state, &NO_REDIRECT, CONFIRMED + APP_LOAD_FRESHNESS),
        Decision::Confirm(ConfirmReason::Stale)
    );
}

#[test]
fn the_sweep_confirms_each_shop_daily() {
    let state = paid_state();
    assert_eq!(SWEEP_MAX_AGE, Duration::hours(24));
    assert_eq!(
        in_sweep(&state, CONFIRMED + Duration::hours(23)),
        Decision::UseStored {
            next_check_at: CONFIRMED + SWEEP_MAX_AGE
        }
    );
    assert_eq!(
        in_sweep(&state, CONFIRMED + SWEEP_MAX_AGE),
        Decision::Confirm(ConfirmReason::Stale)
    );
    assert_eq!(
        in_sweep(&BillingState::new(), CONFIRMED),
        Decision::Confirm(ConfirmReason::NoConfirmedPlan)
    );
}

#[test]
fn a_passed_cycle_end_triggers_a_check_after_the_grace_period() {
    let mut state = paid_state();
    state.last_confirmed_at = Some(CYCLE_END - Duration::hours(2));
    let boundary = CYCLE_END + BOUNDARY_GRACE;
    assert_eq!(next_boundary_check(&state), Some(boundary));
    assert_eq!(
        in_sweep(&state, CYCLE_END - Duration::hours(1)),
        Decision::UseStored {
            next_check_at: boundary
        },
        "the boundary comes before the daily re-check"
    );
    assert_eq!(
        in_sweep(&state, CYCLE_END + Duration::MINUTE),
        Decision::UseStored {
            next_check_at: boundary
        }
    );
    assert_eq!(
        in_sweep(&state, boundary),
        Decision::Confirm(ConfirmReason::BoundaryPassed)
    );
    assert_eq!(
        on_app_load(&state, &NO_REDIRECT, boundary),
        Decision::Confirm(ConfirmReason::BoundaryPassed)
    );

    state.last_confirmed_at = Some(boundary);
    assert_eq!(
        next_boundary_check(&state),
        None,
        "confirmed after the boundary"
    );
}

#[test]
fn a_trial_end_is_a_boundary() {
    let mut state = paid_state();
    let trial_end = datetime!(2026-10-20 09:00 UTC);
    if let Standing::Paid(plan) = &mut state.standing {
        plan.cycle = None;
        plan.trial_ends_at = Some(trial_end);
    }
    assert_eq!(
        next_boundary_check(&state),
        Some(trial_end + BOUNDARY_GRACE)
    );
    assert_eq!(next_boundary_check(&BillingState::new()), None);
}

#[test]
fn failures_back_off_exponentially_up_to_six_hours() {
    assert_eq!(retry_delay(0), Duration::ZERO);
    assert_eq!(retry_delay(1), Duration::minutes(1));
    assert_eq!(retry_delay(2), Duration::minutes(2));
    assert_eq!(retry_delay(5), Duration::minutes(16));
    assert_eq!(retry_delay(9), Duration::minutes(256));
    assert_eq!(retry_delay(10), RETRY_MAX);
    assert_eq!(retry_delay(u32::MAX), RETRY_MAX);
}

#[test]
fn backoff_holds_app_loads_and_the_sweep() {
    let attempt = CONFIRMED + Duration::hours(30);
    let state = failing(paid_state(), 3, attempt);
    let retry_at = attempt + Duration::minutes(4);
    assert_eq!(
        on_app_load(&state, &NO_REDIRECT, attempt + Duration::minutes(1)),
        Decision::UseStored {
            next_check_at: retry_at
        }
    );
    assert_eq!(
        in_sweep(&state, attempt + Duration::minutes(1)),
        Decision::UseStored {
            next_check_at: retry_at
        }
    );
    assert_eq!(
        in_sweep(&state, retry_at),
        Decision::Confirm(ConfirmReason::Stale)
    );
    let unknown = failing(BillingState::new(), 1, attempt);
    assert_eq!(
        on_app_load(&unknown, &NO_REDIRECT, attempt + Duration::SECOND),
        Decision::UseStored {
            next_check_at: attempt + Duration::minutes(1)
        },
        "even without a plan, retries respect the shared rate limit"
    );
}
