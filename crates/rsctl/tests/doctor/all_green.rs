//! Every probe at once against one fake that answers as healthy vendors would: the report has
//! a PASS for each input, the automation token is reported as not verifiable, and the exit
//! code is 0, also under `--strict`.

use rsctl::vars::Var;
use wiremock::MockServer;

use crate::support::{Rig, master_ring, test_key};
use crate::{
    anthropic, cloudflare_dns, dev_store, github_app, otlp, partner_api, r2, railway, ses,
    shopify_app, stripe, turnstile,
};

/// Mounts a healthy answer for every probe and returns the environment that goes with it.
pub async fn healthy_world() -> (MockServer, Vec<(String, String)>) {
    let server = MockServer::start().await;
    anthropic::healthy(&server).await;
    cloudflare_dns::healthy(&server).await;
    dev_store::healthy(&server).await;
    github_app::healthy(&server).await;
    otlp::healthy(&server).await;
    partner_api::healthy(&server).await;
    r2::healthy(&server).await;
    railway::healthy(&server).await;
    ses::healthy(&server).await;
    shopify_app::healthy(&server).await;
    stripe::healthy(&server).await;
    turnstile::healthy(&server).await;

    let mut env: Vec<(String, String)> = Vec::new();
    for group in [
        anthropic::vars(),
        cloudflare_dns::vars(),
        dev_store::vars(),
        partner_api::vars(),
        r2::vars(),
        railway::vars(),
        ses::vars(),
        shopify_app::vars(),
        stripe::vars(),
        turnstile::vars(),
    ] {
        env.extend(group.into_iter().map(|(k, v)| (k.to_owned(), v.to_owned())));
    }
    env.extend(
        github_app::healthy_env(&test_key().pkcs1_pem)
            .into_iter()
            .map(|(k, v)| (k.to_owned(), v)),
    );
    env.extend(
        otlp::healthy_vars(&server.uri())
            .into_iter()
            .map(|(k, v)| (k.to_owned(), v)),
    );
    env.push(("RAMPSMITH_MASTER_KEYS".to_owned(), master_ring()));
    (server, env)
}

pub async fn rig_from(server: MockServer, env: &[(String, String)]) -> Rig {
    let borrowed: Vec<(&str, &str)> = env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    let mut rig = Rig::new(&borrowed).await;
    rig.server = server;
    rig
}

#[tokio::test]
async fn every_probe_passes_against_healthy_vendors() {
    let (server, env) = healthy_world().await;
    let rig = rig_from(server, &env).await;
    let (report, ctx) = rig.report().await;
    let text = report.render_text(&ctx.redactor, true);

    let passes = report.summary();
    assert_eq!(passes.fail, 0, "{text}");
    // Only the automation token is neither passed nor failed: Shopify documents no check for it.
    // (Row 15 runs only for `--environment staging`.)
    assert_eq!(passes.skip, 1, "{text}");
    assert_eq!(passes.pass, 16, "{text}");
    assert!(
        text.contains("SKIP  C2   shopify.automation-token"),
        "{text}"
    );
    assert_eq!(report.exit_code(false), 0, "{text}");
    assert_eq!(
        report.exit_code(true),
        0,
        "--strict only fails on missing inputs: {text}"
    );

    // Every printed line is clean of every secret in the environment.
    for var in Var::ALL.iter().filter(|var| var.is_secret()) {
        for (name, value) in env.iter().filter(|(name, _)| name == var.name()) {
            assert!(!text.contains(value.as_str()), "{name} leaked:\n{text}");
        }
    }
}

#[tokio::test]
async fn the_json_report_has_a_status_per_check() {
    let (server, env) = healthy_world().await;
    let rig = rig_from(server, &env).await;
    let (report, ctx) = rig.report().await;
    let json: serde_json::Value =
        serde_json::from_str(&report.render_json(&ctx.redactor, false)).unwrap();
    assert_eq!(json["ok"], true);
    assert_eq!(json["environment"], "production");
    let checks = json["checks"].as_array().unwrap();
    assert_eq!(checks.len(), 17);
    assert!(
        checks
            .iter()
            .all(|c| c["status"].is_string() && c["detail"].is_string() && c["row"].is_u64())
    );
    let automation = checks
        .iter()
        .find(|c| c["id"] == "shopify.automation-token")
        .unwrap();
    assert_eq!(automation["skip_kind"], "not_verifiable");
}

#[tokio::test]
async fn one_failing_vendor_fails_the_run_and_only_its_line() {
    let (server, mut env) = healthy_world().await;
    // A second, wrong Anthropic key is not needed: break the Stripe secret's mode instead.
    for (name, value) in &mut env {
        if name == "STRIPE_PUBLISHABLE_KEY" {
            *value = "pk_live_not_a_real_key_marker".to_owned();
        }
    }
    let rig = rig_from(server, &env).await;
    let (report, ctx) = rig.report().await;
    let text = report.render_text(&ctx.redactor, false);
    assert_eq!(report.summary().fail, 1, "{text}");
    assert!(text.contains("FAIL  C11  stripe.account"), "{text}");
    assert_eq!(report.exit_code(false), 1);
    assert!(text.contains("(exit 1)"));
}

#[tokio::test]
async fn the_command_layer_prints_the_report_and_exits_0_against_healthy_vendors() {
    use std::io::Cursor;
    use std::sync::Arc;

    use clap::Parser as _;
    use rsctl::app::{self, Io, Runtime};
    use rsctl::cli::Cli;
    use rsctl::doctor::Endpoints;
    use rsctl::vars::MapEnv;

    let (server, env) = healthy_world().await;
    let borrowed: Vec<(&str, &str)> = env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    for (extra, json) in [("--strict", false), ("--json", true)] {
        let runtime = Runtime {
            env: Arc::new(MapEnv::from_pairs(&borrowed)),
            endpoints: Endpoints::all_at(&server.uri()),
            clock: Arc::new(crate::support::now),
        };
        let cli = Cli::try_parse_from(["rsctl", "doctor", extra]).unwrap();
        let (mut stdin, mut out, mut err) = (Cursor::new(Vec::new()), Vec::new(), Vec::new());
        let code = app::run(
            cli,
            runtime,
            &mut Io {
                stdin: &mut stdin,
                stdout: &mut out,
                stderr: &mut err,
            },
        )
        .await;
        let (out, err) = (
            String::from_utf8(out).unwrap(),
            String::from_utf8(err).unwrap(),
        );
        assert_eq!(code, 0, "{out}\n{err}");
        assert_eq!(err, "");
        if json {
            let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
            assert_eq!(parsed["summary"]["pass"], 16);
        } else {
            assert_eq!(
                out.lines().filter(|l| l.starts_with("PASS")).count(),
                16,
                "{out}"
            );
            assert!(out.contains("16 passed, 0 failed, 1 skipped"), "{out}");
        }
    }
}
