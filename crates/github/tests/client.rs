//! The REST client against a fake GitHub on loopback (PLAN §15, §21, §23; ADR-122, ADR-125):
//! installation tokens, Git database writes, pull requests, check runs, error mapping, spans.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::too_many_lines
)]

mod support;

use std::time::Duration as StdDuration;

use github::{
    Access, BatchId, BranchName, BranchRejection, ClientConfig, GitHubError, Permission, PrLimits,
    RateLimitKind, RefUpdate, RepositoryId, Sha, ThemeRequirement, TokenScope, Verification,
    plan_pull_requests, verification_check_run,
};
use serde_json::json;
use support::{
    CLIENT_ID, Fake, HEADER, HEADER_FIXED, HEADER_FIXED_2, Injected, LOCALE_FIXED, OWNER, REPO,
    batch, installation, repo_ref, scope, seed,
};
use time::Duration;
use url::Url;

#[tokio::test]
async fn get_app_authenticates_with_a_valid_jwt() {
    let fake = Fake::start().await;
    let app = fake.client().app().await.unwrap();
    assert_eq!(app.id, 123);
    assert_eq!(app.client_id.as_deref(), Some(CLIENT_ID));
    let requests = fake.requests();
    let auth = &requests[0].headers["authorization"];
    assert!(auth.starts_with("Bearer ey"), "a JWT, not a token");
}

#[tokio::test]
async fn every_request_pins_the_api_version_and_media_type() {
    let fake = Fake::start().await;
    let base = seed(&fake);
    let client = fake.client();
    let repo = client.repository(installation(), repo_ref(), scope());
    repo.commit_tree(&base).await.unwrap();
    for request in fake.requests() {
        assert_eq!(request.headers["x-github-api-version"], "2026-03-10");
        assert_eq!(request.headers["accept"], "application/vnd.github+json");
        assert_eq!(request.headers["user-agent"], "rampsmith");
    }
}

#[tokio::test]
async fn installation_token_request_is_narrowed_to_repository_and_permissions() {
    let fake = Fake::start().await;
    let client = fake.client();
    let token = client
        .installation_token(installation(), &scope())
        .await
        .unwrap();
    assert_eq!(
        token.expires_at(),
        fake.clock.now_for_test() + Duration::hours(1)
    );
    let requests = fake.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].method, "POST");
    assert_eq!(requests[0].path, "/app/installations/4242/access_tokens");
    assert_eq!(
        requests[0].json(),
        json!({
            "repository_ids": [42],
            "permissions": {
                "checks": "write",
                "contents": "write",
                "metadata": "read",
                "pull_requests": "write"
            }
        })
    );
}

#[tokio::test]
async fn installation_tokens_are_cached_per_scope() {
    let fake = Fake::start().await;
    let client = fake.client();
    let a = client
        .installation_token(installation(), &scope())
        .await
        .unwrap();
    let b = client
        .installation_token(installation(), &scope())
        .await
        .unwrap();
    assert!(std::sync::Arc::ptr_eq(&a, &b));
    assert_eq!(fake.state().minted.len(), 1);
    let read = TokenScope::read_theme(RepositoryId::new(42));
    client
        .installation_token(installation(), &read)
        .await
        .unwrap();
    assert_eq!(
        fake.state().minted.len(),
        2,
        "another scope mints its own token"
    );
}

#[tokio::test]
async fn installation_tokens_refresh_five_minutes_before_expiry() {
    let fake = Fake::start().await;
    let client = fake.client();
    client
        .installation_token(installation(), &scope())
        .await
        .unwrap();
    fake.clock.advance(Duration::minutes(54));
    client
        .installation_token(installation(), &scope())
        .await
        .unwrap();
    assert_eq!(fake.state().minted.len(), 1, "6 minutes left: still cached");
    fake.clock
        .advance(Duration::minutes(1) + Duration::seconds(1));
    client
        .installation_token(installation(), &scope())
        .await
        .unwrap();
    assert_eq!(
        fake.state().minted.len(),
        2,
        "under 5 minutes left: refreshed"
    );
}

