//! `infra/github-app-manifest.json` against GitHub's manifest schema
//! (<https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest>,
//! checked 2026-10-17) and PLAN §15's least-privilege permissions (ADR-127).

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::collections::BTreeSet;

use github::{RepositoryId, TokenScope};
use serde_json::{Value, json};
use url::Url;

/// The placeholder host, until the founder registers the domain (LAUNCH C rows 4 and 10).
const PLACEHOLDER_HOST: &str = "replace-with-app-domain.example";

fn manifest() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../infra/github-app-manifest.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

#[test]
fn manifest_uses_only_documented_parameters() {
    let documented: BTreeSet<&str> = [
        "name",
        "url",
        "hook_attributes",
        "redirect_url",
        "callback_urls",
        "setup_url",
        "description",
        "public",
        "default_events",
        "default_permissions",
        "request_oauth_on_install",
        "setup_on_update",
    ]
    .into_iter()
    .collect();
    let m = manifest();
    for key in m.as_object().unwrap().keys() {
        assert!(documented.contains(key.as_str()), "undocumented key {key}");
    }
    let hook = m["hook_attributes"].as_object().unwrap();
    assert!(hook.keys().all(|k| k == "url" || k == "active"));
    assert!(m["url"].is_string(), "url is required");
    assert!(
        m["hook_attributes"]["url"].is_string(),
        "hook url is required"
    );
    assert_eq!(m["hook_attributes"]["active"], true);
    assert!(m["callback_urls"].as_array().unwrap().len() <= 10);
    assert!(m["description"].as_str().unwrap().len() > 20);
}

#[test]
fn manifest_requests_exactly_the_least_privilege_permissions() {
    assert_eq!(
        manifest()["default_permissions"],
        json!({
            "metadata": "read",
            "contents": "write",
            "pull_requests": "write",
            "checks": "write"
        })
    );
    assert!(manifest()["default_permissions"].get("workflows").is_none());
}

#[test]
fn fix_tokens_never_ask_for_more_than_the_manifest_grants() {
    let scope = serde_json::to_value(TokenScope::fix_pull_requests(RepositoryId::new(1))).unwrap();
    assert_eq!(scope["permissions"], manifest()["default_permissions"]);
}

#[test]
fn manifest_subscribes_only_to_events_that_can_be_selected() {
    // `installation` and `installation_repositories` reach every App by default and cannot be
    // subscribed to, so only `pull_request` and `push` are listed (ADR-127).
    assert_eq!(
        manifest()["default_events"],
        json!(["pull_request", "push"])
    );
}

#[test]
fn manifest_is_private_and_verifies_the_installer() {
    let m = manifest();
    assert_eq!(m["public"], false);
    // Requesting OAuth during installation lets the app confirm the installer owns the
    // installation instead of trusting a spoofable `installation_id` on a setup URL.
    assert_eq!(m["request_oauth_on_install"], true);
    assert!(m.get("setup_url").is_none());
}

#[test]
fn manifest_urls_are_https_on_one_clearly_marked_host() {
    let m = manifest();
    let mut urls = vec![
        m["url"].as_str().unwrap(),
        m["hook_attributes"]["url"].as_str().unwrap(),
        m["redirect_url"].as_str().unwrap(),
    ];
    urls.extend(
        m["callback_urls"]
            .as_array()
            .unwrap()
            .iter()
            .map(|u| u.as_str().unwrap()),
    );
    let hosts: BTreeSet<String> = urls
        .iter()
        .map(|u| {
            let url = Url::parse(u).unwrap();
            assert_eq!(url.scheme(), "https", "{u}");
            url.host_str().unwrap().to_owned()
        })
        .collect();
    assert_eq!(hosts.len(), 1, "every URL uses the app's one domain");
    let host = hosts.into_iter().next().unwrap();
    assert!(!host.ends_with("github.com"));
    if host.ends_with(".example") {
        assert_eq!(
            host, PLACEHOLDER_HOST,
            "placeholders use the documented host"
        );
    }
}
