//! The founder inputs `rsctl doctor` may read: every variable in LAUNCH.md section C, rows 1
//! to 12 and row 16, and nothing else (ADR-151, ADR-093). A probe asks for a [`Var`], never a
//! string, and the test suite records every read to prove each probe stays inside its declared
//! set.
//!
//! [`founder_secret_names`] is the one list of founder secret names. The `secrets-scope` job of
//! `.github/workflows/ci.yml` checks that none of them exists as a repository or organization
//! secret, and a test (`tests/secret_placement.rs`) keeps the job's list equal to this one.

use std::collections::BTreeMap;
use std::sync::Arc;

use crate::secret::{Redactor, Secret};

/// One documented environment variable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Var {
    // Row 1: Shopify app credentials.
    ShopifyApiKey,
    ShopifyApiSecret,
    // Row 2: Partner API and App Automation Token.
    ShopifyPartnerApiToken,
    ShopifyPartnerOrgId,
    ShopifyAppAutomationToken,
    ShopifyAppGid,
    // Row 3: development stores.
    ShopifyDevStoreDomain,
    ShopifyDevStorePassword,
    ShopifyDevStoreBDomain,
    ShopifyDevStoreBPassword,
    // Row 4: GitHub App.
    GithubAppId,
    GithubAppClientId,
    GithubAppPrivateKey,
    GithubAppWebhookSecret,
    // Row 5: Anthropic.
    AnthropicApiKey,
    // Row 6: Cloudflare R2 and Turnstile.
    R2AccountId,
    R2AccessKeyId,
    R2SecretAccessKey,
    R2BucketEvidence,
    R2BucketBackups,
    TurnstileSiteKey,
    TurnstileSecretKey,
    // Row 7: Amazon SES.
    SesRegion,
    SesAccessKeyId,
    SesSecretAccessKey,
    EmailFrom,
    // Row 8: Railway.
    RailwayToken,
    RailwayApiToken,
    // Row 9: Grafana Cloud OTLP.
    OtelExporterOtlpEndpoint,
    OtelExporterOtlpHeaders,
    OtelExporterOtlpProtocol,
    // Row 10: Cloudflare DNS.
    CloudflareApiToken,
    // Row 11: Stripe.
    StripeSecretKey,
    StripePublishableKey,
    StripeWebhookSecret,
    // Row 12: master keys.
    RampsmithMasterKeys,
    // Row 16: the nightly backup service and the weekly restore drill (ADR-090 to ADR-093).
    BackupR2AccessKeyId,
    BackupR2SecretAccessKey,
    BackupDbPassword,
    BackupAgeRecipients,
    DrillR2AccessKeyId,
    DrillR2SecretAccessKey,
    BackupDrillAgeKey,
}

