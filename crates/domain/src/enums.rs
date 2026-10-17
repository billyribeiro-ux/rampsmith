//! Closed sets of values stored as text in PostgreSQL. Each spelling here must match the
//! table's `check` constraint (PLAN §9); the database tests insert every variant to prove it.

use std::fmt;
use std::str::FromStr;

/// A string did not name any variant of the enum it was parsed into.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnknownVariant {
    type_name: &'static str,
    input: String,
}

impl fmt::Display for UnknownVariant {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?} is not a valid {}", self.input, self.type_name)
    }
}

impl std::error::Error for UnknownVariant {}

macro_rules! string_enum {
    (
        $(#[$doc:meta])*
        pub enum $name:ident { $( $(#[$vdoc:meta])* $variant:ident => $text:literal ),+ $(,)? }
    ) => {
        $(#[$doc])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        pub enum $name { $( $(#[$vdoc])* $variant ),+ }

        impl $name {
            /// Every variant, in declaration order.
            pub const ALL: [Self; [$(stringify!($variant)),+].len()] = [$(Self::$variant),+];

            /// The spelling stored in the database.
            #[must_use]
            pub const fn as_str(self) -> &'static str {
                match self { $(Self::$variant => $text),+ }
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(self.as_str())
            }
        }

        impl FromStr for $name {
            type Err = UnknownVariant;

            fn from_str(s: &str) -> Result<Self, Self::Err> {
                match s {
                    $($text => Ok(Self::$variant),)+
                    _ => Err(UnknownVariant { type_name: stringify!($name), input: s.to_owned() }),
                }
            }
        }
    };
}

string_enum! {
    /// What a tenant is.
    pub enum TenantKind {
        /// One Shopify store, created at install.
        ShopifyStore => "shopify_store",
        /// An agency or company using the standalone dashboard.
        Organization => "organization",
    }
}

string_enum! {
    /// The platform a site runs on.
    pub enum Platform {
        /// A Shopify Online Store.
        Shopify => "shopify",
        /// A WordPress site (phase 2).
        Wordpress => "wordpress",
        /// A site built from a Git repository (phase 3).
        Git => "git",
        /// Any other verified site.
        Generic => "generic",
    }
}

string_enum! {
    /// Installation state of a Shopify shop.
    pub enum ShopStatus {
        /// The app is installed.
        Installed => "installed",
        /// The app was uninstalled; the retention clock is running.
        Uninstalled => "uninstalled",
        /// The shop's data was redacted after `shop/redact`.
        Redacted => "redacted",
    }
}

string_enum! {
    /// Why a scan started.
    pub enum ScanTrigger {
        /// A person asked for it.
        Manual => "manual",
        /// The schedule ran it.
        Scheduled => "scheduled",
        /// A webhook, such as `themes/publish`, ran it.
        Webhook => "webhook",
        /// It verifies an applied fix.
        Verify => "verify",
        /// The public free scanner ran it.
        Free => "free",
    }
}

string_enum! {
    /// Lifecycle of a scan.
    pub enum ScanStatus {
        /// Waiting for a worker.
        Queued => "queued",
        /// Pages are being scanned.
        Running => "running",
        /// Every planned page was scanned.
        Succeeded => "succeeded",
        /// Some pages could not be scanned; the rest were.
        Partial => "partial",
        /// The scan could not complete.
        Failed => "failed",
        /// Someone stopped it.
        Cancelled => "cancelled",
    }
}

impl ScanStatus {
    /// Whether the scan has finished and will not change state again.
    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Succeeded | Self::Partial | Self::Failed | Self::Cancelled
        )
    }
}

string_enum! {
    /// Where a finding stands.
    pub enum FindingStatus {
        /// Detected and not yet resolved.
        Open => "open",
        /// A verification scan confirmed the fix.
        Fixed => "fixed",
        /// Automation was unsure; a person must look.
        NeedsReview => "needs_review",
        /// The merchant chose not to fix it, with a reason.
        AcceptedRisk => "accepted_risk",
        /// The merchant marked it as not a real failure.
        FalsePositive => "false_positive",
    }
}

string_enum! {
    /// What a fix changes.
    pub enum FixKind {
        /// Store data such as alt text or a product description.
        Data => "data",
        /// Theme source code.
        Code => "code",
    }
}

string_enum! {
    /// How a fix reaches the store (ADR-004).
    pub enum FixChannel {
        /// Written through the Admin GraphQL API after approval.
        AdminApi => "admin_api",
        /// Proposed as a pull request against the connected theme repository.
        GithubPr => "github_pr",
        /// Delivered in a patched theme package the merchant installs.
        ThemePackage => "theme_package",
    }
}

impl FixChannel {
    /// Whether this channel can deliver a fix of `kind`: data fixes only through the
    /// Admin API, code fixes only through a pull request or a theme package.
    #[must_use]
    pub const fn carries(self, kind: FixKind) -> bool {
        matches!(
            (self, kind),
            (Self::AdminApi, FixKind::Data) | (Self::GithubPr | Self::ThemePackage, FixKind::Code)
        )
    }
}

string_enum! {
    /// Lifecycle of a fix.
    pub enum FixStatus {
        /// Drafted and waiting for approval.
        Proposed => "proposed",
        /// Approved by a person.
        Approved => "approved",
        /// Being written to the store or the repository.
        Applying => "applying",
        /// Written; not yet verified.
        Applied => "applied",
        /// A verification scan confirmed it.
        Verified => "verified",
        /// Applying or verifying it failed.
        Failed => "failed",
        /// Undone.
        Reverted => "reverted",
        /// A person declined it.
        Rejected => "rejected",
    }
}

string_enum! {
    /// Who wrote a fix.
    pub enum FixOrigin {
        /// A deterministic recipe.
        Rule => "rule",
        /// A Claude model; always needs human approval.
        Ai => "ai",
        /// A person.
        Human => "human",
    }
}

string_enum! {
    /// Who performed an audited action.
    pub enum ActorKind {
        /// A signed-in person.
        User => "user",
        /// Rampsmith itself, such as a scheduled job.
        System => "system",
        /// Shopify, through a webhook.
        Shopify => "shopify",
        /// GitHub, through a webhook.
        Github => "github",
        /// A Rampsmith operator, through `rsctl`.
        Operator => "operator",
    }
}

string_enum! {
    /// The interactive state a page was in when it was checked (PLAN §5, R1).
    pub enum PageState {
        /// As loaded.
        Default => "default",
        /// Main navigation opened by keyboard.
        NavOpen => "nav_open",
        /// Cart drawer open after add-to-cart.
        CartDrawer => "cart_drawer",
        /// A variant picker changed.
        VariantChanged => "variant_changed",
        /// The first modal or popup found.
        Modal => "modal",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round_trip<T>(all: &[T])
    where
        T: Copy + PartialEq + fmt::Debug + FromStr + fmt::Display,
        <T as FromStr>::Err: fmt::Debug,
    {
        for value in all {
            assert_eq!(value.to_string().parse::<T>().unwrap(), *value);
        }
    }

    #[test]
    fn every_enum_round_trips_through_its_database_spelling() {
        round_trip(&TenantKind::ALL);
        round_trip(&Platform::ALL);
        round_trip(&ShopStatus::ALL);
        round_trip(&ScanTrigger::ALL);
        round_trip(&ScanStatus::ALL);
        round_trip(&FindingStatus::ALL);
        round_trip(&FixKind::ALL);
        round_trip(&FixChannel::ALL);
        round_trip(&FixStatus::ALL);
        round_trip(&FixOrigin::ALL);
        round_trip(&ActorKind::ALL);
        round_trip(&PageState::ALL);
    }

    #[test]
    fn spellings_match_the_plan() {
        assert_eq!(TenantKind::ShopifyStore.as_str(), "shopify_store");
        assert_eq!(ScanStatus::Partial.as_str(), "partial");
        assert_eq!(FindingStatus::AcceptedRisk.as_str(), "accepted_risk");
        assert_eq!(FixChannel::GithubPr.as_str(), "github_pr");
        assert_eq!(PageState::VariantChanged.as_str(), "variant_changed");
    }

    #[test]
    fn unknown_spellings_are_rejected_with_the_type_name() {
        let err = "half_done".parse::<ScanStatus>().unwrap_err();
        assert!(err.to_string().contains("ScanStatus"), "{err}");
    }

    #[test]
    fn only_data_fixes_go_through_the_admin_api() {
        assert!(FixChannel::AdminApi.carries(FixKind::Data));
        assert!(!FixChannel::AdminApi.carries(FixKind::Code));
        assert!(FixChannel::GithubPr.carries(FixKind::Code));
        assert!(FixChannel::ThemePackage.carries(FixKind::Code));
        assert!(!FixChannel::ThemePackage.carries(FixKind::Data));
    }

    #[test]
    fn terminal_scan_states_are_exactly_the_finished_ones() {
        let terminal: Vec<ScanStatus> = ScanStatus::ALL
            .into_iter()
            .filter(|s| s.is_terminal())
            .collect();
        assert_eq!(
            terminal,
            vec![
                ScanStatus::Succeeded,
                ScanStatus::Partial,
                ScanStatus::Failed,
                ScanStatus::Cancelled
            ]
        );
    }
}