#[tokio::test]
async fn concurrent_callers_share_one_token_refresh() {
    let fake = Fake::start().await;
    let client = fake.client();
    let s = scope();
    let (a, b, c) = tokio::join!(
        client.installation_token(installation(), &s),
        client.installation_token(installation(), &s),
        client.installation_token(installation(), &s),
    );
    assert!(a.is_ok() && b.is_ok() && c.is_ok());
    assert_eq!(fake.state().minted.len(), 1);
}

#[tokio::test]
async fn a_rejected_token_is_dropped_and_the_next_call_mints_a_new_one() {
    let fake = Fake::start().await;
    let base = seed(&fake);
    let client = fake.client();
    let repo = client.repository(installation(), repo_ref(), scope());
    repo.commit_tree(&base).await.unwrap();
    fake.inject(Injected::json(401, json!({"message": "Bad credentials"})));
    assert_eq!(
        repo.commit_tree(&base).await,
        Err(GitHubError::Unauthorized)
    );
    repo.commit_tree(&base).await.unwrap();
    assert_eq!(fake.state().minted.len(), 2);
}

#[tokio::test]
async fn repository_calls_use_the_installation_token() {
    let fake = Fake::start().await;
    let base = seed(&fake);
    let client = fake.client();
    let repo = client.repository(installation(), repo_ref(), scope());
    repo.commit_tree(&base).await.unwrap();
    let minted = fake.state().minted[0].clone();
    let requests = fake.requests();
    let last = requests.last().unwrap();
    assert_eq!(
        last.path,
        format!("/repos/{OWNER}/{REPO}/git/commits/{base}")
    );
    assert_eq!(last.headers["authorization"], format!("Bearer {minted}"));
}

#[tokio::test]
async fn theme_tree_lists_only_regular_theme_files() {
    let fake = Fake::start().await;
    let base = seed(&fake);
    let client = fake.client();
    let repo = client.repository(installation(), repo_ref(), scope());
    let tree = repo.theme_tree(&base).await.unwrap();
    assert!(tree.paths.contains(&".env".to_owned()));
    assert!(tree.paths.contains(&"snippets/leak.liquid".to_owned()));
    let readable: Vec<&str> = tree.theme_files.iter().map(|f| f.path().as_str()).collect();
    assert_eq!(
        readable,
        [
            "config/settings_data.json",
            "layout/theme.liquid",
            "locales/en.default.json",
            "sections/header.liquid",
            "templates/index.json",
        ]
    );
    let header = tree
        .theme_files
        .iter()
        .find(|f| f.path().as_str() == "sections/header.liquid")
        .unwrap();
    assert_eq!(
        repo.read_theme_file(header).await.unwrap(),
        HEADER.as_bytes()
    );
}

#[tokio::test]
async fn symlinks_in_theme_directories_are_never_read() {
    let fake = Fake::start().await;
    let base = seed(&fake);
    let client = fake.client();
    let repo = client.repository(installation(), repo_ref(), scope());
    let tree = repo.tree(&base).await.unwrap();
    assert!(
        tree.theme_files
            .iter()
            .all(|f| f.path().as_str() != "snippets/leak.liquid"),
        "a symlink under snippets/ must not be readable"
    );
    let blob_reads = fake
        .requests()
        .iter()
        .filter(|r| r.path.contains("/git/blobs/"))
        .count();
    assert_eq!(blob_reads, 0);
}

#[tokio::test]
async fn a_repository_without_a_theme_fails_the_structure_check() {
    let fake = Fake::start().await;
    let commit = fake
        .state()
        .seed(&[("package.json", "{}"), ("src/main.ts", "")], &[]);
    let client = fake.client();
    let repo = client.repository(installation(), repo_ref(), scope());
    let err = repo
        .theme_tree(&Sha::parse(&commit).unwrap())
        .await
        .unwrap_err();
    let GitHubError::Structure(structure) = err else {
        panic!("expected a structure error, got {err:?}");
    };
    assert_eq!(structure.missing.len(), 4);
    assert_eq!(structure.missing[0], ThemeRequirement::LayoutThemeLiquid);
}

#[tokio::test]
async fn a_truncated_tree_is_an_error() {
    let fake = Fake::start().await;
    let base = seed(&fake);
    fake.state().truncate_trees = true;
    let client = fake.client();
    let repo = client.repository(installation(), repo_ref(), scope());
    assert_eq!(repo.tree(&base).await, Err(GitHubError::TreeTruncated));
}