impl Var {
    /// Every variable, in LAUNCH.md order.
    pub const ALL: &'static [Self] = &[
        Self::ShopifyApiKey,
        Self::ShopifyApiSecret,
        Self::ShopifyPartnerApiToken,
        Self::ShopifyPartnerOrgId,
        Self::ShopifyAppAutomationToken,
        Self::ShopifyAppGid,
        Self::ShopifyDevStoreDomain,
        Self::ShopifyDevStorePassword,
        Self::ShopifyDevStoreBDomain,
        Self::ShopifyDevStoreBPassword,
        Self::GithubAppId,
        Self::GithubAppClientId,
        Self::GithubAppPrivateKey,
        Self::GithubAppWebhookSecret,
        Self::AnthropicApiKey,
        Self::R2AccountId,
        Self::R2AccessKeyId,
        Self::R2SecretAccessKey,
        Self::R2BucketEvidence,
        Self::R2BucketBackups,
        Self::TurnstileSiteKey,
        Self::TurnstileSecretKey,
        Self::SesRegion,
        Self::SesAccessKeyId,
        Self::SesSecretAccessKey,
        Self::EmailFrom,
        Self::RailwayToken,
        Self::RailwayApiToken,
        Self::OtelExporterOtlpEndpoint,
        Self::OtelExporterOtlpHeaders,
        Self::OtelExporterOtlpProtocol,
        Self::CloudflareApiToken,
        Self::StripeSecretKey,
        Self::StripePublishableKey,
        Self::StripeWebhookSecret,
        Self::RampsmithMasterKeys,
        Self::BackupR2AccessKeyId,
        Self::BackupR2SecretAccessKey,
        Self::BackupDbPassword,
        Self::BackupAgeRecipients,
        Self::DrillR2AccessKeyId,
        Self::DrillR2SecretAccessKey,
        Self::BackupDrillAgeKey,
    ];

    /// The variable's name.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::ShopifyApiKey => "SHOPIFY_API_KEY",
            Self::ShopifyApiSecret => "SHOPIFY_API_SECRET",
            Self::ShopifyPartnerApiToken => "SHOPIFY_PARTNER_API_TOKEN",
            Self::ShopifyPartnerOrgId => "SHOPIFY_PARTNER_ORG_ID",
            Self::ShopifyAppAutomationToken => "SHOPIFY_APP_AUTOMATION_TOKEN",
            Self::ShopifyAppGid => "SHOPIFY_APP_GID",
            Self::ShopifyDevStoreDomain => "SHOPIFY_DEV_STORE_DOMAIN",
            Self::ShopifyDevStorePassword => "SHOPIFY_DEV_STORE_PASSWORD",
            Self::ShopifyDevStoreBDomain => "SHOPIFY_DEV_STORE_B_DOMAIN",
            Self::ShopifyDevStoreBPassword => "SHOPIFY_DEV_STORE_B_PASSWORD",
            Self::GithubAppId => "GITHUB_APP_ID",
            Self::GithubAppClientId => "GITHUB_APP_CLIENT_ID",
            Self::GithubAppPrivateKey => "GITHUB_APP_PRIVATE_KEY",
            Self::GithubAppWebhookSecret => "GITHUB_APP_WEBHOOK_SECRET",
            Self::AnthropicApiKey => "ANTHROPIC_API_KEY",
            Self::R2AccountId => "R2_ACCOUNT_ID",
            Self::R2AccessKeyId => "R2_ACCESS_KEY_ID",
            Self::R2SecretAccessKey => "R2_SECRET_ACCESS_KEY",
            Self::R2BucketEvidence => "R2_BUCKET_EVIDENCE",
            Self::R2BucketBackups => "R2_BUCKET_BACKUPS",
            Self::TurnstileSiteKey => "TURNSTILE_SITE_KEY",
            Self::TurnstileSecretKey => "TURNSTILE_SECRET_KEY",
            Self::SesRegion => "SES_REGION",
            Self::SesAccessKeyId => "SES_ACCESS_KEY_ID",
            Self::SesSecretAccessKey => "SES_SECRET_ACCESS_KEY",
            Self::EmailFrom => "EMAIL_FROM",
            Self::RailwayToken => "RAILWAY_TOKEN",
            Self::RailwayApiToken => "RAILWAY_API_TOKEN",
            Self::OtelExporterOtlpEndpoint => "OTEL_EXPORTER_OTLP_ENDPOINT",
            Self::OtelExporterOtlpHeaders => "OTEL_EXPORTER_OTLP_HEADERS",
            Self::OtelExporterOtlpProtocol => "OTEL_EXPORTER_OTLP_PROTOCOL",
            Self::CloudflareApiToken => "CLOUDFLARE_API_TOKEN",
            Self::StripeSecretKey => "STRIPE_SECRET_KEY",
            Self::StripePublishableKey => "STRIPE_PUBLISHABLE_KEY",
            Self::StripeWebhookSecret => "STRIPE_WEBHOOK_SECRET",
            Self::RampsmithMasterKeys => "RAMPSMITH_MASTER_KEYS",
            Self::BackupR2AccessKeyId => "BACKUP_R2_ACCESS_KEY_ID",
            Self::BackupR2SecretAccessKey => "BACKUP_R2_SECRET_ACCESS_KEY",
            Self::BackupDbPassword => "BACKUP_DB_PASSWORD",
            Self::BackupAgeRecipients => "BACKUP_AGE_RECIPIENTS",
            Self::DrillR2AccessKeyId => "DRILL_R2_ACCESS_KEY_ID",
            Self::DrillR2SecretAccessKey => "DRILL_R2_SECRET_ACCESS_KEY",
            Self::BackupDrillAgeKey => "BACKUP_DRILL_AGE_KEY",
        }
    }

    /// The LAUNCH.md section C row that lists the variable.
    #[must_use]
    pub const fn row(self) -> u8 {
        match self {
            Self::ShopifyApiKey | Self::ShopifyApiSecret => 1,
            Self::ShopifyPartnerApiToken
            | Self::ShopifyPartnerOrgId
            | Self::ShopifyAppAutomationToken
            | Self::ShopifyAppGid => 2,
            Self::ShopifyDevStoreDomain
            | Self::ShopifyDevStorePassword
            | Self::ShopifyDevStoreBDomain
            | Self::ShopifyDevStoreBPassword => 3,
            Self::GithubAppId
            | Self::GithubAppClientId
            | Self::GithubAppPrivateKey
            | Self::GithubAppWebhookSecret => 4,
            Self::AnthropicApiKey => 5,
            Self::R2AccountId
            | Self::R2AccessKeyId
            | Self::R2SecretAccessKey
            | Self::R2BucketEvidence
            | Self::R2BucketBackups
            | Self::TurnstileSiteKey
            | Self::TurnstileSecretKey => 6,
            Self::SesRegion | Self::SesAccessKeyId | Self::SesSecretAccessKey | Self::EmailFrom => {
                7
            }
            Self::RailwayToken | Self::RailwayApiToken => 8,
            Self::OtelExporterOtlpEndpoint
            | Self::OtelExporterOtlpHeaders
            | Self::OtelExporterOtlpProtocol => 9,
            Self::CloudflareApiToken => 10,
            Self::StripeSecretKey | Self::StripePublishableKey | Self::StripeWebhookSecret => 11,
            Self::RampsmithMasterKeys => 12,
            Self::BackupR2AccessKeyId
            | Self::BackupR2SecretAccessKey
            | Self::BackupDbPassword
            | Self::BackupAgeRecipients
            | Self::DrillR2AccessKeyId
            | Self::DrillR2SecretAccessKey
            | Self::BackupDrillAgeKey => 16,
        }
    }

    /// Whether the value is a credential. `FOUNDER_SETUP.md` marks the other variables *public*
    /// (or they are identifiers); they may be printed, secrets never are.
    #[must_use]
    pub const fn is_secret(self) -> bool {
        matches!(
            self,
            Self::ShopifyApiSecret
                | Self::ShopifyPartnerApiToken
                | Self::ShopifyAppAutomationToken
                | Self::ShopifyDevStorePassword
                | Self::ShopifyDevStoreBPassword
                | Self::GithubAppPrivateKey
                | Self::GithubAppWebhookSecret
                | Self::AnthropicApiKey
                | Self::R2AccessKeyId
                | Self::R2SecretAccessKey
                | Self::TurnstileSecretKey
                | Self::SesAccessKeyId
                | Self::SesSecretAccessKey
                | Self::RailwayToken
                | Self::RailwayApiToken
                | Self::OtelExporterOtlpHeaders
                | Self::CloudflareApiToken
                | Self::StripeSecretKey
                | Self::StripeWebhookSecret
                | Self::RampsmithMasterKeys
                | Self::BackupR2AccessKeyId
                | Self::BackupR2SecretAccessKey
                | Self::BackupDbPassword
                | Self::DrillR2AccessKeyId
                | Self::DrillR2SecretAccessKey
                | Self::BackupDrillAgeKey
        )
    }
}

