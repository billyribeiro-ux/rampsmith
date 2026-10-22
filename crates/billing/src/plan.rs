//! The plan catalog: four Shopify App Pricing plans and their prices, exactly as PLAN §20
//! states them (founder-approved on 17 October 2026; changing a price needs the founder).

use std::fmt;
use std::str::FromStr;

use crate::money::Money;

/// A string is not the handle of any Rampsmith plan.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0:?} is not a Rampsmith plan handle")]
pub struct UnknownPlanHandle(pub String);

/// A Rampsmith plan. Variants are declared from the lowest tier to the highest, so the
/// derived ordering is the tier ordering: `Plan::Free < Plan::Starter < Plan::Growth < Plan::Pro`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Plan {
    /// $0. Monthly render scans of the home page and 5 pages.
    Free,
    /// $79 a month. Weekly render scans and the six core recipes as pull requests (ADR-141).
    Starter,
    /// $199 a month. Daily render scans, GitHub pull requests and every recipe.
    Growth,
    /// $499 a month. Every template variant, AI widget proposals, the priority queue.
    Pro,
}

impl Plan {
    /// Every plan, from the lowest tier to the highest.
    pub const ALL: [Self; 4] = [Self::Free, Self::Starter, Self::Growth, Self::Pro];

    /// The plan handle configured in the Partner Dashboard, returned by Shopify as the
    /// `plan_handle` redirect parameter and as the subscription item `handle`. Also the
    /// spelling stored in the database. These handles are fixed by the architect and shared
    /// with the founder setup guide; do not change them.
    #[must_use]
    pub const fn handle(self) -> &'static str {
        match self {
            Self::Free => "free",
            Self::Starter => "starter",
            Self::Growth => "growth",
            Self::Pro => "pro",
        }
    }

    /// The plan's display name.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::Free => "Free",
            Self::Starter => "Starter",
            Self::Growth => "Growth",
            Self::Pro => "Pro",
        }
    }

    /// Parses a plan handle. Matching is exact: handles are lower-case in the Partner Dashboard.
    pub fn from_handle(handle: &str) -> Result<Self, UnknownPlanHandle> {
        Self::ALL
            .into_iter()
            .find(|plan| plan.handle() == handle)
            .ok_or_else(|| UnknownPlanHandle(handle.to_owned()))
    }

    /// The plan's list price for a billing interval, in USD cents (PLAN §20). Yearly prices
    /// give two months free.
    #[must_use]
    pub const fn price(self, interval: BillingInterval) -> Money {
        let cents = match (self, interval) {
            (Self::Free, _) => 0,
            (Self::Starter, BillingInterval::Monthly) => 7_900,
            (Self::Starter, BillingInterval::Yearly) => 79_000,
            (Self::Growth, BillingInterval::Monthly) => 19_900,
            (Self::Growth, BillingInterval::Yearly) => 199_000,
            (Self::Pro, BillingInterval::Monthly) => 49_900,
            (Self::Pro, BillingInterval::Yearly) => 499_000,
        };
        Money::usd_cents(cents)
    }

    /// Whether the plan costs money.
    #[must_use]
    pub const fn is_paid(self) -> bool {
        !matches!(self, Self::Free)
    }

    /// The next plan up, if any.
    #[must_use]
    pub const fn next(self) -> Option<Self> {
        match self {
            Self::Free => Some(Self::Starter),
            Self::Starter => Some(Self::Growth),
            Self::Growth => Some(Self::Pro),
            Self::Pro => None,
        }
    }
}

impl fmt::Display for Plan {
    /// The plan handle, as stored.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.handle())
    }
}

impl FromStr for Plan {
    type Err = UnknownPlanHandle;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::from_handle(s)
    }
}

/// How often a paid plan is billed. Shopify App Pricing lets merchants toggle between the
/// two; the Partner API reports them as `AppPricingInterval` `EVERY_30_DAYS` and `ANNUAL`
/// (<https://shopify.dev/docs/api/partner/latest/enums/apppricinginterval>).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum BillingInterval {
    /// Billed every 30 days (`EVERY_30_DAYS`).
    Monthly,
    /// Billed once a year (`ANNUAL`).
    Yearly,
}

impl BillingInterval {
    /// Both intervals.
    pub const ALL: [Self; 2] = [Self::Monthly, Self::Yearly];

    /// The spelling stored in the database.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Monthly => "monthly",
            Self::Yearly => "yearly",
        }
    }

    /// The Partner API's `AppPricingInterval` value for this interval.
    #[must_use]
    pub const fn partner_api_value(self) -> &'static str {
        match self {
            Self::Monthly => "EVERY_30_DAYS",
            Self::Yearly => "ANNUAL",
        }
    }

    /// Parses the Partner API's `AppPricingInterval` value.
    #[must_use]
    pub fn from_partner_api_value(value: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|interval| interval.partner_api_value() == value)
    }
}

impl fmt::Display for BillingInterval {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handles_are_the_architect_fixed_spellings() {
        let handles: Vec<&str> = Plan::ALL.iter().map(|plan| plan.handle()).collect();
        assert_eq!(handles, ["free", "starter", "growth", "pro"]);
    }

    #[test]
    fn handles_round_trip_and_unknown_handles_are_errors() {
        for plan in Plan::ALL {
            assert_eq!(plan.handle().parse::<Plan>(), Ok(plan));
            assert_eq!(plan.to_string(), plan.handle());
        }
        for bad in ["", "Free", "PRO", "pro_plan", "enterprise", " free"] {
            assert_eq!(
                Plan::from_handle(bad),
                Err(UnknownPlanHandle(bad.to_owned()))
            );
        }
    }

    #[test]
    fn tiers_are_ordered_and_next_walks_up() {
        assert!(Plan::Free < Plan::Starter && Plan::Starter < Plan::Growth);
        assert!(Plan::Growth < Plan::Pro);
        assert_eq!(Plan::Free.next(), Some(Plan::Starter));
        assert_eq!(Plan::Growth.next(), Some(Plan::Pro));
        assert_eq!(Plan::Pro.next(), None);
        assert!(!Plan::Free.is_paid());
        assert!(Plan::Starter.is_paid() && Plan::Pro.is_paid());
    }

    #[test]
    fn interval_values_match_the_partner_api_enum() {
        assert_eq!(
            BillingInterval::from_partner_api_value("EVERY_30_DAYS"),
            Some(BillingInterval::Monthly)
        );
        assert_eq!(
            BillingInterval::from_partner_api_value("ANNUAL"),
            Some(BillingInterval::Yearly)
        );
        assert_eq!(
            BillingInterval::from_partner_api_value("every_30_days"),
            None
        );
        assert_eq!(
            BillingInterval::from_partner_api_value("EVERY_90_DAYS"),
            None
        );
        assert_eq!(BillingInterval::Yearly.to_string(), "yearly");
    }
}
