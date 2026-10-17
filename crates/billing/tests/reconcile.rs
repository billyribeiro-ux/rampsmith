//! The plan-state reconciliation state machine (ADR-131): every transition the stored state,
//! the `plan_handle` redirect and the Partner API answer can produce.

// Integration tests are test code: PLAN §8 denies these lints outside tests only.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use billing::partner_api::{
    ActiveSubscription, BillingCycle, ItemPrice, PartnerApiError, PartnerResponse, PendingUpdate,
    SubscriptionItem, parse_active_subscription,
};
use billing::reconcile::{
    Action, ApiAnswer, BillingEvent, BillingState, FreeSource, PaidPlan, Reconciliation,
    RedirectParam, ScheduledChange, Standing, reconcile,
};
use billing::{BillingInterval, Money, Plan, ShopGid, entitlements};
use time::OffsetDateTime;
use time::macros::datetime;

const NOW: OffsetDateTime = datetime!(2026-10-17 12:00 UTC);
const CYCLE: BillingCycle = BillingCycle {
    start: datetime!(2026-10-03 14:20 UTC),
    end: datetime!(2026-11-02 14:20 UTC),
};

fn subscription(handles: &[&str]) -> ActiveSubscription {
    ActiveSubscription {
        billing_period: BillingInterval::Monthly,
        cancel_at_end_of_cycle: false,
        trial_ends_at: None,
        current_billing_cycle: Some(CYCLE),
        items: handles
            .iter()
            .map(|handle| SubscriptionItem {
                handle: (*handle).to_owned(),
                price: Some(ItemPrice::FlatRate {
                    amount: Money::usd_cents(0),
                    active: true,
                }),
            })
            .collect(),
        pending_update: None,
    }
}

fn paid(plan: Plan) -> PaidPlan {
    PaidPlan {
        plan,
        interval: BillingInterval::Monthly,
        cancel_at_end_of_cycle: false,
        trial_ends_at: None,
        cycle: Some(CYCLE),
        scheduled: None,
    }
}

fn stored(standing: Standing) -> BillingState {
    let usage_anchor =
        matches!(standing, Standing::Paid(_)).then_some(datetime!(2026-01-15 00:00 UTC));
    BillingState {
        standing,
        usage_anchor,
        last_confirmed_at: Some(datetime!(2026-10-17 11:00 UTC)),
        last_attempt_at: Some(datetime!(2026-10-17 11:00 UTC)),
        consecutive_failures: 0,
    }
}

fn run(state: &BillingState, redirect: Option<&str>, answer: ApiAnswer<'_>) -> Reconciliation {
    reconcile(state, &RedirectParam::from_query(redirect), answer, NOW)
}

#[test]
fn redirect_parameters_parse_into_plans_or_unrecognized_values() {
    assert_eq!(RedirectParam::from_query(None), RedirectParam::Absent);
    assert_eq!(RedirectParam::from_query(Some("")), RedirectParam::Absent);
    assert_eq!(
        RedirectParam::from_query(Some("growth")),
        RedirectParam::Plan(Plan::Growth)
    );
    assert_eq!(
        RedirectParam::from_query(Some("enterprise")),
        RedirectParam::Unrecognized("enterprise".to_owned())
    );
    let long = "x".repeat(500);
    assert_eq!(
        RedirectParam::from_query(Some(&long)),
        RedirectParam::Unrecognized("x".repeat(64)),
        "untrusted input is bounded"
    );
}

#[test]
fn a_fresh_install_returning_from_the_plan_page_is_confirmed_by_the_api() {
    let answer = subscription(&["starter"]);
    let result = run(
        &BillingState::new(),
        Some("starter"),
        ApiAnswer::Active(&answer),
    );
    assert_eq!(result.action, Action::Continue);
    assert_eq!(
        result.events,
        [BillingEvent::Subscribed {
            plan: Plan::Starter
        }]
    );
    assert_eq!(result.state.standing, Standing::Paid(paid(Plan::Starter)));
    assert_eq!(result.state.effective_plan(), Some(Plan::Starter));
    assert_eq!(
        result.state.entitlements(),
        Some(entitlements(Plan::Starter))
    );
    assert_eq!(
        result.state.usage_anchor,
        Some(CYCLE.start),
        "anchored at the cycle start"
    );
    assert_eq!(result.state.last_confirmed_at, Some(NOW));
    assert_eq!(result.state.consecutive_failures, 0);
}