/// The names of every founder secret, in LAUNCH.md order. None of them is ever a repository or
/// organization secret (ADR-092): each is a Railway variable, or a secret of one GitHub
/// environment that only `main` can deploy to.
#[must_use]
pub fn founder_secret_names() -> Vec<&'static str> {
    Var::ALL
        .iter()
        .filter(|var| var.is_secret())
        .map(|var| var.name())
        .collect()
}

/// Where variables come from: the process environment, or a map in tests.
pub trait EnvSource: Send + Sync {
    /// The raw value, if set.
    fn get(&self, name: &str) -> Option<String>;
}

/// The process environment.
#[derive(Debug, Clone, Copy, Default)]
pub struct ProcessEnv;

impl EnvSource for ProcessEnv {
    fn get(&self, name: &str) -> Option<String> {
        std::env::var(name).ok()
    }
}

/// A fixed set of variables, for tests.
#[derive(Debug, Clone, Default)]
pub struct MapEnv(pub BTreeMap<String, String>);

impl MapEnv {
    /// Builds a map from pairs.
    #[must_use]
    pub fn from_pairs(pairs: &[(&str, &str)]) -> Self {
        Self(
            pairs
                .iter()
                .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
                .collect(),
        )
    }
}

impl EnvSource for MapEnv {
    fn get(&self, name: &str) -> Option<String> {
        self.0.get(name).cloned()
    }
}

