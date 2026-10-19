//! Substitute tests for the live trials (LAUNCH.md section E, condition 2): which trials
//! exist, that each skips with a notice naming its C row when its inputs are absent, runs when
//! any is present, and turns an outcome into a verdict that cannot hide a failure. The live
//! binary (`live.rs`) is built from the same `plan` module.

// Test code: PLAN §8 denies these lints outside tests only.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    unreachable_pub,
    dead_code
)]

use std::collections::BTreeSet;
use std::sync::Arc;

use rsctl::doctor::{CHECKS, Endpoints};
use rsctl::keys;
use rsctl::report::Outcome;
use rsctl::vars::{EnvSource, MapEnv};
use time::OffsetDateTime;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[path = "live_plan/plan.rs"]
mod plan;

use plan::{PRODUCTION_GITHUB_APP_ID, PRODUCTION_SHOPIFY_API_KEY, Plan, Verdict};

const KEY: &str = "test-anthropic-key-SECRET-1";

fn env(pairs: &[(&str, &str)]) -> Arc<dyn EnvSource> {
    Arc::new(MapEnv::from_pairs(pairs))
}

fn plan_for(id: &str, env: &Arc<dyn EnvSource>) -> Plan {
    plan::plan(env)
        .into_iter()
        .find(|p| p.id == id)
        .unwrap_or_else(|| panic!("no trial for `{id}`"))
}

fn fixture(name: &str) -> String {
    let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("cannot read {path}: {e}"))
}

/// A multi-thread runtime that keeps a fake server alive while the test calls `execute`
/// (which builds its own runtime, as the live binary does) from a plain thread.
fn fake(mocks: Vec<(&'static str, ResponseTemplate)>) -> (tokio::runtime::Runtime, MockServer) {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let server = runtime.block_on(async {
        let server = MockServer::start().await;
        for (route, response) in mocks {
            Mock::given(method("GET"))
                .and(path(route))
                .respond_with(response)
                .mount(&server)
                .await;
        }
        server
    });
    (runtime, server)
}

#[test]
fn with_nothing_set_every_trial_is_skipped_and_names_its_row() {
    let plans = plan::plan(&env(&[]));
    assert_eq!(plans.len(), CHECKS.len());
    for plan in &plans {
        let notice = plan.skip.as_deref().unwrap_or_else(|| {
            panic!("{} ran with nothing set", plan.id);
        });
        assert!(
            notice.starts_with(&format!("C row {}:", plan.row)),
            "{notice}"
        );
        assert!(
            plan.name.ends_with(&format!("_skipped_C_row_{}", plan.row)),
            "{}",
            plan.name
        );
    }
    let rows: BTreeSet<u8> = plans.iter().map(|p| p.row).collect();
    for row in 1..=12 {
        assert!(rows.contains(&row), "row {row} has no live trial");
    }
}

#[test]
fn the_skip_notice_names_the_variables_to_set() {
    let plan = plan_for("anthropic.models", &env(&[]));
    assert_eq!(
        plan.skip.as_deref(),
        Some("C row 5: none of ANTHROPIC_API_KEY is set")
    );
    let r2 = plan_for("r2.backups", &env(&[]));
    let notice = r2.skip.unwrap();
    assert!(
        notice.contains("R2_BUCKET_BACKUPS") && notice.contains("R2_ACCOUNT_ID"),
        "{notice}"
    );
}

#[test]
fn trial_names_are_unique_and_safe_for_a_test_runner() {
    for pairs in [vec![], vec![("ANTHROPIC_API_KEY", "x")]] {
        let plans = plan::plan(&env(&pairs));
        let names: BTreeSet<&str> = plans.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names.len(), plans.len());
        for plan in &plans {
            assert!(
                plan.name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_'),
                "{}",
                plan.name
            );
        }
    }
}

#[test]
fn an_input_that_is_present_makes_exactly_its_trial_run() {
    let plans = plan::plan(&env(&[("ANTHROPIC_API_KEY", "x")]));
    let running: Vec<&str> = plans
        .iter()
        .filter(|p| p.skip.is_none())
        .map(|p| p.id)
        .collect();
    assert_eq!(running, vec!["anthropic.models"]);
    let named = plans.iter().find(|p| p.id == "anthropic.models").unwrap();
    assert_eq!(named.name, "c05_anthropic_models");
}

#[test]
fn a_blank_value_counts_as_absent() {
    let plans = plan::plan(&env(&[("ANTHROPIC_API_KEY", "   ")]));
    assert!(plans.iter().all(|p| p.skip.is_some()));
}

#[test]
fn any_one_variable_a_check_reads_starts_its_trial() {
    for (index, def) in CHECKS.iter().enumerate().filter(|(_, d)| !d.staging_only) {
        for var in def.reads {
            let plans = plan::plan(&env(&[(var.name(), "x")]));
            assert!(
                plans[index].skip.is_none(),
                "{} stays skipped when {} is set",
                def.id,
                var.name()
            );
        }
    }
}

#[test]
fn a_row_that_is_only_partly_set_starts_its_trials_so_the_gap_fails() {
    let plans = plan::plan(&env(&[("R2_ACCOUNT_ID", "acct")]));
    let running: BTreeSet<&str> = plans
        .iter()
        .filter(|p| p.skip.is_none())
        .map(|p| p.id)
        .collect();
    assert!(running.contains("r2.evidence") && running.contains("r2.backups"));
    assert!(!running.contains("turnstile.siteverify"));
}