#[test]
fn no_active_plan_sends_the_merchant_to_the_plan_page() {
    let first = run(&BillingState::new(), None, ApiAnswer::NoActiveSubscription);
    assert_eq!(first.action, Action::ChoosePlan);
    assert_eq!(first.events, [BillingEvent::NoActivePlan]);
    assert_eq!(first.state.standing, Standing::NoActivePlan);
    assert_eq!(first.state.effective_plan(), None);
    assert_eq!(first.state.entitlements(), None);

    let again = run(&first.state, None, ApiAnswer::NoActiveSubscription);
    assert_eq!(again.action, Action::ChoosePlan);
    assert!(again.events.is_empty(), "no repeated event");
}

#[test]
fn choosing_free_needs_no_paid_confirmation() {
    let result = run(
        &BillingState::new(),
        Some("free"),
        ApiAnswer::NoActiveSubscription,
    );
    assert_eq!(result.action, Action::Continue);
    assert_eq!(result.state.standing, Standing::Free(FreeSource::Selected));
    assert_eq!(
        result.events,
        [BillingEvent::Subscribed { plan: Plan::Free }]
    );
    assert_eq!(result.state.usage_anchor, None);

    let later = run(&result.state, None, ApiAnswer::NoActiveSubscription);
    assert_eq!(
        later.action,
        Action::Continue,
        "Free without a subscription stays Free"
    );
    assert_eq!(later.state.standing, Standing::Free(FreeSource::Selected));
    assert!(later.events.is_empty());
}

#[test]
fn a_free_plan_subscription_is_free() {
    let answer = subscription(&["free"]);
    let result = run(
        &BillingState::new(),
        Some("free"),
        ApiAnswer::Active(&answer),
    );
    assert_eq!(
        result.state.standing,
        Standing::Free(FreeSource::Subscription)
    );
    assert_eq!(
        result.events,
        [BillingEvent::Subscribed { plan: Plan::Free }]
    );
    assert_eq!(result.action, Action::Continue);

    let gone = run(&result.state, None, ApiAnswer::NoActiveSubscription);
    assert_eq!(gone.state.standing, Standing::Free(FreeSource::Selected));
    assert_eq!(
        gone.action,
        Action::Continue,
        "a vanished free subscription stays Free"
    );
    assert!(gone.events.is_empty());
}

#[test]
fn a_typed_paid_plan_handle_alone_grants_nothing() {
    let result = run(
        &BillingState::new(),
        Some("pro"),
        ApiAnswer::NoActiveSubscription,
    );
    assert_eq!(result.action, Action::AwaitConfirmation);
    assert_eq!(result.state.effective_plan(), None);
    assert_eq!(
        result.events,
        [
            BillingEvent::RedirectNotConfirmed {
                claimed: Plan::Pro,
                confirmed: None
            },
            BillingEvent::NoActivePlan,
        ]
    );
}

#[test]
fn the_api_answer_wins_over_a_disagreeing_redirect() {
    let answer = subscription(&["starter"]);
    let result = run(
        &BillingState::new(),
        Some("pro"),
        ApiAnswer::Active(&answer),
    );
    assert_eq!(result.state.effective_plan(), Some(Plan::Starter));
    assert_eq!(
        result.events,
        [
            BillingEvent::RedirectNotConfirmed {
                claimed: Plan::Pro,
                confirmed: Some(Plan::Starter)
            },
            BillingEvent::Subscribed {
                plan: Plan::Starter
            },
        ]
    );
}

#[test]
fn upgrades_keep_the_usage_anchor() {
    let state = stored(Standing::Paid(paid(Plan::Starter)));
    let answer = subscription(&["growth"]);
    let result = run(&state, Some("growth"), ApiAnswer::Active(&answer));
    assert_eq!(
        result.events,
        [BillingEvent::Upgraded {
            from: Plan::Starter,
            to: Plan::Growth
        }]
    );
    assert_eq!(result.state.usage_anchor, state.usage_anchor);
}

