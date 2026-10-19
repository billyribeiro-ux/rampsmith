//! Entitlements: what each plan allows. [`entitlements`] is the single function the
//! scheduler, the API and the UI all read (PLAN §20), so a limit cannot differ between
//! enforcement and display. Feature gates are derived from it, never from a second table.

use std::fmt;

use crate::plan::Plan;

/// How often the scheduler runs a render scan (PLAN §20). Ordered from least to most
/// frequent, so a higher plan's cadence compares greater or equal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ScanCadence {
    /// Once a month.
    Monthly,
    /// Once a week.
    Weekly,
    /// Once a day.
    Daily,
}

impl ScanCadence {
    /// A stable identifier for storage and UI message keys.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Monthly => "monthly",
            Self::Weekly => "weekly",
            Self::Daily => "daily",
        }
    }
}

impl fmt::Display for ScanCadence {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The URLs that use one Shopify template, counted per variant: the base template and each
/// alternate template (`templateSuffix`) are separate variants (PLAN §11).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TemplatePages {
    /// Number of URLs using each variant of this template.
    pub variants: Vec<u32>,
}

impl TemplatePages {
    /// Every URL using this template, across its variants.
    #[must_use]
    pub fn total(&self) -> u64 {
        self.variants.iter().copied().map(u64::from).sum()
    }
}

/// Which pages a render scan samples (PLAN §11, §20).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RenderSampling {
    /// The home page plus this many further pages (Free: the home page and 5 pages).
    HomePagePlus {
        /// Pages rendered besides the home page.
        pages: u32,
    },
    /// Up to `samples` pages per template. With `every_variant`, each template variant gets
    /// its own `samples` (Pro: every template variant, 25 samples each).
    PerTemplate {
        /// Sample pages per template, or per variant when `every_variant` is set.
        samples: u32,
        /// Whether each `templateSuffix` variant is sampled separately.
        every_variant: bool,
    },
}

/// What Free renders. Every paid plan renders at least these pages too, so a higher plan
/// never renders fewer pages than a lower one on any store (ADR-132).
const FREE_SAMPLING: RenderSampling = RenderSampling::HomePagePlus { pages: 5 };

impl RenderSampling {
    /// The most pages one render scan may load for a store with these templates: the page
    /// budget the scheduler enforces and the UI displays.
    #[must_use]
    pub fn page_budget(self, templates: &[TemplatePages]) -> u64 {
        let total: u64 = templates.iter().map(TemplatePages::total).sum();
        match self {
            Self::HomePagePlus { pages } => total.min(1 + u64::from(pages)),
            Self::PerTemplate {
                samples,
                every_variant,
            } => {
                let cap = u64::from(samples);
                let per_template: u64 = if every_variant {
                    templates
                        .iter()
                        .flat_map(|template| template.variants.iter())
                        .map(|&pages| u64::from(pages).min(cap))
                        .sum()
                } else {
                    templates
                        .iter()
                        .map(|template| template.total().min(cap))
                        .sum()
                };
                per_template.max(FREE_SAMPLING.page_budget(templates))
            }
        }
    }

    /// Sample pages per template, when the plan samples by template.
    #[must_use]
    pub const fn samples_per_template(self) -> Option<u32> {
        match self {
            Self::HomePagePlus { .. } => None,
            Self::PerTemplate { samples, .. } => Some(samples),
        }
    }
}

/// AI alt-text drafts a plan includes (PLAN §20).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DraftAllowance {
    /// This many drafts in the shop's lifetime, never renewed (Free: "25, once").
    Lifetime(u32),
    /// This many drafts in each monthly allowance window (ADR-133).
    Monthly(u32),
}

impl DraftAllowance {
    /// The number of drafts in one allowance.
    #[must_use]
    pub const fn limit(self) -> u32 {
        match self {
            Self::Lifetime(limit) | Self::Monthly(limit) => limit,
        }
    }

    /// Whether this allowance gives at least as many drafts as `other` over any span of time:
    /// a monthly allowance renews, so it beats a lifetime one with the same or smaller limit.
    #[must_use]
    pub const fn is_at_least(self, other: Self) -> bool {
        match (self, other) {
            (Self::Monthly(a), Self::Monthly(b) | Self::Lifetime(b))
            | (Self::Lifetime(a), Self::Lifetime(b)) => a >= b,
            (Self::Lifetime(_), Self::Monthly(b)) => b == 0,
        }
    }
}

/// Product images whose alt text a plan may fix through the Admin API (PLAN §20).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ImageFixAllowance {
    /// Only the shop's first this-many images (Free: the first 25).
    FirstImages(u32),
    /// Every image.
    Unlimited,
}

