//! Every cell of the PLAN §20 plan table, asserted against the catalog and the single
//! entitlements function. If one of these fails, either the code or the founder-approved
//! pricing changed; the latter needs the founder.

use billing::entitlements::{
    DraftAllowance, Feature, Gate, ImageFixAllowance, RenderSampling, ScanCadence, entitlements,
    feature_gate, feature_gates, minimum_plan,
};
use billing::{BillingInterval, Currency, Plan};

/// One row of PLAN §20, transcribed by hand.
struct Row {
    plan: Plan,
    monthly_cents: i64,
    yearly_cents: i64,
    cadence: ScanCadence,
    sampling: RenderSampling,
    drafts: DraftAllowance,
    image_fixes: ImageFixAllowance,
    features: &'static [Feature],
}

const PLAN_20: [Row; 4] = [
    // | Free | $0 | $0 | Monthly; home page and 5 pages | Data fixes for the first 25 images | 25, once |
    Row {
        plan: Plan::Free,
        monthly_cents: 0,
        yearly_cents: 0,
        cadence: ScanCadence::Monthly,
        sampling: RenderSampling::HomePagePlus { pages: 5 },
        drafts: DraftAllowance::Lifetime(25),
        image_fixes: ImageFixAllowance::FirstImages(25),
        features: &[Feature::DataFixes],
    },
    // | Starter | $79 | $790 | Weekly; 3 samples per template |
    // | Data fixes; patched theme package with the 6 core recipes | 2,000 |
    Row {
        plan: Plan::Starter,
        monthly_cents: 7_900,
        yearly_cents: 79_000,
        cadence: ScanCadence::Weekly,
        sampling: RenderSampling::PerTemplate {
            samples: 3,
            every_variant: false,
        },
        drafts: DraftAllowance::Monthly(2_000),
        image_fixes: ImageFixAllowance::Unlimited,
        features: &[
            Feature::DataFixes,
            Feature::CoreRecipes,
            Feature::ThemePackage,
        ],
    },
    // | Growth | $199 | $1,990 | Daily; 10 samples per template |
    // | Adds GitHub pull requests, every recipe, description rewrites, regression alerts | 10,000 |
    Row {
        plan: Plan::Growth,
        monthly_cents: 19_900,
        yearly_cents: 199_000,
        cadence: ScanCadence::Daily,
        sampling: RenderSampling::PerTemplate {
            samples: 10,
            every_variant: false,
        },
        drafts: DraftAllowance::Monthly(10_000),
        image_fixes: ImageFixAllowance::Unlimited,
        features: &[
            Feature::DataFixes,
            Feature::CoreRecipes,
            Feature::ThemePackage,
            Feature::GithubPullRequests,
            Feature::EveryRecipe,
            Feature::DescriptionRewrites,
            Feature::RegressionAlerts,
        ],
    },
    // | Pro | $499 | $4,990 | Daily; every template variant, 25 samples each |
    // | Adds AI proposals for custom widgets, multi-language statements, priority queue | 50,000 |
    Row {
        plan: Plan::Pro,
        monthly_cents: 49_900,
        yearly_cents: 499_000,
        cadence: ScanCadence::Daily,
        sampling: RenderSampling::PerTemplate {
            samples: 25,
            every_variant: true,
        },
        drafts: DraftAllowance::Monthly(50_000),
        image_fixes: ImageFixAllowance::Unlimited,
        features: &[
            Feature::DataFixes,
            Feature::CoreRecipes,
            Feature::ThemePackage,
            Feature::GithubPullRequests,
            Feature::EveryRecipe,
            Feature::DescriptionRewrites,
            Feature::RegressionAlerts,
            Feature::AiWidgetProposals,
            Feature::MultiLanguageStatements,
            Feature::PriorityQueue,
        ],
    },
];

#[test]
fn the_table_covers_every_plan_once_in_tier_order() {
    let plans: Vec<Plan> = PLAN_20.iter().map(|row| row.plan).collect();
    assert_eq!(plans, Plan::ALL);
}

