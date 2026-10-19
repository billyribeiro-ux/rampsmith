//! `rsctl doctor`: one probe per founder input in LAUNCH.md section C, rows 1 to 12, plus the
//! row 15 staging check (ADR-151, ADR-152).
//!
//! Every probe:
//! - reads only the variables it declares in [`CheckDef::reads`] (the test suite records reads);
//! - makes the least-privileged live call the vendor documents for the purpose;
//! - returns PASS, FAIL with a reason, or SKIP naming the missing row;
//! - prints vendor error *codes* only, never vendor text, and never a secret.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use reqwest::Method;
use time::OffsetDateTime;
use tokio::task::JoinSet;

use crate::http::{Http, HttpError};
use crate::report::{Finding, Outcome, Report, Target};
use crate::secret::Redactor;
use crate::vars::{EnvSource, Var, Vars};

mod anthropic;
mod cloudflare_dns;
mod common;
mod dev_store;
mod github_app;
mod master_keys;
mod otlp;
mod partner_api;
mod r2;
mod railway;
mod ses;
mod shopify_app;
mod staging;
mod stripe;
mod turnstile;

pub use anthropic::EXPECTED_MODELS;

/// A probe's future.
pub type ProbeFuture<'a> = Pin<Box<dyn Future<Output = Outcome> + Send + 'a>>;

/// One check in the registry.
#[derive(Debug, Clone, Copy)]
pub struct CheckDef {
    /// A stable id such as `r2.evidence`.
    pub id: &'static str,
    /// The LAUNCH.md section C row.
    pub row: u8,
    /// Whether `--strict` treats a missing input as a failure. Optional inputs (the
    /// Cloudflare DNS token, the Railway workspace token) and row 11 (R3 only) are not.
    pub required: bool,
    /// Whether the check runs only for `--environment staging` (row 15).
    pub staging_only: bool,
    /// Every variable the probe may read, and nothing else.
    pub reads: &'static [Var],
    /// Runs the probe.
    pub run: for<'a> fn(&'a Ctx) -> ProbeFuture<'a>,
}

/// Every check, in LAUNCH.md order.
pub const CHECKS: &[CheckDef] = &[
    CheckDef {
        id: "shopify.app",
        row: 1,
        required: true,
        staging_only: false,
        reads: shopify_app::READS,
        run: shopify_app::run,
    },
    CheckDef {
        id: "shopify.partner-api",
        row: 2,
        required: true,
        staging_only: false,
        reads: partner_api::READS,
        run: partner_api::run,
    },
    CheckDef {
        id: "shopify.automation-token",
        row: 2,
        required: true,
        staging_only: false,
        reads: partner_api::AUTOMATION_READS,
        run: partner_api::run_automation_token,
    },
    CheckDef {
        id: "shopify.dev-store-a",
        row: 3,
        required: true,
        staging_only: false,
        reads: dev_store::READS_A,
        run: dev_store::run_a,
    },
    CheckDef {
        id: "shopify.dev-store-b",
        row: 3,
        required: true,
        staging_only: false,
        reads: dev_store::READS_B,
        run: dev_store::run_b,
    },
    CheckDef {
        id: "github.app",
        row: 4,
        required: true,
        staging_only: false,
        reads: github_app::READS,
        run: github_app::run,
    },
    CheckDef {
        id: "anthropic.models",
        row: 5,
        required: true,
        staging_only: false,
        reads: anthropic::READS,
        run: anthropic::run,
    },
    CheckDef {
        id: "r2.evidence",
        row: 6,
        required: true,
        staging_only: false,
        reads: r2::READS_EVIDENCE,
        run: r2::run_evidence,
    },
    CheckDef {
        id: "r2.backups",
        row: 6,
        required: true,
        staging_only: false,
        reads: r2::READS_BACKUPS,
        run: r2::run_backups,
    },
    CheckDef {
        id: "turnstile.siteverify",
        row: 6,
        required: true,
        staging_only: false,
        reads: turnstile::READS,
        run: turnstile::run,
    },
    CheckDef {
        id: "ses.identity",
        row: 7,
        required: true,
        staging_only: false,
        reads: ses::READS,
        run: ses::run,
    },
    CheckDef {
        id: "railway.project-token",
        row: 8,
        required: true,
        staging_only: false,
        reads: railway::READS_PROJECT,
        run: railway::run_project_token,
    },
    CheckDef {
        id: "railway.workspace-token",
        row: 8,
        required: false,
        staging_only: false,
        reads: railway::READS_API,
        run: railway::run_api_token,
    },
    CheckDef {
        id: "otlp.export",
        row: 9,
        required: true,
        staging_only: false,
        reads: otlp::READS,
        run: otlp::run,
    },
    CheckDef {
        id: "cloudflare.dns",
        row: 10,
        required: false,
        staging_only: false,
        reads: cloudflare_dns::READS,
        run: cloudflare_dns::run,
    },
    CheckDef {
        id: "stripe.account",
        row: 11,
        required: false,
        staging_only: false,
        reads: stripe::READS,
        run: stripe::run,
    },
    CheckDef {
        id: "master-keys.round-trip",
        row: 12,
        required: true,
        staging_only: false,
        reads: master_keys::READS,
        run: master_keys::run,
    },
    CheckDef {
        id: "staging.separate-apps",
        row: 15,
        required: true,
        staging_only: true,
        reads: staging::READS,
        run: staging::run,
    },
];