impl ImageFixAllowance {
    /// Whether one more image may be fixed after `already_fixed` images.
    #[must_use]
    pub const fn permits_another(self, already_fixed: u32) -> bool {
        match self {
            Self::FirstImages(limit) => already_fixed < limit,
            Self::Unlimited => true,
        }
    }

    /// Whether this allowance covers at least as many images as `other`.
    #[must_use]
    pub const fn is_at_least(self, other: Self) -> bool {
        match (self, other) {
            (Self::Unlimited, _) => true,
            (Self::FirstImages(_), Self::Unlimited) => false,
            (Self::FirstImages(a), Self::FirstImages(b)) => a >= b,
        }
    }
}

/// A plan-gated capability, as the UI lists it. Limits (pages, drafts, images) are fields of
/// [`Entitlements`], not features.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Feature {
    /// Store data fixes through the Admin API (Free: alt text on the first 25 images).
    DataFixes,
    /// The six core recipes for the most common failures (PLAN §12).
    CoreRecipes,
    /// The patched theme package channel.
    ThemePackage,
    /// The GitHub pull-request channel.
    GithubPullRequests,
    /// Every recipe in the catalog, beyond the six core ones.
    EveryRecipe,
    /// AI-drafted product description and page rewrites.
    DescriptionRewrites,
    /// Alerts when a new failure appears after a change.
    RegressionAlerts,
    /// AI-proposed patches for custom widgets.
    AiWidgetProposals,
    /// Accessibility statements in several languages.
    MultiLanguageStatements,
    /// Scans and fixes ahead of other plans in the queue.
    PriorityQueue,
}

impl Feature {
    /// Every feature, in the order the UI lists them.
    pub const ALL: [Self; 10] = [
        Self::DataFixes,
        Self::CoreRecipes,
        Self::ThemePackage,
        Self::GithubPullRequests,
        Self::EveryRecipe,
        Self::DescriptionRewrites,
        Self::RegressionAlerts,
        Self::AiWidgetProposals,
        Self::MultiLanguageStatements,
        Self::PriorityQueue,
    ];

    /// A stable identifier for API payloads and UI message keys. UI text itself lives in the
    /// web app's message catalogs (PLAN §8), never here.
    #[must_use]
    pub const fn key(self) -> &'static str {
        match self {
            Self::DataFixes => "data_fixes",
            Self::CoreRecipes => "core_recipes",
            Self::ThemePackage => "theme_package",
            Self::GithubPullRequests => "github_pull_requests",
            Self::EveryRecipe => "every_recipe",
            Self::DescriptionRewrites => "description_rewrites",
            Self::RegressionAlerts => "regression_alerts",
            Self::AiWidgetProposals => "ai_widget_proposals",
            Self::MultiLanguageStatements => "multi_language_statements",
            Self::PriorityQueue => "priority_queue",
        }
    }

    const fn bit(self) -> u16 {
        1 << self as u16
    }
}

impl fmt::Display for Feature {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.key())
    }
}

/// A set of features.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Default)]
pub struct FeatureSet(u16);

impl FeatureSet {
    /// No features.
    pub const EMPTY: Self = Self(0);

    /// This set plus `feature`.
    #[must_use]
    pub const fn with(self, feature: Feature) -> Self {
        Self(self.0 | feature.bit())
    }

    /// Whether the set holds `feature`.
    #[must_use]
    pub const fn contains(self, feature: Feature) -> bool {
        self.0 & feature.bit() != 0
    }

    /// Whether every feature in this set is also in `other`.
    #[must_use]
    pub const fn is_subset_of(self, other: Self) -> bool {
        self.0 & !other.0 == 0
    }

    /// The features in the set, in [`Feature::ALL`] order.
    pub fn iter(self) -> impl Iterator<Item = Feature> {
        Feature::ALL
            .into_iter()
            .filter(move |&feature| self.contains(feature))
    }
}

impl fmt::Debug for FeatureSet {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_set().entries(self.iter()).finish()
    }
}

/// Everything one plan allows. Only [`entitlements`] creates it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Entitlements {
    plan: Plan,
    render_cadence: ScanCadence,
    render_sampling: RenderSampling,
    alt_text_drafts: DraftAllowance,
    image_fixes: ImageFixAllowance,
    features: FeatureSet,
}

impl Entitlements {
    /// The plan these entitlements belong to.
    #[must_use]
    pub const fn plan(&self) -> Plan {
        self.plan
    }

    /// How often render scans run.
    #[must_use]
    pub const fn render_cadence(&self) -> ScanCadence {
        self.render_cadence
    }

    /// Which pages a render scan samples.
    #[must_use]
    pub const fn render_sampling(&self) -> RenderSampling {
        self.render_sampling
    }