#[test]
fn upgrading_from_free_anchors_the_monthly_window() {
    let state = stored(Standing::Free(FreeSource::Selected));
    let answer = subscription(&["starter"]);
    let result = run(&state, Some("starter"), ApiAnswer::Active(&answer));
    assert_eq!(
        result.events,
        [BillingEvent::Upgraded {
            from: Plan::Free,
            to: Plan::Starter
        }]
    );
    assert_eq!(result.state.usage_anchor, Some(CYCLE.start));
}

#[test]
fn an_applied_downgrade_is_reported() {
    let state = stored(Standing::Paid(paid(Plan::Pro)));
    let answer = subscription(&["starter"]);
    let result = run(&state, None, ApiAnswer::Active(&answer));
    assert_eq!(
        result.events,
        [BillingEvent::Downgraded {
            from: Plan::Pro,
            to: Plan::Starter
        }]
    );
    assert_eq!(result.state.effective_plan(), Some(Plan::Starter));
}

#[test]
fn a_scheduled_downgrade_is_reported_once_and_applies_later() {
    let state = stored(Standing::Paid(paid(Plan::Pro)));
    let mut answer = subscription(&["pro"]);
    answer.pending_update = Some(PendingUpdate {
        billing_period: BillingInterval::Monthly,
        item_handles: vec!["starter".to_owned()],
    });
    let result = run(&state, Some("starter"), ApiAnswer::Active(&answer));
    assert_eq!(
        result.state.effective_plan(),
        Some(Plan::Pro),
        "still Pro this cycle"
    );
    assert_eq!(
        result.events,
        [
            BillingEvent::RedirectNotConfirmed {
                claimed: Plan::Starter,
                confirmed: Some(Plan::Pro)
            },
            BillingEvent::ChangeScheduled {
                from: Plan::Pro,
                to: Some(Plan::Starter),
                interval: BillingInterval::Monthly,
                effective_at: Some(CYCLE.end),
            },
        ]
    );
    let Standing::Paid(pro) = &result.state.standing else {
        panic!("{:?}", result.state.standing)
    };
    assert_eq!(
        pro.scheduled,
        Some(ScheduledChange {
            plan: Some(Plan::Starter),
            interval: BillingInterval::Monthly
        })
    );

    let again = run(&result.state, None, ApiAnswer::Active(&answer));
    assert!(
        again.events.is_empty(),
        "the same pending change is not reported twice"
    );
}

#[test]
fn a_pending_update_equal_to_the_current_plan_is_no_change() {
    let mut answer = subscription(&["growth"]);
    answer.pending_update = Some(PendingUpdate {
        billing_period: BillingInterval::Monthly,
        item_handles: vec!["growth".to_owned()],
    });
    let result = run(
        &stored(Standing::Paid(paid(Plan::Growth))),
        None,
        ApiAnswer::Active(&answer),
    );
    assert!(result.events.is_empty());
}

#[test]
fn a_downgrade_to_free_is_a_scheduled_cancellation_that_ends_in_free() {
    let state = stored(Standing::Paid(paid(Plan::Growth)));
    let mut cancelling = subscription(&["growth"]);
    cancelling.cancel_at_end_of_cycle = true;
    let scheduled = run(&state, Some("free"), ApiAnswer::Active(&cancelling));
    assert_eq!(scheduled.action, Action::Continue);
    assert_eq!(
        scheduled.state.effective_plan(),
        Some(Plan::Growth),
        "paid until the cycle ends"
    );
    assert_eq!(
        scheduled.events,
        [BillingEvent::CancellationScheduled {
            plan: Plan::Growth,
            effective_at: Some(CYCLE.end)
        }]
    );

    let ended = run(&scheduled.state, None, ApiAnswer::NoActiveSubscription);
    assert_eq!(ended.action, Action::Continue);
    assert_eq!(ended.state.standing, Standing::Free(FreeSource::Selected));
    assert_eq!(
        ended.events,
        [BillingEvent::Downgraded {
            from: Plan::Growth,
            to: Plan::Free
        }]
    );
    assert_eq!(ended.state.usage_anchor, None, "Free has no monthly window");
}

#[test]
fn a_pending_change_to_free_also_ends_in_free() {
    let mut pro = paid(Plan::Pro);
    pro.scheduled = Some(ScheduledChange {
        plan: Some(Plan::Free),
        interval: BillingInterval::Monthly,
    });
    let result = run(
        &stored(Standing::Paid(pro)),
        None,
        ApiAnswer::NoActiveSubscription,
    );
    assert_eq!(result.state.standing, Standing::Free(FreeSource::Selected));
}

