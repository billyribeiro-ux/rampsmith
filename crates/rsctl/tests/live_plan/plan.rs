//! The live trials: which exist, when each skips, and how a probe's outcome becomes a verdict.
//!
//! Shared by `live.rs` (the `libtest-mimic` binary that talks to the real vendors) and
//! `live_plan.rs` (substitute tests of this logic), so what CI proves is what the founder runs
//! (LAUNCH.md section E, ADR-155).

use std::sync::Arc;
use std::time::Duration;

use rsctl::doctor::{CHECKS, Ctx, Endpoints, Options, run_checks};
use rsctl::report::{Outcome, SkipKind, Target};
use rsctl::vars::{EnvSource, Vars, names};
use time::OffsetDateTime;

/// The production Shopify app's public client id, for the row 15 live trial.
pub const PRODUCTION_SHOPIFY_API_KEY: &str = "RSCTL_LIVE_PRODUCTION_SHOPIFY_API_KEY";
/// The production GitHub App id, for the row 15 live trial.
pub const PRODUCTION_GITHUB_APP_ID: &str = "RSCTL_LIVE_PRODUCTION_GITHUB_APP_ID";

/// One live trial.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    /// The position of the check in `CHECKS`.
    pub index: usize,
    /// The check id, such as `r2.evidence`.
    pub id: &'static str,
    /// The LAUNCH.md section C row.
    pub row: u8,
    /// The trial's name. A skipped trial's name says so and names the row, because a test
    /// runner that lists skipped tests shows the name and nothing else.
    pub name: String,
    /// The notice for a skipped trial: the row and what to set.
    pub skip: Option<String>,
}

/// What a trial concluded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// The input works against the real service.
    Passed(String),
    /// No verdict: the notice says why, and names the row.
    Ignored(String),
    /// The input is present and does not work.
    Failed(String),
}

/// The trials for the current environment. The trial for a check is skipped when none of the
/// variables the check reads is set; once any is set it runs, and an incomplete row fails.
pub fn plan(env: &Arc<dyn EnvSource>) -> Vec<Plan> {
    let vars = Vars::new(Arc::clone(env));
    CHECKS
        .iter()
        .enumerate()
        .map(|(index, def)| {
            let skip = if def.staging_only {
                let have = |name: &str| env.get(name).is_some_and(|v| !v.trim().is_empty());
                (!(have(PRODUCTION_SHOPIFY_API_KEY) && have(PRODUCTION_GITHUB_APP_ID))).then(|| {
                    format!(
                        "C row {}: set {PRODUCTION_SHOPIFY_API_KEY} and {PRODUCTION_GITHUB_APP_ID} to the production identifiers, and run this where {} hold the staging values",
                        def.row,
                        names(def.reads)
                    )
                })
            } else {
                (!def.reads.iter().any(|&var| vars.get(var).is_some())).then(|| {
                    format!("C row {}: none of {} is set", def.row, names(def.reads))
                })
            };
            let base = format!("c{:02}_{}", def.row, def.id.replace(['.', '-'], "_"));
            let name = if skip.is_some() {
                format!("{base}_skipped_C_row_{}", def.row)
            } else {
                base
            };
            Plan {
                index,
                id: def.id,
                row: def.row,
                name,
                skip,
            }
        })
        .collect()
}

/// Turns a probe's outcome into a verdict. A missing input fails a required check that was
/// started (its row is only partly set); it is only a notice for an optional one.
pub fn verdict(required: bool, row: u8, outcome: &Outcome) -> Verdict {
    match outcome {
        Outcome::Pass(detail) => Verdict::Passed(detail.clone()),
        Outcome::Fail(detail) => Verdict::Failed(format!("C row {row}: {detail}")),
        Outcome::Skip(SkipKind::MissingInput, detail) if required => Verdict::Failed(format!(
            "C row {row}: a required input is missing: {detail}"
        )),
        Outcome::Skip(_, detail) => Verdict::Ignored(format!("C row {row}: {detail}")),
    }
}

/// Runs one check against `endpoints` with `env` and returns the verdict. Everything in the
/// verdict passes through the run's redactor.
pub fn execute(plan: &Plan, env: Arc<dyn EnvSource>, endpoints: Endpoints) -> Verdict {
    let Some(checks) = CHECKS.get(plan.index..=plan.index) else {
        return Verdict::Failed("the plan names a check that does not exist".to_owned());
    };
    let Some(def) = checks.first() else {
        return Verdict::Failed("the plan names a check that does not exist".to_owned());
    };
    let staging =
        env_text(&env, PRODUCTION_SHOPIFY_API_KEY).zip(env_text(&env, PRODUCTION_GITHUB_APP_ID));
    let options = Options {
        target: if def.staging_only {
            Target::Staging
        } else {
            Target::Production
        },
        rows: vec![def.row],
        production_shopify_api_key: staging.as_ref().map(|(shopify, _)| shopify.clone()),
        production_github_app_id: staging.map(|(_, github)| github),
        timeout: Duration::from_secs(30),
    };
    let ctx = match Ctx::new(env, endpoints, options, Arc::new(OffsetDateTime::now_utc)) {
        Ok(ctx) => Arc::new(ctx),
        Err(error) => return Verdict::Failed(format!("cannot start the HTTP client: {error}")),
    };
    let Ok(runtime) = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    else {
        return Verdict::Failed("cannot start the async runtime".to_owned());
    };
    let report = runtime.block_on(run_checks(Arc::clone(&ctx), checks));
    let Some(finding) = report.findings.first() else {
        return Verdict::Failed("the check did not run".to_owned());
    };
    match verdict(def.required, def.row, &finding.outcome) {
        Verdict::Passed(text) => Verdict::Passed(ctx.redactor.scrub(&text)),
        Verdict::Ignored(text) => Verdict::Ignored(ctx.redactor.scrub(&text)),
        Verdict::Failed(text) => Verdict::Failed(ctx.redactor.scrub(&text)),
    }
}

fn env_text(env: &Arc<dyn EnvSource>, name: &str) -> Option<String> {
    env.get(name)
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}