    /// AI alt-text drafts included.
    #[must_use]
    pub const fn alt_text_drafts(&self) -> DraftAllowance {
        self.alt_text_drafts
    }

    /// Images whose alt text may be fixed.
    #[must_use]
    pub const fn image_fixes(&self) -> ImageFixAllowance {
        self.image_fixes
    }

    /// The plan-gated features included.
    #[must_use]
    pub const fn features(&self) -> FeatureSet {
        self.features
    }

    /// Whether `feature` is included.
    #[must_use]
    pub const fn allows(&self, feature: Feature) -> bool {
        self.features.contains(feature)
    }
}

/// The single source of every plan limit (PLAN §20).
#[must_use]
pub const fn entitlements(plan: Plan) -> Entitlements {
    let free_features = FeatureSet::EMPTY.with(Feature::DataFixes);
    let starter_features = free_features
        .with(Feature::CoreRecipes)
        .with(Feature::ThemePackage);
    let growth_features = starter_features
        .with(Feature::GithubPullRequests)
        .with(Feature::EveryRecipe)
        .with(Feature::DescriptionRewrites)
        .with(Feature::RegressionAlerts);
    let pro_features = growth_features
        .with(Feature::AiWidgetProposals)
        .with(Feature::MultiLanguageStatements)
        .with(Feature::PriorityQueue);

    match plan {
        Plan::Free => Entitlements {
            plan,
            render_cadence: ScanCadence::Monthly,
            render_sampling: FREE_SAMPLING,
            alt_text_drafts: DraftAllowance::Lifetime(25),
            image_fixes: ImageFixAllowance::FirstImages(25),
            features: free_features,
        },
        Plan::Starter => Entitlements {
            plan,
            render_cadence: ScanCadence::Weekly,
            render_sampling: RenderSampling::PerTemplate {
                samples: 3,
                every_variant: false,
            },
            alt_text_drafts: DraftAllowance::Monthly(2_000),
            image_fixes: ImageFixAllowance::Unlimited,
            features: starter_features,
        },
        Plan::Growth => Entitlements {
            plan,
            render_cadence: ScanCadence::Daily,
            render_sampling: RenderSampling::PerTemplate {
                samples: 10,
                every_variant: false,
            },
            alt_text_drafts: DraftAllowance::Monthly(10_000),
            image_fixes: ImageFixAllowance::Unlimited,
            features: growth_features,
        },
        Plan::Pro => Entitlements {
            plan,
            render_cadence: ScanCadence::Daily,
            render_sampling: RenderSampling::PerTemplate {
                samples: 25,
                every_variant: true,
            },
            alt_text_drafts: DraftAllowance::Monthly(50_000),
            image_fixes: ImageFixAllowance::Unlimited,
            features: pro_features,
        },
    }
}

/// Whether a plan may use something, and if not, which plan unlocks it. Built for Shopify
/// requirement 4.3.7 says plan-gated features must be disabled visually and functionally and
/// make obvious which tier unlocks them
/// (<https://shopify.dev/docs/apps/launch/built-for-shopify/requirements>), so a locked gate
/// always names the lowest plan that unlocks it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Gate {
    /// The current plan allows it.
    Allowed,
    /// Locked; `unlocked_by` is the lowest plan that allows it.
    Locked {
        /// The lowest plan that allows it.
        unlocked_by: Plan,
    },
    /// No plan allows it (for example, more images than any plan covers).
    Unavailable,
}

impl Gate {
    /// Whether the gate is open.
    #[must_use]
    pub const fn is_allowed(self) -> bool {
        matches!(self, Self::Allowed)
    }
}

/// Evaluates a gate: allowed if `plan` passes `test`, otherwise the lowest plan that does.
fn gate_by(plan: Plan, test: impl Fn(&Entitlements) -> bool) -> Gate {
    if test(&entitlements(plan)) {
        return Gate::Allowed;
    }
    Plan::ALL
        .into_iter()
        .find(|&candidate| test(&entitlements(candidate)))
        .map_or(Gate::Unavailable, |unlocked_by| Gate::Locked {
            unlocked_by,
        })
}

/// The gate for one feature on one plan.
#[must_use]
pub fn feature_gate(plan: Plan, feature: Feature) -> Gate {
    gate_by(plan, |granted| granted.allows(feature))
}

/// Every feature with its gate on `plan`, in UI order: the list the UI renders, with locked
/// features shown, labelled with their plan and disabled.
#[must_use]
pub fn feature_gates(plan: Plan) -> [(Feature, Gate); Feature::ALL.len()] {
    Feature::ALL.map(|feature| (feature, feature_gate(plan, feature)))
}

