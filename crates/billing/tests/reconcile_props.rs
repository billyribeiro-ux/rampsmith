//! Property tests for reconciliation (ADR-131): over any stored state, redirect parameter and
//! Partner API answer, a typed `plan_handle` never grants a paid plan, failures never change a
//! stored plan, and the action always matches the resulting state.

use billing::partner_api::{ActiveSubscription, BillingCycle, PendingUpdate, SubscriptionItem};
use billing::reconcile::{
    Action, ApiAnswer, BillingState, FreeSource, PaidPlan, RedirectParam, ScheduledChange,
    Standing, reconcile,
};
use billing::{BillingInterval, Plan};
use proptest::prelude::*;
use time::OffsetDateTime;
use time::macros::datetime;

const NOW: OffsetDateTime = datetime!(2026-10-17 12:00 UTC);
const CYCLE: BillingCycle = BillingCycle {
    start: datetime!(2026-10-03 00:00 UTC),
    end: datetime!(2026-11-02 00:00 UTC),
};

fn plan() -> impl Strategy<Value = Plan> {
    prop::sample::select(Plan::ALL.to_vec())
}

fn interval() -> impl Strategy<Value = BillingInterval> {
    prop::sample::select(BillingInterval::ALL.to_vec())
}

fn paid_plan() -> impl Strategy<Value = PaidPlan> {
    (
        prop::sample::select(vec![Plan::Starter, Plan::Growth, Plan::Pro]),
        interval(),
        any::<bool>(),
        prop::option::of((prop::option::of(plan()), interval())),
    )
        .prop_map(|(plan, interval, cancel, scheduled)| PaidPlan {
            plan,
            interval,
            cancel_at_end_of_cycle: cancel,
            trial_ends_at: None,
            cycle: Some(CYCLE),
            scheduled: scheduled.map(|(plan, interval)| ScheduledChange { plan, interval }),
        })
}

fn standing() -> impl Strategy<Value = Standing> {
    prop_oneof![
        Just(Standing::Unknown),
        Just(Standing::NoActivePlan),
        Just(Standing::Free(FreeSource::Selected)),
        Just(Standing::Free(FreeSource::Subscription)),
        paid_plan().prop_map(Standing::Paid),
        Just(Standing::Unrecognized {
            handle: "private_plan".to_owned()
        }),
    ]
}

fn stored() -> impl Strategy<Value = BillingState> {
    (standing(), 0_u32..20).prop_map(|(standing, failures)| BillingState {
        usage_anchor: matches!(standing, Standing::Paid(_))
            .then_some(datetime!(2026-09-03 00:00 UTC)),
        standing,
        last_confirmed_at: Some(datetime!(2026-10-17 11:00 UTC)),
        last_attempt_at: Some(datetime!(2026-10-17 11:30 UTC)),
        consecutive_failures: failures,
    })
}

fn redirect() -> impl Strategy<Value = RedirectParam> {
    prop_oneof![
        Just(RedirectParam::Absent),
        plan().prop_map(RedirectParam::Plan),
        Just(RedirectParam::Unrecognized("platinum".to_owned())),
    ]
}

/// What the Partner API said, as owned test data.
#[derive(Debug, Clone)]
enum Answer {
    Failed,
    NoSubscription,
    Active(ActiveSubscription),
}

impl Answer {
    fn as_api(&self) -> ApiAnswer<'_> {
        match self {
            Self::Failed => ApiAnswer::Failed,
            Self::NoSubscription => ApiAnswer::NoActiveSubscription,
            Self::Active(subscription) => ApiAnswer::Active(subscription),
        }
    }

    fn offers(&self, plan: Plan) -> bool {
        matches!(self, Self::Active(subscription)
            if subscription.item_handles().any(|handle| handle == plan.handle()))
    }
}

/// An answer from the API: no subscription, or an active one.
fn answered() -> impl Strategy<Value = Answer> {
    let handles = prop::collection::vec(
        prop::sample::select(vec!["free", "starter", "growth", "pro", "extra_scans"]),
        0..3,
    );
    let subscription = (handles, interval(), any::<bool>(), prop::option::of(plan())).prop_map(
        |(handles, interval, cancel, pending)| ActiveSubscription {
            billing_period: interval,
            cancel_at_end_of_cycle: cancel,
            trial_ends_at: None,
            current_billing_cycle: Some(CYCLE),
            items: handles
                .into_iter()
                .map(|handle| SubscriptionItem {
                    handle: handle.to_owned(),
                    price: None,
                })
                .collect(),
            pending_update: pending.map(|plan| PendingUpdate {
                billing_period: interval,
                item_handles: vec![plan.handle().to_owned()],
            }),
        },
    );
    prop_oneof![
        Just(Answer::NoSubscription),
        subscription.prop_map(Answer::Active)
    ]
}

/// Any answer, including a failure.
fn answer() -> impl Strategy<Value = Answer> {
    prop_oneof![Just(Answer::Failed), answered()]
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(2048))]

    #[test]
    fn a_paid_plan_comes_only_from_storage_or_the_api(
        state in stored(), redirect in redirect(), answer in answer()
    ) {
        let result = reconcile(&state, &redirect, answer.as_api(), NOW);
        if let Some(plan) = result.state.effective_plan().filter(|plan| plan.is_paid()) {
            let from_api = answer.offers(plan);
            let from_storage = state.effective_plan() == Some(plan);
            prop_assert!(from_api || from_storage, "{plan:?} from {redirect:?}");
        }
    }

    #[test]
    fn failures_keep_the_stored_plan_and_confirmation_time(
        state in stored(), redirect in redirect()
    ) {
        let result = reconcile(&state, &redirect, ApiAnswer::Failed, NOW);
        prop_assert_eq!(result.state.consecutive_failures, state.consecutive_failures + 1);
        prop_assert_eq!(result.state.last_confirmed_at, state.last_confirmed_at);
        prop_assert_eq!(result.state.last_attempt_at, Some(NOW));
        let free_choice = redirect == RedirectParam::Plan(Plan::Free) && state.effective_plan().is_none();
        if free_choice {
            prop_assert_eq!(result.state.standing, Standing::Free(FreeSource::Selected));
        } else {
            prop_assert_eq!(&result.state.standing, &state.standing);
            prop_assert_eq!(result.state.usage_anchor, state.usage_anchor);
        }
        if state.effective_plan().is_some() {
            prop_assert_eq!(result.action, Action::Continue, "a failure never redirects a shop with a plan");
        }
    }

    #[test]
    fn answers_reset_failures_and_actions_match_the_state(
        state in stored(), redirect in redirect(), answer in answered()
    ) {
        let result = reconcile(&state, &redirect, answer.as_api(), NOW);
        prop_assert_eq!(result.state.consecutive_failures, 0);
        prop_assert_eq!(result.state.last_confirmed_at, Some(NOW));
        let has_plan = result.state.effective_plan().is_some();
        match result.action {
            Action::Continue => prop_assert!(has_plan),
            Action::ChoosePlan | Action::AwaitConfirmation => {
                prop_assert_eq!(&result.state.standing, &Standing::NoActivePlan);
            }
        }
        if result.action == Action::AwaitConfirmation {
            prop_assert!(matches!(redirect, RedirectParam::Plan(plan) if plan.is_paid()));
        }
        prop_assert_eq!(
            result.state.usage_anchor.is_some(),
            matches!(result.state.standing, Standing::Paid(_)),
            "only paid plans have a monthly usage anchor"
        );
    }
}