/// Reads documented variables. A blank value counts as unset, as in `ctl`'s configuration.
#[derive(Clone)]
pub struct Vars {
    env: Arc<dyn EnvSource>,
}

impl std::fmt::Debug for Vars {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Vars").finish_non_exhaustive()
    }
}

impl Vars {
    /// Reads from `env`.
    #[must_use]
    pub fn new(env: Arc<dyn EnvSource>) -> Self {
        Self { env }
    }

    /// The trimmed value, or `None` when unset or blank.
    #[must_use]
    pub fn get(&self, var: Var) -> Option<String> {
        self.env
            .get(var.name())
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
    }

    /// Registers every secret that is set with `redactor`, before any probe runs.
    pub fn register_secrets(&self, redactor: &Redactor) {
        for &var in Var::ALL {
            if var.is_secret()
                && let Some(value) = self.get(var)
            {
                redactor.register(&Secret::new(value));
            }
        }
    }

    /// Reads the inputs a probe needs. None set: the probe skips, naming the row. Some set:
    /// the probe fails, naming what is missing. All set: the values.
    pub fn gather(&self, row: u8, needs: &[Var]) -> Result<Gathered, Gap> {
        let mut values = BTreeMap::new();
        let mut missing = Vec::new();
        for &var in needs {
            match self.get(var) {
                Some(value) => {
                    values.insert(var, Secret::new(value));
                }
                None => missing.push(var),
            }
        }
        if missing.is_empty() {
            Ok(Gathered { values })
        } else if values.is_empty() {
            Err(Gap::NoneSet { row, missing })
        } else {
            Err(Gap::Partial { row, missing })
        }
    }
}

/// Why a probe cannot run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Gap {
    /// Nothing the probe needs is set.
    NoneSet {
        /// The LAUNCH.md row.
        row: u8,
        /// The variables it needs.
        missing: Vec<Var>,
    },
    /// Some of what the probe needs is set, so the input is incomplete.
    Partial {
        /// The LAUNCH.md row.
        row: u8,
        /// What is missing.
        missing: Vec<Var>,
    },
}

/// The values of the variables a probe asked for. Every value sits in a [`Secret`] so a stray
/// `Debug` cannot print it; a probe calls [`Gathered::text`] for the ones it may show.
#[derive(Debug)]
pub struct Gathered {
    values: BTreeMap<Var, Secret>,
}

impl Gathered {
    /// A value.
    ///
    /// # Panics
    ///
    /// Never: `gather` only returns `Ok` when every requested variable is present, and a probe
    /// asks for a variable it requested. The fallback is the empty string.
    #[must_use]
    pub fn text(&self, var: Var) -> &str {
        self.values.get(&var).map_or("", Secret::expose)
    }