#[tokio::test]
async fn push_builds_one_commit_per_fix_on_the_fix_branch() {
    let fake = Fake::start().await;
    let base = seed(&fake);
    let plans = plan_pull_requests(&batch(), "main", PrLimits::default()).unwrap();
    assert_eq!(plans.len(), 1);
    let plan = &plans[0];
    let client = fake.client();
    let repo = client.repository(installation(), repo_ref(), scope());
    let head = repo
        .push(plan, &base, RefUpdate::FastForward)
        .await
        .unwrap();

    let state = fake.state();
    assert_eq!(state.refs["rampsmith/fix-b1"], head.as_str());
    assert_eq!(
        state.refs["main"],
        base.as_str(),
        "the connected branch is untouched"
    );
    let second = &state.commits[head.as_str()];
    assert!(
        second
            .message
            .starts_with("fix(a11y): mark cart link for styling [WCAG 2.4.4]")
    );
    assert!(second.message.ends_with("Rampsmith-Fix: fx-2\n"));
    let first = &state.commits[&second.parents[0]];
    assert!(first.message.ends_with("Rampsmith-Fix: fx-1\n"));
    assert_eq!(first.parents, vec![base.to_string()]);
    let files = state.files_at(head.as_str());
    assert_eq!(files["sections/header.liquid"], HEADER_FIXED_2);
    assert_eq!(files["locales/en.default.json"], LOCALE_FIXED);
    assert_eq!(
        files["layout/theme.liquid"],
        "<html>{{ content_for_layout }}</html>\n"
    );
    let after_first = state.files_at(&second.parents[0]);
    assert_eq!(after_first["sections/header.liquid"], HEADER_FIXED);
}

#[tokio::test]
async fn re_derive_force_pushes_and_fast_forward_refuses_a_rewrite() {
    let fake = Fake::start().await;
    let base = seed(&fake);
    let plan = plan_pull_requests(&batch(), "main", PrLimits::default())
        .unwrap()
        .remove(0);
    let client = fake.client();
    let repo = client.repository(installation(), repo_ref(), scope());
    repo.push(&plan, &base, RefUpdate::FastForward)
        .await
        .unwrap();

    // The merchant edits the theme in Shopify; the connected branch moves.
    let moved = {
        let mut state = fake.state();
        let tree = state.commits[base.as_str()].tree.clone();
        let commit = state.add_commit(&tree, vec![base.to_string()], "Update from Shopify");
        state.refs.insert("main".to_owned(), commit.clone());
        Sha::parse(&commit).unwrap()
    };
    let err = repo
        .push(&plan, &moved, RefUpdate::FastForward)
        .await
        .unwrap_err();
    assert!(
        matches!(err, GitHubError::Validation { ref message } if message.contains("fast forward"))
    );
    let head = repo.push(&plan, &moved, RefUpdate::Rederive).await.unwrap();
    let state = fake.state();
    assert_eq!(state.refs["rampsmith/fix-b1"], head.as_str());
    let patches: Vec<bool> = state
        .requests
        .iter()
        .filter(|r| r.method == "PATCH" && r.path.contains("/git/refs/"))
        .map(|r| r.json()["force"].as_bool().unwrap())
        .collect();
    assert_eq!(patches, [false, true], "force only for the re-derive");
}

#[tokio::test]
async fn pull_requests_are_opened_once_then_updated() {
    let fake = Fake::start().await;
    let base = seed(&fake);
    let plan = plan_pull_requests(&batch(), "main", PrLimits::default())
        .unwrap()
        .remove(0);
    let client = fake.client();
    let repo = client.repository(installation(), repo_ref(), scope());
    let head = repo
        .push(&plan, &base, RefUpdate::FastForward)
        .await
        .unwrap();
    let main = BranchName::parse("main").unwrap();
    let opened = repo
        .open_or_update_pull_request(&plan, &main)
        .await
        .unwrap();
    assert_eq!(opened.number, 1);
    assert_eq!(opened.head_sha, head);
    let updated = repo
        .open_or_update_pull_request(&plan, &main)
        .await
        .unwrap();
    assert_eq!(updated.number, 1);
    let state = fake.state();
    assert_eq!(state.pulls.len(), 1);
    assert_eq!(state.pulls[0].head, "rampsmith/fix-b1");
    assert_eq!(state.pulls[0].base, "main");
    assert_eq!(state.pulls[0].title, plan.title);
    assert!(state.pulls[0].body.contains("## How to undo"));
    let creates = state
        .requests
        .iter()
        .filter(|r| r.method == "POST" && r.path.ends_with("/pulls"))
        .count();
    assert_eq!(creates, 1);
    let list = state
        .requests
        .iter()
        .find(|r| r.method == "GET" && r.path.ends_with("/pulls"))
        .unwrap();
    assert!(list.query.contains("state=open"));
    assert!(list.query.contains("head=octo-shop%3Arampsmith%2Ffix-b1"));
}

