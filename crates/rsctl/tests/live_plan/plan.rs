//! The live trials: which exist, when each skips, and how a probe's outcome becomes a verdict.
//!
//! Shared by `live.rs` (the `libtest-mimic` binary that talks to the real vendors) and
//! `live_plan.rs` (substitute tests of this logic), so what CI proves is what the founder runs
//! (LAUNCH.md section E, ADR-155).

use std::sync::Arc;
use std::time::Duration;

use rsctl::doctor::{CHECKS, CheckDef, Ctx, Endpoints, Options, run_checks};
use rsctl::report::{Outcome, SkipKind, Target};
use rsctl::vars::{EnvSource, Var, Vars, names};
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

/// Inputs the vendor documents no way to check without using them: nothing can run live.
/// `live_plan.rs` proves the list against the probes (a set input reports "not verifiable").
pub const NOT_VERIFIABLE: &[&str] = &["shopify.automation-token"];

/// The variables whose presence means the founder has supplied this check's input, and so the
/// live check should run: the variables it reads from its own row, except where the check also
/// reads an optional second token (the Railway workspace probe starts from `RAILWAY_API_TOKEN`).
pub fn trigger_vars(def: &CheckDef) -> Vec<Var> {
    let own = def.reads.iter().copied().filter(|var| var.row() == def.row);
    if def.id == "railway.workspace-token" {
        own.filter(|&var| var == Var::RailwayApiToken).collect()
    } else {
        own.collect()
    }
}

/// Inputs from another row that the check cannot run without. The row 1 check exchanges the
/// client credentials on development store A, which is a row 3 input.
pub fn also_needs(def: &CheckDef) -> &'static [Var] {
    if def.id == "shopify.app" {
        &[Var::ShopifyDevStoreDomain]
    } else {
        &[]
    }
}

/// The notice for a check that cannot run now, or `None` when it can.
fn skip_notice(def: &CheckDef, env: &Arc<dyn EnvSource>, vars: &Vars) -> Option<String> {
    if def.staging_only {
        let have = |name: &str| env.get(name).is_some_and(|v| !v.trim().is_empty());
        return (!(have(PRODUCTION_SHOPIFY_API_KEY) && have(PRODUCTION_GITHUB_APP_ID))).then(|| {
            format!(
                "C row {}: set {PRODUCTION_SHOPIFY_API_KEY} and {PRODUCTION_GITHUB_APP_ID} to the production identifiers, and run this where {} hold the staging values",
                def.row,
                names(def.reads)
            )
        });
    }
    if NOT_VERIFIABLE.contains(&def.id) {
        return Some(format!(
            "C row {}: {} has no documented read-only check, so there is nothing to run live; `rsctl doctor` reports it as not verifiable",
            def.row,
            names(def.reads)
        ));
    }
    let triggers = trigger_vars(def);
    if !triggers.iter().any(|&var| vars.get(var).is_some()) {
        return Some(format!(
            "C row {}: none of {} is set",
            def.row,
            names(&triggers)
        ));
    }
    let missing: Vec<Var> = also_needs(def)
        .iter()
        .copied()
        .filter(|&var| vars.get(var).is_none())
        .collect();
    let first = *missing.first()?;
    Some(format!(
        "C row {}: {} is not set, and the C row {} check needs it",
        first.row(),
        names(&missing),
        def.row
    ))
}

/// The trials for the current environment. A check's trial runs once any variable of its own
/// row that it reads is set (so a half-filled row runs and fails as incomplete, not skips), and
/// the inputs it needs from other rows are present; otherwise it is skipped, and the notice
/// names the C row of what is missing.
pub fn plan(env: &Arc<dyn EnvSource>) -> Vec<Plan> {
    let vars = Vars::new(Arc::clone(env));
    CHECKS
        .iter()
        .enumerate()
        .map(|(index, def)| {
            let skip = skip_notice(def, env, &vars);
            let base = format!("c{:02}_{}", def.row, def.id.replace(['.', '-'], "_"));
            let name = match skip.as_deref().and_then(notice_row) {
                Some(row) => format!("{base}_skipped_C_row_{row}"),
                None => base,
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

/// The row a notice (`C row N: ...`) names.
pub fn notice_row(notice: &str) -> Option<u8> {
    notice
        .strip_prefix("C row ")?
        .split(':')
        .next()?
        .trim()
        .parse()
        .ok()
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