    /// A value as a [`Secret`] (cloned).
    #[must_use]
    pub fn secret(&self, var: Var) -> Secret {
        self.values
            .get(&var)
            .cloned()
            .unwrap_or_else(|| Secret::new(String::new()))
    }
}

/// `A, B and C` for a list of variables.
#[must_use]
pub fn names(vars: &[Var]) -> String {
    vars.iter().map(|v| v.name()).collect::<Vec<_>>().join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_variable_is_listed_once_and_named_in_upper_snake_case() {
        let mut seen = std::collections::BTreeSet::new();
        for &var in Var::ALL {
            assert!(seen.insert(var), "{var:?} is listed twice");
            assert!(
                var.name()
                    .bytes()
                    .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
            );
            assert!((1..=12).contains(&var.row()) || var.row() == 16);
        }
        assert_eq!(seen.len(), Var::ALL.len());
    }

    #[test]
    fn the_founder_secret_names_are_the_secret_variables_and_only_those() {
        let names = founder_secret_names();
        assert_eq!(
            names.len(),
            Var::ALL.iter().filter(|var| var.is_secret()).count()
        );
        for must in [
            "RAILWAY_TOKEN",
            "SHOPIFY_APP_AUTOMATION_TOKEN",
            "R2_ACCESS_KEY_ID",
            "BACKUP_R2_SECRET_ACCESS_KEY",
            "DRILL_R2_SECRET_ACCESS_KEY",
            "BACKUP_DRILL_AGE_KEY",
            "BACKUP_DB_PASSWORD",
        ] {
            assert!(names.contains(&must), "{must} is a founder secret");
        }
        // Identifiers and public keys are not secrets.
        for public in [
            "R2_ACCOUNT_ID",
            "R2_BUCKET_BACKUPS",
            "BACKUP_AGE_RECIPIENTS",
        ] {
            assert!(!names.contains(&public), "{public} is not a secret");
        }
    }

    #[test]
    fn gather_distinguishes_none_partial_and_all() {
        let env = MapEnv::from_pairs(&[
            ("ANTHROPIC_API_KEY", "  sk-ant-x  "),
            ("STRIPE_SECRET_KEY", " "),
        ]);
        let vars = Vars::new(Arc::new(env));
        let got = vars.gather(5, &[Var::AnthropicApiKey]).unwrap();
        assert_eq!(got.text(Var::AnthropicApiKey), "sk-ant-x");
        assert_eq!(
            vars.gather(11, &[Var::StripeSecretKey, Var::StripePublishableKey])
                .unwrap_err(),
            Gap::NoneSet {
                row: 11,
                missing: vec![Var::StripeSecretKey, Var::StripePublishableKey]
            }
        );
        assert_eq!(
            vars.gather(5, &[Var::AnthropicApiKey, Var::GithubAppId])
                .unwrap_err(),
            Gap::Partial {
                row: 5,
                missing: vec![Var::GithubAppId]
            }
        );
    }

    #[test]
    fn gathered_values_do_not_debug_print() {
        let env = MapEnv::from_pairs(&[("ANTHROPIC_API_KEY", "sk-ant-very-secret")]);
        let got = Vars::new(Arc::new(env))
            .gather(5, &[Var::AnthropicApiKey])
            .unwrap();
        assert!(!format!("{got:?}").contains("very-secret"));
    }

    #[test]
    fn secrets_are_registered_before_probes_run() {
        let env = MapEnv::from_pairs(&[
            ("ANTHROPIC_API_KEY", "sk-ant-very-secret"),
            ("SHOPIFY_API_KEY", "public-client-id"),
        ]);
        let redactor = Redactor::new();
        Vars::new(Arc::new(env)).register_secrets(&redactor);
        assert_eq!(
            redactor.scrub("sk-ant-very-secret public-client-id"),
            "[REDACTED] public-client-id"
        );
    }
}