#[tokio::test]
async fn a_pull_request_into_its_own_head_branch_is_refused_before_any_request() {
    let fake = Fake::start().await;
    let plan = plan_pull_requests(&batch(), "main", PrLimits::default())
        .unwrap()
        .remove(0);
    let client = fake.client();
    let repo = client.repository(installation(), repo_ref(), scope());
    let head_as_base = BranchName::parse("rampsmith/fix-b1").unwrap();
    assert_eq!(
        repo.open_or_update_pull_request(&plan, &head_as_base).await,
        Err(GitHubError::Branch(BranchRejection::Connected))
    );
    assert!(fake.requests().is_empty());
}

#[tokio::test]
async fn check_runs_are_created_then_updated() {
    let fake = Fake::start().await;
    let client = fake.client();
    let repo = client.repository(installation(), repo_ref(), scope());
    let sha = Sha::parse(&"c".repeat(40)).unwrap();
    let batch_id = BatchId::parse("b1").unwrap();
    let details = Url::parse("https://app.rampsmith.example/batches/b1").unwrap();
    let neutral = verification_check_run(
        sha.clone(),
        &batch_id,
        Verification::NoPreviewTheme,
        &details,
        fake.clock.now_for_test(),
    )
    .unwrap();
    let id = repo.upsert_check_run(None, &neutral).await.unwrap();
    let passed = verification_check_run(
        sha,
        &batch_id,
        Verification::Passed { resolved: 2 },
        &details,
        fake.clock.now_for_test(),
    )
    .unwrap();
    assert_eq!(repo.upsert_check_run(Some(id), &passed).await.unwrap(), id);
    let state = fake.state();
    assert_eq!(state.check_runs.len(), 1);
    let stored = &state.check_runs[0].1;
    assert_eq!(stored["conclusion"], "success");
    assert_eq!(stored["name"], "Rampsmith verification");
    assert!(
        stored.get("head_sha").is_none(),
        "update does not resend head_sha"
    );
    let create = state
        .requests
        .iter()
        .find(|r| r.method == "POST" && r.path.ends_with("/check-runs"))
        .unwrap();
    assert_eq!(create.json()["conclusion"], "neutral");
    assert_eq!(create.json()["head_sha"], "c".repeat(40));
}

#[tokio::test]
async fn primary_rate_limits_map_to_a_typed_error_with_the_reset_wait() {
    let fake = Fake::start().await;
    let base = seed(&fake);
    let client = fake.client();
    let repo = client.repository(installation(), repo_ref(), scope());
    client
        .installation_token(installation(), &scope())
        .await
        .unwrap();
    let reset = fake.clock.now_for_test().unix_timestamp() + 120;
    fake.inject(
        Injected::json(403, json!({"message": "API rate limit exceeded"}))
            .header("x-ratelimit-remaining", "0")
            .header("x-ratelimit-reset", reset.to_string()),
    );
    let err = repo.commit_tree(&base).await.unwrap_err();
    assert_eq!(
        err,
        GitHubError::RateLimited {
            kind: RateLimitKind::Primary,
            retry_after: StdDuration::from_mins(2)
        }
    );
    assert!(err.is_retryable());
}

#[tokio::test]
async fn secondary_rate_limits_honour_retry_after() {
    let fake = Fake::start().await;
    let client = fake.client();
    fake.inject(
        Injected::json(
            429,
            json!({"message": "You have exceeded a secondary rate limit"}),
        )
        .header("retry-after", "30"),
    );
    let err = client.app().await.unwrap_err();
    assert_eq!(
        err,
        GitHubError::RateLimited {
            kind: RateLimitKind::Secondary,
            retry_after: StdDuration::from_secs(30)
        }
    );
}