/// Where each vendor's API lives. Production values by default; tests point them at a fake.
#[derive(Debug, Clone)]
pub struct Endpoints {
    /// Replaces `https://<shop>` for every Shopify store (tests only).
    pub shop_origin: Option<String>,
    /// The Partner API origin.
    pub partner_api: String,
    /// The GitHub REST API origin.
    pub github_api: String,
    /// The Anthropic API origin.
    pub anthropic_api: String,
    /// Replaces `https://<account>.r2.cloudflarestorage.com` (tests only).
    pub r2: Option<String>,
    /// The Turnstile siteverify origin.
    pub turnstile: String,
    /// Replaces `https://email.<region>.amazonaws.com` (tests only).
    pub ses: Option<String>,
    /// The Railway GraphQL origin.
    pub railway: String,
    /// The Cloudflare API origin.
    pub cloudflare_api: String,
    /// The Stripe API origin.
    pub stripe_api: String,
}

impl Default for Endpoints {
    fn default() -> Self {
        Self {
            shop_origin: None,
            partner_api: "https://partners.shopify.com".to_owned(),
            github_api: "https://api.github.com".to_owned(),
            anthropic_api: "https://api.anthropic.com".to_owned(),
            r2: None,
            turnstile: "https://challenges.cloudflare.com".to_owned(),
            ses: None,
            railway: "https://backboard.railway.com".to_owned(),
            cloudflare_api: "https://api.cloudflare.com".to_owned(),
            stripe_api: "https://api.stripe.com".to_owned(),
        }
    }
}

impl Endpoints {
    /// Every endpoint at `base` (a local fake server).
    #[must_use]
    pub fn all_at(base: &str) -> Self {
        let base = base.trim_end_matches('/').to_owned();
        Self {
            shop_origin: Some(base.clone()),
            partner_api: base.clone(),
            github_api: base.clone(),
            anthropic_api: base.clone(),
            r2: Some(base.clone()),
            turnstile: base.clone(),
            ses: Some(base.clone()),
            railway: base.clone(),
            cloudflare_api: base.clone(),
            stripe_api: base,
        }
    }
}

/// How the run was asked to behave.
#[derive(Debug, Clone)]
pub struct Options {
    /// Which environment's inputs are being checked.
    pub target: Target,
    /// Only these rows (empty: all).
    pub rows: Vec<u8>,
    /// The production app's public client id, for the row 15 comparison.
    pub production_shopify_api_key: Option<String>,
    /// The production GitHub App id, for the row 15 comparison.
    pub production_github_app_id: Option<String>,
    /// Per-request timeout.
    pub timeout: Duration,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            target: Target::Production,
            rows: Vec::new(),
            production_shopify_api_key: None,
            production_github_app_id: None,
            timeout: Duration::from_secs(15),
        }
    }
}