#[test]
fn prices_match_plan_20_in_usd_cents() {
    for row in &PLAN_20 {
        let monthly = row.plan.price(BillingInterval::Monthly);
        let yearly = row.plan.price(BillingInterval::Yearly);
        assert_eq!(
            monthly.minor_units(),
            row.monthly_cents,
            "{:?} monthly",
            row.plan
        );
        assert_eq!(
            yearly.minor_units(),
            row.yearly_cents,
            "{:?} yearly",
            row.plan
        );
        assert_eq!(monthly.currency(), Currency::USD);
        assert_eq!(yearly.currency(), Currency::USD);
    }
}

#[test]
fn yearly_prices_give_two_months_free() {
    for row in &PLAN_20 {
        assert_eq!(row.yearly_cents, row.monthly_cents * 10, "{:?}", row.plan);
    }
}

#[test]
fn render_scans_match_plan_20() {
    for row in &PLAN_20 {
        let granted = entitlements(row.plan);
        assert_eq!(granted.plan(), row.plan);
        assert_eq!(granted.render_cadence(), row.cadence, "{:?}", row.plan);
        assert_eq!(granted.render_sampling(), row.sampling, "{:?}", row.plan);
    }
}

#[test]
fn samples_per_template_match_plan_11() {
    let samples: Vec<Option<u32>> = Plan::ALL
        .iter()
        .map(|&plan| entitlements(plan).render_sampling().samples_per_template())
        .collect();
    assert_eq!(samples, [None, Some(3), Some(10), Some(25)]);
}

#[test]
fn alt_text_drafts_match_plan_20() {
    for row in &PLAN_20 {
        assert_eq!(
            entitlements(row.plan).alt_text_drafts(),
            row.drafts,
            "{:?}",
            row.plan
        );
    }
}

#[test]
fn fix_channels_and_features_match_plan_20_exactly() {
    for row in &PLAN_20 {
        let granted = entitlements(row.plan);
        assert_eq!(granted.image_fixes(), row.image_fixes, "{:?}", row.plan);
        let features: Vec<Feature> = granted.features().iter().collect();
        assert_eq!(features, row.features, "{:?}", row.plan);
    }
}

#[test]
fn every_plan_and_feature_cell_has_the_expected_gate() {
    for row in &PLAN_20 {
        for feature in Feature::ALL {
            let expected = if row.features.contains(&feature) {
                Gate::Allowed
            } else {
                let unlocked_by = PLAN_20
                    .iter()
                    .find(|candidate| candidate.features.contains(&feature))
                    .map(|candidate| candidate.plan)
                    .expect("every feature is on some plan");
                Gate::Locked { unlocked_by }
            };
            assert_eq!(
                feature_gate(row.plan, feature),
                expected,
                "{:?} {feature:?}",
                row.plan
            );
        }
        let listed: Vec<Feature> = feature_gates(row.plan).iter().map(|(f, _)| *f).collect();
        assert_eq!(
            listed,
            Feature::ALL,
            "the UI lists every feature, locked or not"
        );
    }
}

#[test]
fn every_feature_has_a_minimum_plan() {
    let expected = [
        (Feature::DataFixes, Plan::Free),
        (Feature::CoreRecipes, Plan::Starter),
        (Feature::ThemePackage, Plan::Starter),
        (Feature::GithubPullRequests, Plan::Growth),
        (Feature::EveryRecipe, Plan::Growth),
        (Feature::DescriptionRewrites, Plan::Growth),
        (Feature::RegressionAlerts, Plan::Growth),
        (Feature::AiWidgetProposals, Plan::Pro),
        (Feature::MultiLanguageStatements, Plan::Pro),
        (Feature::PriorityQueue, Plan::Pro),
    ];
    assert_eq!(expected.len(), Feature::ALL.len());
    for (feature, plan) in expected {
        assert_eq!(minimum_plan(feature), Some(plan), "{feature:?}");
    }
}

#[test]
fn feature_keys_are_unique_snake_case() {
    let mut keys: Vec<&str> = Feature::ALL.iter().map(|feature| feature.key()).collect();
    assert!(
        keys.iter()
            .all(|key| key.bytes().all(|b| b.is_ascii_lowercase() || b == b'_'))
    );
    keys.sort_unstable();
    keys.dedup();
    assert_eq!(keys.len(), Feature::ALL.len());
}