#[test]
fn a_withdrawn_cancellation_is_reported() {
    let mut growth = paid(Plan::Growth);
    growth.cancel_at_end_of_cycle = true;
    let answer = subscription(&["growth"]);
    let result = run(
        &stored(Standing::Paid(growth)),
        None,
        ApiAnswer::Active(&answer),
    );
    assert_eq!(
        result.events,
        [BillingEvent::CancellationWithdrawn { plan: Plan::Growth }]
    );
}

#[test]
fn a_paid_plan_that_disappears_unexpectedly_is_cancelled() {
    let state = stored(Standing::Paid(paid(Plan::Starter)));
    let result = run(&state, None, ApiAnswer::NoActiveSubscription);
    assert_eq!(result.action, Action::ChoosePlan);
    assert_eq!(result.state.standing, Standing::NoActivePlan);
    assert_eq!(
        result.events,
        [BillingEvent::Cancelled {
            from: Plan::Starter
        }]
    );
    assert_eq!(result.state.usage_anchor, None);
}

#[test]
fn switching_to_yearly_is_an_interval_change() {
    let state = stored(Standing::Paid(paid(Plan::Starter)));
    let mut answer = subscription(&["starter"]);
    answer.billing_period = BillingInterval::Yearly;
    let result = run(&state, Some("starter"), ApiAnswer::Active(&answer));
    assert_eq!(
        result.events,
        [BillingEvent::IntervalChanged {
            plan: Plan::Starter,
            from: BillingInterval::Monthly,
            to: BillingInterval::Yearly
        }]
    );
    assert_eq!(result.state.usage_anchor, state.usage_anchor);
}

#[test]
fn a_trial_anchors_usage_at_the_first_confirmation() {
    let mut answer = subscription(&["starter"]);
    answer.current_billing_cycle = None;
    answer.trial_ends_at = Some(datetime!(2026-10-24 12:00 UTC));
    let result = run(
        &BillingState::new(),
        Some("starter"),
        ApiAnswer::Active(&answer),
    );
    let Standing::Paid(starter) = &result.state.standing else {
        panic!("{:?}", result.state.standing)
    };
    assert_eq!(starter.trial_ends_at, Some(datetime!(2026-10-24 12:00 UTC)));
    assert_eq!(result.state.usage_anchor, Some(NOW));
}

#[test]
fn api_failures_never_change_or_revoke_a_stored_plan() {
    let state = stored(Standing::Paid(paid(Plan::Growth)));
    let first = run(&state, None, ApiAnswer::Failed);
    assert_eq!(first.action, Action::Continue);
    assert_eq!(first.state.standing, state.standing);
    assert_eq!(first.state.usage_anchor, state.usage_anchor);
    assert_eq!(first.state.last_confirmed_at, state.last_confirmed_at);
    assert_eq!(first.state.last_attempt_at, Some(NOW));
    assert_eq!(
        first.events,
        [BillingEvent::ConfirmationFailed {
            consecutive_failures: 1
        }]
    );

    let second = run(&first.state, Some("pro"), ApiAnswer::Failed);
    assert_eq!(second.state.consecutive_failures, 2);
    assert_eq!(
        second.state.effective_plan(),
        Some(Plan::Growth),
        "no upgrade on a redirect alone"
    );
    assert_eq!(second.action, Action::Continue);

    let answer = subscription(&["growth"]);
    let recovered = run(&second.state, None, ApiAnswer::Active(&answer));
    assert_eq!(recovered.state.consecutive_failures, 0);
    assert!(recovered.events.is_empty());
}