/// The clock probes read, injectable for tests.
pub type Clock = Arc<dyn Fn() -> OffsetDateTime + Send + Sync>;

/// Everything a probe needs.
pub struct Ctx {
    /// The documented variables.
    pub vars: Vars,
    /// The HTTP client.
    pub http: Http,
    /// Vendor origins.
    pub endpoints: Endpoints,
    /// Run options.
    pub options: Options,
    /// Scrubs every printed line.
    pub redactor: Arc<Redactor>,
    /// The time source.
    pub clock: Clock,
}

impl std::fmt::Debug for Ctx {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Ctx")
            .field("endpoints", &self.endpoints)
            .field("options", &self.options)
            .finish_non_exhaustive()
    }
}

impl Ctx {
    /// A context reading `env`; every secret in it is registered with the redactor.
    pub fn new(
        env: Arc<dyn EnvSource>,
        endpoints: Endpoints,
        options: Options,
        clock: Clock,
    ) -> Result<Self, HttpError> {
        let vars = Vars::new(env);
        let redactor = Arc::new(Redactor::new());
        vars.register_secrets(&redactor);
        Ok(Self {
            http: Http::new(options.timeout)?,
            vars,
            endpoints,
            options,
            redactor,
            clock,
        })
    }

    /// The current time.
    #[must_use]
    pub fn now(&self) -> OffsetDateTime {
        (self.clock)()
    }

    /// A request builder, or the failure outcome for an unusable URL.
    pub(crate) fn request(
        &self,
        method: Method,
        url: &str,
    ) -> Result<reqwest::RequestBuilder, Outcome> {
        self.http
            .request(method, url)
            .map_err(|e| Outcome::fail(format!("cannot build the request: {e}")))
    }
}

fn selected(def: &CheckDef, options: &Options) -> bool {
    (!def.staging_only || options.target == Target::Staging)
        && (options.rows.is_empty() || options.rows.contains(&def.row))
}

/// Runs every selected check concurrently and collects the findings in registry order.
pub async fn run(ctx: Arc<Ctx>) -> Report {
    run_checks(ctx, CHECKS).await
}

/// [`run`] over a given set of checks. A check that panics is reported as failed, with the
/// panic's payload dropped: it could hold anything.
pub async fn run_checks(ctx: Arc<Ctx>, checks: &'static [CheckDef]) -> Report {
    let defs: Vec<&'static CheckDef> = checks
        .iter()
        .filter(|def| selected(def, &ctx.options))
        .collect();
    let mut set = JoinSet::new();
    let mut by_task = std::collections::HashMap::new();
    for (index, &def) in defs.iter().enumerate() {
        let ctx = Arc::clone(&ctx);
        let handle = set.spawn(async move { (index, (def.run)(&ctx).await) });
        by_task.insert(handle.id(), index);
    }
    let mut outcomes: Vec<Option<Outcome>> = vec![None; defs.len()];
    while let Some(joined) = set.join_next_with_id().await {
        match joined {
            Ok((_, (index, outcome))) => {
                if let Some(slot) = outcomes.get_mut(index) {
                    *slot = Some(outcome);
                }
            }
            // A probe panicked. The payload is dropped: it could hold anything.
            Err(error) => {
                if let Some(&index) = by_task.get(&error.id())
                    && let Some(slot) = outcomes.get_mut(index)
                {
                    *slot = Some(Outcome::fail("the probe crashed (internal error)"));
                }
            }
        }
    }
    let findings = defs
        .iter()
        .zip(outcomes)
        .map(|(def, outcome)| Finding {
            id: def.id,
            row: def.row,
            required: def.required,
            outcome: outcome.unwrap_or_else(|| Outcome::fail("the probe produced no result")),
        })
        .collect();
    Report {
        target: ctx.options.target,
        findings,
    }
}
