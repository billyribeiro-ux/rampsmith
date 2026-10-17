//! Plan-state reconciliation (ADR-131): stored state + `plan_handle` redirect parameter +
//! Partner API answer → new state, events and what the app should do next. Pure: the caller
//! supplies `now` and persists the result.

use time::OffsetDateTime;

use crate::entitlements::{Entitlements, entitlements};
use crate::partner_api::{ActiveSubscription, BillingCycle, PartnerApiError};
use crate::plan::{BillingInterval, Plan};

/// The longest handle text kept from untrusted input (redirect parameters, API items).
const MAX_HANDLE_CHARS: usize = 64;

fn bounded(text: &str) -> String {
    text.chars().take(MAX_HANDLE_CHARS).collect()
}

/// The `plan_handle` query parameter Shopify appends after plan selection. Unauthenticated:
/// anyone can type it, so it never grants a paid plan on its own.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RedirectParam {
    /// No `plan_handle` parameter (or an empty one).
    Absent,
    /// A Rampsmith plan handle.
    Plan(Plan),
    /// Some other value, truncated to 64 characters.
    Unrecognized(String),
}

impl RedirectParam {
    /// Reads the `plan_handle` query parameter's value.
    #[must_use]
    pub fn from_query(plan_handle: Option<&str>) -> Self {
        match plan_handle {
            None | Some("") => Self::Absent,
            Some(value) => Plan::from_handle(value)
                .map_or_else(|_| Self::Unrecognized(bounded(value)), Self::Plan),
        }
    }
}

/// How a shop came to be on Free.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FreeSource {
    /// The merchant chose Free (a `plan_handle=free` redirect, or a scheduled cancellation or
    /// downgrade to Free that took effect) and no subscription is active.
    Selected,
    /// The Partner API reports an active subscription to the `free` plan.
    Subscription,
}

/// A change Shopify will apply at the start of the next billing cycle (`pendingUpdate`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScheduledChange {
    /// The plan from the next cycle; `None` when its handle is not a Rampsmith plan.
    pub plan: Option<Plan>,
    /// The billing interval from the next cycle.
    pub interval: BillingInterval,
}

/// A paid plan confirmed by the Partner API.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PaidPlan {
    /// The plan; never [`Plan::Free`].
    pub plan: Plan,
    /// How often it is billed.
    pub interval: BillingInterval,
    /// Whether it ends at the end of the current cycle.
    pub cancel_at_end_of_cycle: bool,
    /// When the trial ends, during a trial.
    pub trial_ends_at: Option<OffsetDateTime>,
    /// The current billing cycle; `None` during a trial.
    pub cycle: Option<BillingCycle>,
    /// A change scheduled for the next cycle.
    pub scheduled: Option<ScheduledChange>,
}

/// Where a shop stands with Shopify App Pricing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Standing {
    /// Never confirmed: a fresh install before its first successful check.
    Unknown,
    /// Confirmed: no active subscription, and the merchant has not chosen Free.
    NoActivePlan,
    /// On Free.
    Free(FreeSource),
    /// On a paid plan.
    Paid(PaidPlan),
    /// An active subscription whose items carry no Rampsmith plan handle (a private or test
    /// plan): Free entitlements, no redirect, and an event for operators.
    Unrecognized {
        /// The first item handle, truncated to 64 characters.
        handle: String,
    },
}

impl Standing {
    /// The plan whose entitlements apply, or `None` when the shop has no plan.
    #[must_use]
    pub const fn plan(&self) -> Option<Plan> {
        match self {
            Self::Unknown | Self::NoActivePlan => None,
            Self::Free(_) | Self::Unrecognized { .. } => Some(Plan::Free),
            Self::Paid(paid) => Some(paid.plan),
        }
    }

    /// The plan the shop is known to have chosen, for change events.
    const fn known_plan(&self) -> Option<Plan> {
        match self {
            Self::Unknown | Self::NoActivePlan | Self::Unrecognized { .. } => None,
            Self::Free(_) => Some(Plan::Free),
            Self::Paid(paid) => Some(paid.plan),
        }
    }
}

/// Everything stored per shop for plan state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BillingState {
    /// Where the shop stands.
    pub standing: Standing,
    /// The anchor of the monthly alt-text windows (ADR-133); set while on a paid plan.
    pub usage_anchor: Option<OffsetDateTime>,
    /// The last time the Partner API answered.
    pub last_confirmed_at: Option<OffsetDateTime>,
    /// The last time the Partner API was asked, answered or not.
    pub last_attempt_at: Option<OffsetDateTime>,
    /// Failed attempts since the last answer.
    pub consecutive_failures: u32,
}