#[test]
fn the_staging_trial_needs_both_production_identifiers() {
    for pairs in [
        vec![],
        vec![(PRODUCTION_SHOPIFY_API_KEY, "shopify")],
        vec![(PRODUCTION_GITHUB_APP_ID, "1")],
        vec![("SHOPIFY_API_KEY", "staging"), ("GITHUB_APP_ID", "2")],
    ] {
        let plan = plan_for("staging.separate-apps", &env(&pairs));
        let notice = plan.skip.expect("skipped");
        assert!(notice.starts_with("C row 15:"), "{notice}");
        assert!(plan.name.ends_with("_skipped_C_row_15"));
    }
    let both = env(&[
        (PRODUCTION_SHOPIFY_API_KEY, "shopify"),
        (PRODUCTION_GITHUB_APP_ID, "1"),
    ]);
    assert!(plan_for("staging.separate-apps", &both).skip.is_none());
}

#[test]
fn verdicts_cannot_hide_a_failure() {
    let pass = Outcome::pass("ok");
    let fail = Outcome::fail("HTTP 401");
    let unverifiable = Outcome::not_verifiable("no documented check");
    let missing = Outcome::missing("not set: X (C row 3)");
    assert_eq!(plan::verdict(true, 5, &pass), Verdict::Passed("ok".into()));
    assert_eq!(
        plan::verdict(true, 5, &fail),
        Verdict::Failed("C row 5: HTTP 401".into())
    );
    assert_eq!(
        plan::verdict(true, 2, &unverifiable),
        Verdict::Ignored("C row 2: no documented check".into())
    );
    // A started check that lacks an input it requires fails; an optional one only notes it.
    assert!(matches!(
        plan::verdict(true, 3, &missing),
        Verdict::Failed(text) if text.contains("C row 3") && text.contains("required")
    ));
    assert!(matches!(
        plan::verdict(false, 8, &missing),
        Verdict::Ignored(text) if text.contains("C row 3")
    ));
}

#[test]
fn a_healthy_service_passes_the_live_path() {
    let (_runtime, server) = fake(vec![(
        "/v1/models",
        ResponseTemplate::new(200)
            .set_body_raw(fixture("anthropic/models.json"), "application/json"),
    )]);
    let env = env(&[("ANTHROPIC_API_KEY", KEY)]);
    let verdict = plan::execute(
        &plan_for("anthropic.models", &env),
        env,
        Endpoints::all_at(&server.uri()),
    );
    assert!(
        matches!(&verdict, Verdict::Passed(text) if text.contains("3 models")),
        "{verdict:?}"
    );
}

#[test]
fn a_rejected_input_fails_the_live_path_without_the_secret() {
    let (_runtime, server) = fake(vec![(
        "/v1/models",
        ResponseTemplate::new(401).set_body_raw(
            fixture("anthropic/models-401-bad-key.json"),
            "application/json",
        ),
    )]);
    let env = env(&[("ANTHROPIC_API_KEY", KEY)]);
    let verdict = plan::execute(
        &plan_for("anthropic.models", &env),
        env,
        Endpoints::all_at(&server.uri()),
    );
    let Verdict::Failed(text) = verdict else {
        panic!("a 401 must fail the trial");
    };
    assert!(text.starts_with("C row 5:"), "{text}");
    assert!(text.contains("401"), "{text}");
    assert!(!text.contains(KEY), "{text}");
}

#[test]
fn an_unreachable_service_fails_the_live_path() {
    // Nothing listens on the port a dropped server leaves behind.
    let (runtime, server) = fake(vec![]);
    let base = server.uri();
    drop(server);
    drop(runtime);
    let env = env(&[("ANTHROPIC_API_KEY", KEY)]);
    let verdict = plan::execute(
        &plan_for("anthropic.models", &env),
        env,
        Endpoints::all_at(&base),
    );
    assert!(
        matches!(&verdict, Verdict::Failed(text) if !text.contains(KEY)),
        "{verdict:?}"
    );
}

#[test]
fn the_master_key_trial_needs_no_network() {
    let ring = keys::generate(OffsetDateTime::UNIX_EPOCH, Some("k1")).unwrap();
    let env = env(&[("RAMPSMITH_MASTER_KEYS", ring.ring.expose())]);
    let verdict = plan::execute(
        &plan_for("master-keys.round-trip", &env),
        Arc::clone(&env),
        Endpoints::all_at("http://127.0.0.1:9"),
    );
    assert!(matches!(verdict, Verdict::Passed(_)), "{verdict:?}");
}

#[test]
fn the_staging_trial_compares_with_the_production_identifiers() {
    let different = env(&[
        ("SHOPIFY_API_KEY", "staging-client"),
        ("GITHUB_APP_ID", "22"),
        (PRODUCTION_SHOPIFY_API_KEY, "production-client"),
        (PRODUCTION_GITHUB_APP_ID, "11"),
    ]);
    let verdict = plan::execute(
        &plan_for("staging.separate-apps", &different),
        Arc::clone(&different),
        Endpoints::default(),
    );
    assert!(matches!(verdict, Verdict::Passed(_)), "{verdict:?}");

    let shared = env(&[
        ("SHOPIFY_API_KEY", "same-client"),
        ("GITHUB_APP_ID", "22"),
        (PRODUCTION_SHOPIFY_API_KEY, "same-client"),
        (PRODUCTION_GITHUB_APP_ID, "11"),
    ]);
    let verdict = plan::execute(
        &plan_for("staging.separate-apps", &shared),
        Arc::clone(&shared),
        Endpoints::default(),
    );
    assert!(
        matches!(&verdict, Verdict::Failed(text) if text.contains("shares")),
        "{verdict:?}"
    );
}