/// The lowest plan that includes `feature`.
#[must_use]
pub fn minimum_plan(feature: Feature) -> Option<Plan> {
    Plan::ALL
        .into_iter()
        .find(|&plan| entitlements(plan).allows(feature))
}

/// The gate for fixing one more image's alt text after `already_fixed` images.
#[must_use]
pub fn image_fix_gate(plan: Plan, already_fixed: u32) -> Gate {
    gate_by(plan, |granted| {
        granted.image_fixes().permits_another(already_fixed)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn templates(shape: &[&[u32]]) -> Vec<TemplatePages> {
        shape
            .iter()
            .map(|variants| TemplatePages {
                variants: variants.to_vec(),
            })
            .collect()
    }

    #[test]
    fn free_renders_the_home_page_and_five_more() {
        let budget = |shape: &[&[u32]]| FREE_SAMPLING.page_budget(&templates(shape));
        assert_eq!(budget(&[&[1], &[40], &[12]]), 6);
        assert_eq!(budget(&[&[1], &[2]]), 3, "a store smaller than the budget");
        assert_eq!(budget(&[]), 0);
    }

    #[test]
    fn per_template_sampling_caps_each_template() {
        let shape = templates(&[&[1], &[40, 7], &[2], &[30]]);
        let starter = RenderSampling::PerTemplate {
            samples: 3,
            every_variant: false,
        };
        assert_eq!(starter.page_budget(&shape), 1 + 3 + 2 + 3);
        let pro = RenderSampling::PerTemplate {
            samples: 25,
            every_variant: true,
        };
        assert_eq!(pro.page_budget(&shape), 1 + 25 + 7 + 2 + 25);
    }

    #[test]
    fn paid_sampling_never_renders_less_than_free() {
        // One template with many pages: three samples would be fewer than Free's six.
        let shape = templates(&[&[100]]);
        let starter = RenderSampling::PerTemplate {
            samples: 3,
            every_variant: false,
        };
        assert_eq!(starter.page_budget(&shape), 6);
    }

    #[test]
    fn feature_sets_behave_like_sets() {
        let set = FeatureSet::EMPTY
            .with(Feature::DataFixes)
            .with(Feature::PriorityQueue);
        assert!(set.contains(Feature::DataFixes));
        assert!(!set.contains(Feature::ThemePackage));
        assert!(FeatureSet::EMPTY.is_subset_of(set));
        assert!(!set.is_subset_of(FeatureSet::EMPTY.with(Feature::DataFixes)));
        assert_eq!(
            set.iter().collect::<Vec<_>>(),
            [Feature::DataFixes, Feature::PriorityQueue]
        );
        assert_eq!(format!("{set:?}"), "{DataFixes, PriorityQueue}");
    }

    #[test]
    fn locked_gates_name_the_lowest_unlocking_plan() {
        assert_eq!(
            feature_gate(Plan::Free, Feature::ThemePackage),
            Gate::Locked {
                unlocked_by: Plan::Starter
            }
        );
        assert_eq!(
            feature_gate(Plan::Starter, Feature::AiWidgetProposals),
            Gate::Locked {
                unlocked_by: Plan::Pro
            }
        );
        assert_eq!(
            feature_gate(Plan::Growth, Feature::GithubPullRequests),
            Gate::Allowed
        );
        assert!(feature_gate(Plan::Pro, Feature::PriorityQueue).is_allowed());
    }

    #[test]
    fn image_fixes_past_the_free_limit_need_starter() {
        assert_eq!(image_fix_gate(Plan::Free, 0), Gate::Allowed);
        assert_eq!(image_fix_gate(Plan::Free, 24), Gate::Allowed);
        assert_eq!(
            image_fix_gate(Plan::Free, 25),
            Gate::Locked {
                unlocked_by: Plan::Starter
            }
        );
        assert_eq!(image_fix_gate(Plan::Starter, u32::MAX), Gate::Allowed);
    }

    #[test]
    fn a_gate_no_plan_opens_is_unavailable() {
        assert_eq!(gate_by(Plan::Pro, |_| false), Gate::Unavailable);
    }

    #[test]
    fn draft_allowances_compare_by_what_they_give_over_time() {
        use DraftAllowance::{Lifetime, Monthly};
        assert!(Monthly(2_000).is_at_least(Lifetime(25)));
        assert!(Monthly(25).is_at_least(Lifetime(25)));
        assert!(!Lifetime(25).is_at_least(Monthly(25)));
        assert!(Lifetime(25).is_at_least(Monthly(0)));
        assert!(!Monthly(2_000).is_at_least(Monthly(10_000)));
        assert!(Lifetime(30).is_at_least(Lifetime(25)));
    }
}