impl Default for BillingState {
    fn default() -> Self {
        Self::new()
    }
}

impl BillingState {
    /// The state of a freshly installed shop.
    #[must_use]
    pub const fn new() -> Self {
        Self {
            standing: Standing::Unknown,
            usage_anchor: None,
            last_confirmed_at: None,
            last_attempt_at: None,
            consecutive_failures: 0,
        }
    }

    /// The plan whose entitlements apply, or `None` when the shop has no plan.
    #[must_use]
    pub const fn effective_plan(&self) -> Option<Plan> {
        self.standing.plan()
    }

    /// The entitlements that apply, or `None` when the shop has no plan.
    #[must_use]
    pub fn entitlements(&self) -> Option<Entitlements> {
        self.effective_plan().map(entitlements)
    }

    /// What the app should do when it serves this stored state without asking Shopify.
    #[must_use]
    pub const fn stored_action(&self) -> Action {
        match self.standing {
            Standing::Unknown => Action::AwaitConfirmation,
            Standing::NoActivePlan => Action::ChoosePlan,
            _ => Action::Continue,
        }
    }
}

/// What the Partner API said.
#[derive(Debug, Clone, Copy)]
pub enum ApiAnswer<'a> {
    /// An active subscription.
    Active(&'a ActiveSubscription),
    /// `activeSubscription` was null.
    NoActiveSubscription,
    /// No usable answer (transport failure, throttling, error, malformed body).
    Failed,
}

impl<'a> ApiAnswer<'a> {
    /// Classifies the Partner API client's result.
    #[must_use]
    pub const fn from_result(
        result: &'a Result<Option<ActiveSubscription>, PartnerApiError>,
    ) -> Self {
        match result {
            Ok(Some(subscription)) => Self::Active(subscription),
            Ok(None) => Self::NoActiveSubscription,
            Err(_) => Self::Failed,
        }
    }
}

/// What the app should do after reconciling.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// Serve the app with the state's entitlements.
    Continue,
    /// Send the merchant to Shopify's hosted plan selection page.
    ChoosePlan,
    /// Show a "confirming your plan" screen and check again shortly: Shopify has not yet
    /// confirmed a plan the merchant just chose, or could not be reached.
    AwaitConfirmation,
}

/// Something that changed or needs an operator's attention. The caller writes each to the
/// audit log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BillingEvent {
    /// A shop without a plan now has one.
    Subscribed {
        /// The plan.
        plan: Plan,
    },
    /// Moved to a higher plan.
    Upgraded {
        /// The previous plan.
        from: Plan,
        /// The new plan.
        to: Plan,
    },
    /// Moved to a lower plan.
    Downgraded {
        /// The previous plan.
        from: Plan,
        /// The new plan.
        to: Plan,
    },
    /// The plan ended without a choice of Free; the merchant will be sent to the plan page.
    Cancelled {
        /// The plan that ended.
        from: Plan,
    },
    /// The first check found no plan; the merchant will be sent to the plan page.
    NoActivePlan,
    /// Same plan, other billing interval.
    IntervalChanged {
        /// The plan.
        plan: Plan,
        /// The previous interval.
        from: BillingInterval,
        /// The new interval.
        to: BillingInterval,
    },
    /// The subscription will end at the end of the cycle (for example, a downgrade to Free).
    CancellationScheduled {
        /// The plan that will end.
        plan: Plan,
        /// The end of the current cycle, when known.
        effective_at: Option<OffsetDateTime>,
    },
    /// A scheduled cancellation was withdrawn.
    CancellationWithdrawn {
        /// The plan that continues.
        plan: Plan,
    },
    /// A plan or interval change will apply from the next cycle.
    ChangeScheduled {
        /// The current plan.
        from: Plan,
        /// The next plan; `None` when its handle is not a Rampsmith plan.
        to: Option<Plan>,
        /// The next interval.
        interval: BillingInterval,
        /// The end of the current cycle, when known.
        effective_at: Option<OffsetDateTime>,
    },
    /// The active subscription has no Rampsmith plan handle.
    UnrecognizedPlan {
        /// The first item handle, truncated.
        handle: String,
    },
    /// Several items carry Rampsmith plan handles; the highest plan applies.
    MultiplePlanItems {
        /// The plan handles found, lowest first.
        handles: Vec<String>,
    },
    /// The redirect named a paid plan that the Partner API does not show (yet).
    RedirectNotConfirmed {
        /// The plan in `plan_handle`.
        claimed: Plan,
        /// The plan that applies instead.
        confirmed: Option<Plan>,
    },
    /// The redirect's `plan_handle` is not a Rampsmith plan handle.
    UnrecognizedRedirect {
        /// The value, truncated.
        handle: String,
    },
    /// The Partner API gave no usable answer; the stored plan stays in force.
    ConfirmationFailed {
        /// Failed attempts since the last answer, including this one.
        consecutive_failures: u32,
    },
}

