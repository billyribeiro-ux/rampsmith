//! Client spans (PLAN §21, ADR-125) carry operation names and status, never tokens, JWTs, key
//! material, repository or file names, or file content; `Debug` output never shows credentials.
//!
//! This test has its own binary: a thread-local subscriber can miss spans when other tests in
//! the same binary register the same callsites first on threads without one.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod support;

use github::{BranchName, PrLimits, RefUpdate, plan_pull_requests};
use secrecy::ExposeSecret;
use serde_json::json;
use support::{
    Captured, Fake, Injected, OWNER, REPO, batch, installation, key, pem, repo_ref, scope, seed,
};
use tracing_subscriber::layer::SubscriberExt;

#[tokio::test]
async fn spans_and_debug_output_never_contain_secrets_or_content() {
    let captured = Captured::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    let _guard = tracing::subscriber::set_default(subscriber);
    tracing::callsite::rebuild_interest_cache();

    let fake = Fake::start().await;
    let base = seed(&fake);
    let plan = plan_pull_requests(&batch(), "main", PrLimits::default())
        .unwrap()
        .remove(0);
    let client = fake.client();
    client.app().await.unwrap();
    let repo = client.repository(installation(), repo_ref(), scope());
    let tree = repo.theme_tree(&base).await.unwrap();
    for file in &tree.theme_files {
        repo.read_theme_file(file).await.unwrap();
    }
    repo.push(&plan, &base, RefUpdate::FastForward)
        .await
        .unwrap();
    repo.open_or_update_pull_request(&plan, &BranchName::parse("main").unwrap())
        .await
        .unwrap();
    fake.inject(Injected::json(403, json!({"message": "nope"})));
    let _ = repo.commit_tree(&base).await;

    let text = captured.text();
    assert!(text.contains("span github.request"), "{text}");
    for op in [
        "github.app.get",
        "github.app.create_installation_token",
        "github.git.get_tree",
        "github.git.get_blob",
        "github.git.create_blob",
        "github.git.create_tree",
        "github.git.create_commit",
        "github.git.create_ref",
        "github.pulls.list",
        "github.pulls.create",
    ] {
        assert!(text.contains(op), "missing span for {op}");
    }
    assert!(text.contains("otel.kind=client"));
    assert!(text.contains("url.template=/repos/{owner}/{repo}/git/blobs"));
    assert!(text.contains("github.installation_id=4242"));
    assert!(text.contains("http.response.status_code=201"));
    assert!(text.contains("github.request_id=FAKE:REQ:0001"));
    assert!(text.contains("error.type=forbidden"));

    let (minted, jwts) = {
        let state = fake.state();
        (state.minted.clone(), state.jwts.clone())
    };
    assert!(!minted.is_empty() && !jwts.is_empty());
    let mut secrets: Vec<String> = minted.clone();
    secrets.extend(jwts.iter().cloned());
    secrets.extend(
        jwts.iter()
            .map(|j| j.rsplit_once('.').unwrap().1.to_owned()),
    );
    let key_body = pem("RSA PRIVATE KEY", &key().pkcs1);
    secrets.push(key_body.lines().nth(3).unwrap().to_owned());
    for marker in [
        "FILE-CONTENT-MARKER",
        "visually-hidden",
        "hunter2",
        "content_for_layout",
        "Rampsmith-Fix",
        "Links must have discernible text",
        OWNER,
        REPO,
        "sections/header.liquid",
        "rampsmith/fix-b1",
    ] {
        secrets.push(marker.to_owned());
    }
    for secret in &secrets {
        assert!(
            !text.contains(secret.as_str()),
            "span or event leaked {secret}"
        );
    }
    let debug = format!("{client:?} {repo:?} {tree:?}");
    for secret in minted.iter().chain(jwts.iter()) {
        assert!(
            !debug.contains(secret.as_str()),
            "Debug leaked a credential"
        );
    }
    let token = client
        .installation_token(installation(), &scope())
        .await
        .unwrap();
    assert!(!format!("{token:?}").contains("ghs_"));
    let jwt = support::credentials()
        .jwt(fake.clock.now_for_test())
        .unwrap();
    assert!(!format!("{jwt:?}").contains(jwt.expose_secret()));
}