#[tokio::test]
async fn status_codes_map_to_typed_errors() {
    let fake = Fake::start().await;
    let base = seed(&fake);
    let client = fake.client();
    let repo = client.repository(installation(), repo_ref(), scope());
    client
        .installation_token(installation(), &scope())
        .await
        .unwrap();
    let cases = [
        (
            403,
            GitHubError::Forbidden {
                message: "Resource not accessible by integration".to_owned(),
            },
        ),
        (404, GitHubError::NotFound),
        (
            409,
            GitHubError::Conflict {
                message: "Resource not accessible by integration".to_owned(),
            },
        ),
        (
            422,
            GitHubError::Validation {
                message: "Resource not accessible by integration".to_owned(),
            },
        ),
        (502, GitHubError::Server { status: 502 }),
        (418, GitHubError::UnexpectedStatus { status: 418 }),
    ];
    for (status, expected) in cases {
        fake.inject(Injected::json(
            status,
            json!({"message": "Resource not accessible by integration"}),
        ));
        assert_eq!(repo.commit_tree(&base).await, Err(expected), "{status}");
    }
}

#[tokio::test]
async fn a_missing_branch_is_none_not_an_error() {
    let fake = Fake::start().await;
    seed(&fake);
    let client = fake.client();
    let repo = client.repository(installation(), repo_ref(), scope());
    let missing = BranchName::parse("rampsmith/fix-none").unwrap();
    assert_eq!(repo.branch_head(&missing).await, Ok(None));
    let main = BranchName::parse("main").unwrap();
    assert!(repo.branch_head(&main).await.unwrap().is_some());
}

#[tokio::test]
async fn redirects_are_not_followed() {
    let fake = Fake::start().await;
    let client = fake.client();
    let target = format!("{}/stolen", fake.base_url);
    fake.inject(Injected::json(307, json!({})).header("location", target));
    assert_eq!(
        client.app().await,
        Err(GitHubError::UnexpectedStatus { status: 307 })
    );
    assert!(fake.requests().iter().all(|r| r.path != "/stolen"));
}

#[tokio::test]
async fn oversized_responses_are_refused() {
    let fake = Fake::start().await;
    let client = fake.client_with(ClientConfig {
        base_url: fake.base_url.clone(),
        max_response_bytes: 1024,
        ..ClientConfig::default()
    });
    fake.inject(Injected {
        status: 200,
        headers: vec![],
        body: vec![b' '; 4096],
    });
    assert_eq!(
        client.app().await,
        Err(GitHubError::ResponseTooLarge { limit: 1024 })
    );
}

#[tokio::test]
async fn malformed_token_responses_never_echo_the_token() {
    let fake = Fake::start().await;
    let client = fake.client();
    fake.inject(Injected::json(
        201,
        json!({"token": 12345, "expires_at": "ghs_EchoedSecretInExpiry"}),
    ));
    let err = client
        .installation_token(installation(), &scope())
        .await
        .unwrap_err();
    assert!(matches!(err, GitHubError::Decode(_)));
    fake.inject(Injected::json(
        201,
        json!({"token": "ghs_EchoedSecretValue", "expires_at": "not a date"}),
    ));
    let err2 = client
        .installation_token(installation(), &scope())
        .await
        .unwrap_err();
    let shown = format!("{err} {err:?} {err2} {err2:?}");
    assert!(!shown.contains("ghs_"), "{shown}");
}

#[tokio::test]
async fn too_many_repositories_are_refused_before_any_request() {
    let fake = Fake::start().await;
    let client = fake.client();
    let mut wide = TokenScope::installation().permission(Permission::Contents, Access::Read);
    for id in 0..=500 {
        wide = wide.repository(RepositoryId::new(id));
    }
    assert!(matches!(
        client.installation_token(installation(), &wide).await,
        Err(GitHubError::InvalidRequest(_))
    ));
    assert!(fake.requests().is_empty());
}

#[tokio::test]
async fn the_client_refuses_plain_http_to_a_remote_host() {
    let fake = Fake::start().await;
    let result = github::GitHub::new(
        ClientConfig {
            base_url: "http://api.github.com".to_owned(),
            ..ClientConfig::default()
        },
        support::credentials(),
        fake.clock.clone(),
    );
    assert!(matches!(result, Err(GitHubError::Config(_))));
}