/// The result of one reconciliation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reconciliation {
    /// The state to store.
    pub state: BillingState,
    /// What changed, in order.
    pub events: Vec<BillingEvent>,
    /// What the app should do now.
    pub action: Action,
}

/// Reconciles the stored state with the redirect parameter and the Partner API's answer.
#[must_use]
pub fn reconcile(
    stored: &BillingState,
    redirect: &RedirectParam,
    answer: ApiAnswer<'_>,
    now: OffsetDateTime,
) -> Reconciliation {
    let mut events = Vec::new();
    if let RedirectParam::Unrecognized(handle) = redirect {
        events.push(BillingEvent::UnrecognizedRedirect {
            handle: handle.clone(),
        });
    }
    let claimed_paid = match redirect {
        RedirectParam::Plan(plan) if plan.is_paid() => Some(*plan),
        _ => None,
    };
    let chose_free = *redirect == RedirectParam::Plan(Plan::Free);

    match answer {
        ApiAnswer::Failed => {
            let consecutive_failures = stored.consecutive_failures.saturating_add(1);
            events.push(BillingEvent::ConfirmationFailed {
                consecutive_failures,
            });
            let mut state = BillingState {
                last_attempt_at: Some(now),
                consecutive_failures,
                ..stored.clone()
            };
            if chose_free && stored.standing.plan().is_none() {
                // Free grants nothing paid, so the merchant's choice needs no confirmation.
                let standing = Standing::Free(FreeSource::Selected);
                events.extend(transition_events(&stored.standing, &standing));
                state.standing = standing;
                state.usage_anchor = None;
                return Reconciliation {
                    state,
                    events,
                    action: Action::Continue,
                };
            }
            let action = match state.standing {
                Standing::NoActivePlan if claimed_paid.is_none() => Action::ChoosePlan,
                Standing::Unknown | Standing::NoActivePlan => Action::AwaitConfirmation,
                _ => Action::Continue,
            };
            Reconciliation {
                state,
                events,
                action,
            }
        }
        ApiAnswer::NoActiveSubscription => {
            let standing = if chose_free {
                Standing::Free(FreeSource::Selected)
            } else {
                match &stored.standing {
                    Standing::Free(source) => Standing::Free(*source),
                    Standing::Paid(paid) if ended_by_choosing_free(paid) => {
                        Standing::Free(FreeSource::Selected)
                    }
                    _ => Standing::NoActivePlan,
                }
            };
            if let Some(claimed) = claimed_paid {
                events.push(BillingEvent::RedirectNotConfirmed {
                    claimed,
                    confirmed: standing.plan(),
                });
            }
            let action = match standing {
                Standing::NoActivePlan if claimed_paid.is_some() => Action::AwaitConfirmation,
                Standing::NoActivePlan => Action::ChoosePlan,
                _ => Action::Continue,
            };
            confirmed(stored, standing, events, action, now)
        }
        ApiAnswer::Active(subscription) => {
            let standing = standing_from(subscription, &mut events);
            if let Some(claimed) = claimed_paid
                && standing.plan() != Some(claimed)
            {
                events.push(BillingEvent::RedirectNotConfirmed {
                    claimed,
                    confirmed: standing.plan(),
                });
            }
            confirmed(stored, standing, events, Action::Continue, now)
        }
    }
}

/// Whether a paid plan that has now disappeared had been scheduled to end in Free: a
/// downgrade to a free plan is a scheduled cancellation at the end of the cycle.
fn ended_by_choosing_free(paid: &PaidPlan) -> bool {
    paid.cancel_at_end_of_cycle
        || paid
            .scheduled
            .is_some_and(|change| change.plan == Some(Plan::Free))
}

fn highest_plan<'a>(handles: impl Iterator<Item = &'a str>) -> Vec<Plan> {
    let mut plans: Vec<Plan> = handles
        .filter_map(|handle| Plan::from_handle(handle).ok())
        .collect();
    plans.sort_unstable();
    plans.dedup();
    plans
}

