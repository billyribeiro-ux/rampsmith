//! Property tests: a higher plan never has a smaller limit or fewer features than a lower
//! one, on any store (PLAN §20, §23).

use billing::entitlements::{Feature, TemplatePages, entitlements, feature_gate, image_fix_gate};
use billing::{BillingInterval, Plan};
use proptest::prelude::*;

fn plan() -> impl Strategy<Value = Plan> {
    prop::sample::select(Plan::ALL.to_vec())
}

/// Two plans, the first no higher than the second.
fn ordered_plans() -> impl Strategy<Value = (Plan, Plan)> {
    (plan(), plan()).prop_map(|(a, b)| if a <= b { (a, b) } else { (b, a) })
}

/// A store's templates: up to 12 templates, each with 1 to 5 variants of up to 400 pages.
fn store() -> impl Strategy<Value = Vec<TemplatePages>> {
    prop::collection::vec(
        prop::collection::vec(0_u32..400, 1..=5).prop_map(|variants| TemplatePages { variants }),
        0..=12,
    )
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    #[test]
    fn a_higher_plan_has_every_feature_of_a_lower_one((low, high) in ordered_plans()) {
        let (low_set, high_set) = (entitlements(low).features(), entitlements(high).features());
        prop_assert!(low_set.is_subset_of(high_set), "{low:?} {low_set:?} vs {high:?} {high_set:?}");
        for feature in Feature::ALL {
            if feature_gate(low, feature).is_allowed() {
                prop_assert!(feature_gate(high, feature).is_allowed(), "{feature:?}");
            }
        }
    }

    #[test]
    fn a_higher_plan_scans_at_least_as_often((low, high) in ordered_plans()) {
        prop_assert!(entitlements(high).render_cadence() >= entitlements(low).render_cadence());
    }

    #[test]
    fn a_higher_plan_never_renders_fewer_pages((low, high) in ordered_plans(), templates in store()) {
        let low_budget = entitlements(low).render_sampling().page_budget(&templates);
        let high_budget = entitlements(high).render_sampling().page_budget(&templates);
        prop_assert!(high_budget >= low_budget, "{low:?} {low_budget} > {high:?} {high_budget}");
        let total: u64 = templates.iter().map(TemplatePages::total).sum();
        prop_assert!(high_budget <= total, "a budget never exceeds the store");
    }

    #[test]
    fn a_higher_plan_has_at_least_as_many_alt_text_drafts((low, high) in ordered_plans()) {
        let (low_drafts, high_drafts) =
            (entitlements(low).alt_text_drafts(), entitlements(high).alt_text_drafts());
        prop_assert!(high_drafts.is_at_least(low_drafts), "{low_drafts:?} vs {high_drafts:?}");
        prop_assert!(high_drafts.limit() >= low_drafts.limit());
    }

    #[test]
    fn a_higher_plan_fixes_at_least_as_many_images((low, high) in ordered_plans(), fixed in any::<u32>()) {
        prop_assert!(entitlements(high).image_fixes().is_at_least(entitlements(low).image_fixes()));
        prop_assert!(entitlements(high).ai_budget_micro_usd() >= entitlements(low).ai_budget_micro_usd());
        prop_assert!(entitlements(high).manual_scans_per_day() >= entitlements(low).manual_scans_per_day());
        if image_fix_gate(low, fixed).is_allowed() {
            prop_assert!(image_fix_gate(high, fixed).is_allowed());
        }
    }

    #[test]
    fn a_higher_plan_never_costs_less((low, high) in ordered_plans()) {
        for interval in BillingInterval::ALL {
            prop_assert!(high.price(interval).minor_units() >= low.price(interval).minor_units());
        }
    }
}