#[test]
fn api_failures_without_a_stored_plan_wait_or_send_to_the_plan_page() {
    let fresh = run(&BillingState::new(), None, ApiAnswer::Failed);
    assert_eq!(fresh.action, Action::AwaitConfirmation);
    assert_eq!(fresh.state.standing, Standing::Unknown);

    let none = stored(Standing::NoActivePlan);
    assert_eq!(
        run(&none, None, ApiAnswer::Failed).action,
        Action::ChoosePlan
    );
    assert_eq!(
        run(&none, Some("growth"), ApiAnswer::Failed).action,
        Action::AwaitConfirmation,
        "a merchant who just chose a plan is not sent back to the plan page"
    );

    let free = run(&BillingState::new(), Some("free"), ApiAnswer::Failed);
    assert_eq!(free.action, Action::Continue);
    assert_eq!(free.state.standing, Standing::Free(FreeSource::Selected));
    assert_eq!(free.state.last_confirmed_at, None, "still to be confirmed");
    assert_eq!(
        free.events,
        [
            BillingEvent::ConfirmationFailed {
                consecutive_failures: 1
            },
            BillingEvent::Subscribed { plan: Plan::Free },
        ]
    );
}

#[test]
fn a_free_redirect_during_an_outage_does_not_end_a_paid_plan() {
    let state = stored(Standing::Paid(paid(Plan::Pro)));
    let result = run(&state, Some("free"), ApiAnswer::Failed);
    assert_eq!(result.state.effective_plan(), Some(Plan::Pro));
}

#[test]
fn an_unknown_subscription_handle_gets_free_entitlements_and_an_operator_event() {
    let response = PartnerResponse {
        status: 200,
        body: std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/partner_api/documented_example.json"
        ))
        .unwrap(),
    };
    let answer = parse_active_subscription(
        &response,
        ShopGid::parse("gid://shopify/Shop/5678").unwrap(),
    )
    .unwrap()
    .unwrap();
    let result = run(&BillingState::new(), None, ApiAnswer::Active(&answer));
    assert_eq!(
        result.state.standing,
        Standing::Unrecognized {
            handle: "pro_plan".to_owned()
        }
    );
    assert_eq!(result.state.effective_plan(), Some(Plan::Free));
    assert_eq!(result.action, Action::Continue);
    assert_eq!(
        result.events,
        [BillingEvent::UnrecognizedPlan {
            handle: "pro_plan".to_owned()
        }]
    );
    let again = run(&result.state, None, ApiAnswer::Active(&answer));
    assert!(again.events.is_empty());
}

#[test]
fn several_plan_items_use_the_highest_and_are_reported() {
    let answer = subscription(&["starter", "extra_scans", "growth"]);
    let result = run(&BillingState::new(), None, ApiAnswer::Active(&answer));
    assert_eq!(result.state.effective_plan(), Some(Plan::Growth));
    assert_eq!(
        result.events,
        [
            BillingEvent::MultiplePlanItems {
                handles: vec!["starter".to_owned(), "growth".to_owned()]
            },
            BillingEvent::Subscribed { plan: Plan::Growth },
        ]
    );
}

#[test]
fn an_unrecognized_redirect_is_reported_and_ignored() {
    let answer = subscription(&["starter"]);
    let result = run(
        &stored(Standing::Paid(paid(Plan::Starter))),
        Some("platinum"),
        ApiAnswer::Active(&answer),
    );
    assert_eq!(
        result.events,
        [BillingEvent::UnrecognizedRedirect {
            handle: "platinum".to_owned()
        }]
    );
    assert_eq!(result.state.effective_plan(), Some(Plan::Starter));
}

#[test]
fn stored_actions_match_the_standing() {
    assert_eq!(
        BillingState::new().stored_action(),
        Action::AwaitConfirmation
    );
    assert_eq!(
        stored(Standing::NoActivePlan).stored_action(),
        Action::ChoosePlan
    );
    assert_eq!(
        stored(Standing::Paid(paid(Plan::Pro))).stored_action(),
        Action::Continue
    );
    assert_eq!(BillingState::default(), BillingState::new());
}

#[test]
fn client_results_classify_into_answers() {
    let active: Result<Option<ActiveSubscription>, PartnerApiError> =
        Ok(Some(subscription(&["pro"])));
    assert!(matches!(
        ApiAnswer::from_result(&active),
        ApiAnswer::Active(_)
    ));
    let none: Result<Option<ActiveSubscription>, PartnerApiError> = Ok(None);
    assert!(matches!(
        ApiAnswer::from_result(&none),
        ApiAnswer::NoActiveSubscription
    ));
    let failed: Result<Option<ActiveSubscription>, PartnerApiError> =
        Err(PartnerApiError::Throttled);
    assert!(matches!(ApiAnswer::from_result(&failed), ApiAnswer::Failed));
}