fn standing_from(subscription: &ActiveSubscription, events: &mut Vec<BillingEvent>) -> Standing {
    let plans = highest_plan(subscription.item_handles());
    let Some(&plan) = plans.last() else {
        let handle = subscription
            .item_handles()
            .next()
            .map(bounded)
            .unwrap_or_default();
        return Standing::Unrecognized { handle };
    };
    if plans.len() > 1 {
        events.push(BillingEvent::MultiplePlanItems {
            handles: plans.iter().map(|plan| plan.handle().to_owned()).collect(),
        });
    }
    if plan == Plan::Free {
        return Standing::Free(FreeSource::Subscription);
    }
    let scheduled = subscription
        .pending_update
        .as_ref()
        .map(|pending| ScheduledChange {
            plan: highest_plan(pending.item_handles.iter().map(String::as_str))
                .last()
                .copied(),
            interval: pending.billing_period,
        })
        .filter(|change| {
            change.plan != Some(plan) || change.interval != subscription.billing_period
        });
    Standing::Paid(PaidPlan {
        plan,
        interval: subscription.billing_period,
        cancel_at_end_of_cycle: subscription.cancel_at_end_of_cycle,
        trial_ends_at: subscription.trial_ends_at,
        cycle: subscription.current_billing_cycle,
        scheduled,
    })
}

fn confirmed(
    stored: &BillingState,
    standing: Standing,
    mut events: Vec<BillingEvent>,
    action: Action,
    now: OffsetDateTime,
) -> Reconciliation {
    events.extend(transition_events(&stored.standing, &standing));
    let usage_anchor = match (&stored.standing, &standing) {
        (Standing::Paid(_), Standing::Paid(_)) if stored.usage_anchor.is_some() => {
            stored.usage_anchor
        }
        (_, Standing::Paid(paid)) => Some(
            paid.cycle
                .map(|cycle| cycle.start)
                .filter(|start| *start <= now)
                .unwrap_or(now),
        ),
        _ => None,
    };
    Reconciliation {
        state: BillingState {
            standing,
            usage_anchor,
            last_confirmed_at: Some(now),
            last_attempt_at: Some(now),
            consecutive_failures: 0,
        },
        events,
        action,
    }
}

fn transition_events(old: &Standing, new: &Standing) -> Vec<BillingEvent> {
    let mut events = Vec::new();
    match (old.known_plan(), new.known_plan()) {
        (None, Some(plan)) => events.push(BillingEvent::Subscribed { plan }),
        (Some(from), Some(to)) if to > from => events.push(BillingEvent::Upgraded { from, to }),
        (Some(from), Some(to)) if to < from => {
            events.push(BillingEvent::Downgraded { from, to });
        }
        (Some(from), None) if *new == Standing::NoActivePlan => {
            events.push(BillingEvent::Cancelled { from });
        }
        (None, None) if *new == Standing::NoActivePlan && *old != Standing::NoActivePlan => {
            events.push(BillingEvent::NoActivePlan);
        }
        _ => {}
    }
    if let Standing::Unrecognized { handle } = new
        && !matches!(old, Standing::Unrecognized { handle: previous } if previous == handle)
    {
        events.push(BillingEvent::UnrecognizedPlan {
            handle: handle.clone(),
        });
    }
    if let Standing::Paid(next) = new {
        let previous = match old {
            Standing::Paid(previous) => Some(previous),
            _ => None,
        };
        let effective_at = next.cycle.map(|cycle| cycle.end);
        if let Some(previous) = previous
            && previous.plan == next.plan
        {
            if previous.interval != next.interval {
                events.push(BillingEvent::IntervalChanged {
                    plan: next.plan,
                    from: previous.interval,
                    to: next.interval,
                });
            }
            if previous.cancel_at_end_of_cycle && !next.cancel_at_end_of_cycle {
                events.push(BillingEvent::CancellationWithdrawn { plan: next.plan });
            }
        }
        let was_cancelling = previous.is_some_and(|previous| previous.cancel_at_end_of_cycle);
        if next.cancel_at_end_of_cycle && !was_cancelling {
            events.push(BillingEvent::CancellationScheduled {
                plan: next.plan,
                effective_at,
            });
        }
        if let Some(change) = next.scheduled
            && previous.and_then(|previous| previous.scheduled) != Some(change)
        {
            events.push(BillingEvent::ChangeScheduled {
                from: next.plan,
                to: change.plan,
                interval: change.interval,
                effective_at,
            });
        }
    }
    events
}
