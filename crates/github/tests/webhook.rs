//! Webhook intake (PLAN §15, §18, §23; ADR-126): constant-time HMAC over the raw body,
//! the delivery id, typed payloads, and property tests that hostile input never panics.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::fmt::Write as _;

use github::{
    Event, InstallationAction, InstallationRepositoriesAction, PullRequestAction,
    RepositorySelection, WebhookError, WebhookVerifier,
};
use hmac::{Hmac, KeyInit, Mac};
use http::{HeaderMap, HeaderValue};
use proptest::prelude::*;
use secrecy::SecretString;
use serde_json::{Value, json};
use sha2::Sha256;

const SECRET: &str = "whsec-test-only-secret";

fn sign(secret: &str, body: &[u8]) -> String {
    let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(secret.as_bytes()).unwrap();
    mac.update(body);
    let digest = mac.finalize().into_bytes();
    digest.iter().fold("sha256=".to_owned(), |mut out, b| {
        write!(out, "{b:02x}").unwrap();
        out
    })
}

fn verifier() -> WebhookVerifier {
    WebhookVerifier::new(SecretString::from(SECRET)).unwrap()
}

fn headers(event: &str, body: &[u8]) -> HeaderMap {
    let mut h = HeaderMap::new();
    h.insert(
        "x-hub-signature-256",
        HeaderValue::from_str(&sign(SECRET, body)).unwrap(),
    );
    h.insert("x-github-event", HeaderValue::from_str(event).unwrap());
    h.insert(
        "x-github-delivery",
        HeaderValue::from_static("72d3162e-cc78-11e3-81ab-4c9367dc0958"),
    );
    h.insert("content-type", HeaderValue::from_static("application/json"));
    h.insert(
        "user-agent",
        HeaderValue::from_static("GitHub-Hookshot/044aadd"),
    );
    h
}

fn deliver(event: &str, payload: &Value) -> Result<github::Delivery, WebhookError> {
    let body = serde_json::to_vec(payload).unwrap();
    verifier().verify_and_parse(&headers(event, &body), &body)
}

fn sha(c: char) -> String {
    c.to_string().repeat(40)
}

fn repository() -> Value {
    json!({
        "id": 1_296_269,
        "node_id": "MDEwOlJlcG9zaXRvcnkxMjk2MjY5",
        "name": "dawn-theme",
        "full_name": "octo-shop/dawn-theme",
        "private": true,
        "owner": {"login": "octo-shop", "id": 1, "type": "Organization"},
        "default_branch": "main"
    })
}

#[test]
fn installation_created_parses() {
    let payload = json!({
        "action": "created",
        "installation": {
            "id": 4242,
            "account": {"login": "octo-shop", "id": 1, "type": "Organization"},
            "repository_selection": "selected",
            "app_id": 123,
            "permissions": {"contents": "write", "metadata": "read"},
            "events": ["pull_request", "push"],
            "suspended_at": null
        },
        "repositories": [
            {"id": 1_296_269, "node_id": "x", "name": "dawn-theme", "full_name": "octo-shop/dawn-theme", "private": true}
        ],
        "requester": null,
        "sender": {"login": "merchant", "id": 9}
    });
    let delivery = deliver("installation", &payload).unwrap();
    assert_eq!(delivery.id.as_str(), "72d3162e-cc78-11e3-81ab-4c9367dc0958");
    let Event::Installation(event) = delivery.event else {
        panic!("wrong event");
    };
    assert_eq!(event.action, InstallationAction::Created);
    assert_eq!(event.installation.id.get(), 4242);
    assert_eq!(
        event.installation.account.login.as_deref(),
        Some("octo-shop")
    );
    assert_eq!(
        event.installation.repository_selection,
        RepositorySelection::Selected
    );
    assert_eq!(event.repositories[0].full_name, "octo-shop/dawn-theme");
}

#[test]
fn installation_actions_beyond_the_known_ones_parse_as_other() {
    let mut payload = json!({
        "action": "deleted",
        "installation": {"id": 1, "account": {"id": 2, "name": "Acme", "slug": "acme"}, "repository_selection": "all"},
        "sender": {"login": "x"}
    });
    let Event::Installation(event) = deliver("installation", &payload).unwrap().event else {
        panic!("wrong event");
    };
    assert_eq!(event.action, InstallationAction::Deleted);
    assert_eq!(
        event.installation.account.login, None,
        "enterprise accounts have no login"
    );
    assert!(event.repositories.is_empty(), "{:?}", event.repositories);
    payload["action"] = json!("some_future_action");
    let Event::Installation(event) = deliver("installation", &payload).unwrap().event else {
        panic!("wrong event");
    };
    assert_eq!(event.action, InstallationAction::Other);
}

#[test]
fn installation_repositories_parses() {
    let payload = json!({
        "action": "removed",
        "installation": {"id": 4242, "account": {"login": "octo-shop", "id": 1, "type": "Organization"}},
        "repository_selection": "selected",
        "repositories_added": [],
        "repositories_removed": [{"id": 7, "node_id": "y", "name": "old", "full_name": "octo-shop/old", "private": false}],
        "requester": null,
        "sender": {"login": "merchant"}
    });
    let Event::InstallationRepositories(event) = deliver("installation_repositories", &payload)
        .unwrap()
        .event
    else {
        panic!("wrong event");
    };
    assert_eq!(event.action, InstallationRepositoriesAction::Removed);
    assert_eq!(event.installation.id.get(), 4242);
    assert_eq!(event.repositories_removed[0].id.get(), 7);
    assert!(
        event.repositories_added.is_empty(),
        "{:?}",
        event.repositories_added
    );
}

#[test]
fn pull_request_closed_and_merged_parses() {
    let payload = json!({
        "action": "closed",
        "number": 12,
        "pull_request": {
            "id": 77_012,
            "number": 12,
            "state": "closed",
            "merged": true,
            "merged_at": "2026-10-17T12:00:00Z",
            "title": "fix(a11y): 2 accessibility fixes from Rampsmith",
            "head": {"ref": "rampsmith/fix-b1", "sha": sha('a'), "label": "octo-shop:rampsmith/fix-b1"},
            "base": {"ref": "main", "sha": sha('b')}
        },
        "repository": repository(),
        "installation": {"id": 4242, "node_id": "z"},
        "sender": {"login": "dev"}
    });
    let Event::PullRequest(event) = deliver("pull_request", &payload).unwrap().event else {
        panic!("wrong event");
    };
    assert_eq!(event.action, PullRequestAction::Closed);
    assert_eq!(event.number, 12);
    assert_eq!(event.pull_request.merged, Some(true));
    assert_eq!(event.pull_request.head.reference, "rampsmith/fix-b1");
    assert_eq!(event.pull_request.base.sha.as_str(), sha('b'));
    assert_eq!(event.repository.id.get(), 1_296_269);
    assert_eq!(event.installation.unwrap().id.get(), 4242);
}

#[test]
fn every_documented_pull_request_action_parses() {
    for action in [
        "assigned",
        "auto_merge_disabled",
        "auto_merge_enabled",
        "closed",
        "converted_to_draft",
        "demilestoned",
        "dequeued",
        "edited",
        "enqueued",
        "labeled",
        "locked",
        "milestoned",
        "opened",
        "ready_for_review",
        "reopened",
        "review_request_removed",
        "review_requested",
        "synchronize",
        "unassigned",
        "unlabeled",
        "unlocked",
        "stacked",
    ] {
        let payload = json!({
            "action": action,
            "number": 1,
            "pull_request": {"id": 1, "number": 1, "state": "open",
                "head": {"ref": "rampsmith/fix-b1", "sha": sha('a')},
                "base": {"ref": "main", "sha": sha('b')}},
            "repository": repository(),
            "sender": {"login": "dev"}
        });
        assert!(deliver("pull_request", &payload).is_ok(), "{action}");
    }
}

#[test]
fn push_parses_with_changed_paths() {
    let payload = json!({
        "ref": "refs/heads/main",
        "before": sha('0'),
        "after": sha('c'),
        "base_ref": null,
        "created": false,
        "deleted": false,
        "forced": false,
        "compare": "https://github.com/octo-shop/dawn-theme/compare/0...c",
        "commits": [{
            "id": sha('c'),
            "tree_id": sha('d'),
            "distinct": true,
            "message": "Merge pull request #12",
            "timestamp": "2026-10-17T12:00:00Z",
            "author": {"name": "Dev", "email": "dev@example.com"},
            "added": [],
            "removed": [],
            "modified": ["sections/header.liquid", "locales/en.default.json"]
        }],
        "head_commit": {"id": sha('c')},
        "pusher": {"name": "dev", "email": "dev@example.com"},
        "repository": repository(),
        "installation": {"id": 4242},
        "sender": {"login": "dev"}
    });
    let Event::Push(event) = deliver("push", &payload).unwrap().event else {
        panic!("wrong event");
    };
    assert_eq!(event.branch(), Some("main"));
    assert_eq!(event.after.as_str(), sha('c'));
    assert_eq!(
        event.changed_paths().into_iter().collect::<Vec<_>>(),
        ["locales/en.default.json", "sections/header.liquid"]
    );
}

#[test]
fn other_events_are_acknowledged_by_name() {
    let delivery = deliver(
        "ping",
        &json!({"zen": "Keep it logically awesome.", "hook_id": 1}),
    )
    .unwrap();
    assert_eq!(
        delivery.event,
        Event::Other {
            name: "ping".to_owned()
        }
    );
}

#[test]
fn signature_is_checked_before_the_body_is_parsed() {
    let body = b"{not json";
    let mut h = headers("push", body);
    h.insert(
        "x-hub-signature-256",
        HeaderValue::from_str(&sign("another-secret", body)).unwrap(),
    );
    assert_eq!(
        verifier().verify_and_parse(&h, body),
        Err(WebhookError::SignatureMismatch)
    );
    // With a valid signature, the same body is a payload error.
    assert!(matches!(
        verifier().verify_and_parse(&headers("push", body), body),
        Err(WebhookError::InvalidPayload(_))
    ));
}

#[test]
fn missing_and_malformed_headers_are_refused() {
    let body = br#"{"zen":"x"}"#;
    for name in ["x-hub-signature-256", "x-github-event", "x-github-delivery"] {
        let mut h = headers("ping", body);
        h.remove(name);
        assert!(
            matches!(verifier().verify_and_parse(&h, body), Err(WebhookError::MissingHeader(n)) if n == name),
            "{name}"
        );
    }
    let mut h = headers("ping", body);
    h.insert("x-github-delivery", HeaderValue::from_static("../../etc"));
    assert_eq!(
        verifier().verify_and_parse(&h, body),
        Err(WebhookError::InvalidHeader("x-github-delivery"))
    );
    let mut h = headers("ping", body);
    h.insert("x-github-event", HeaderValue::from_static("Push Event"));
    assert_eq!(
        verifier().verify_and_parse(&h, body),
        Err(WebhookError::InvalidHeader("x-github-event"))
    );
    let mut h = headers("ping", body);
    h.insert(
        "content-type",
        HeaderValue::from_static("application/x-www-form-urlencoded"),
    );
    assert_eq!(
        verifier().verify_and_parse(&h, body),
        Err(WebhookError::UnsupportedContentType)
    );
}

#[test]
fn the_previous_secret_is_accepted_during_rotation() {
    let body = br#"{"zen":"x"}"#;
    let mut h = headers("ping", body);
    h.insert(
        "x-hub-signature-256",
        HeaderValue::from_str(&sign("old-secret", body)).unwrap(),
    );
    assert_eq!(
        verifier().verify_and_parse(&h, body),
        Err(WebhookError::SignatureMismatch)
    );
    let rotating = verifier()
        .with_previous(SecretString::from("old-secret"))
        .unwrap();
    assert!(rotating.verify_and_parse(&h, body).is_ok());
}

#[test]
fn webhook_errors_never_contain_the_body_secret_or_signature() {
    let body = br#"{"action": "created", "installation": "SENSITIVE-BODY-TEXT"}"#;
    let signature = sign(SECRET, body);
    let mut tampered = signature.clone();
    let last = tampered.pop().unwrap();
    tampered.push(if last == '0' { '1' } else { '0' });
    let errors = [
        verifier()
            .verify_and_parse(&headers("installation", body), body)
            .unwrap_err(),
        verifier().verify(tampered.as_bytes(), body).unwrap_err(),
    ];
    for err in errors {
        let shown = format!("{err} {err:?}");
        assert!(!shown.contains("SENSITIVE-BODY-TEXT"), "{shown}");
        assert!(!shown.contains(SECRET));
        assert!(!shown.contains(&signature[7..]));
    }
}

fn arbitrary_json() -> impl Strategy<Value = Value> {
    let leaf = prop_oneof![
        Just(Value::Null),
        any::<bool>().prop_map(Value::Bool),
        any::<i64>().prop_map(Value::from),
        any::<f64>()
            .prop_map(|f| serde_json::Number::from_f64(f).map_or(Value::Null, Value::Number)),
        ".{0,24}".prop_map(Value::String),
        "[0-9a-f]{40}".prop_map(Value::String),
    ];
    leaf.prop_recursive(4, 64, 8, |inner| {
        prop_oneof![
            prop::collection::vec(inner.clone(), 0..6).prop_map(Value::Array),
            prop::collection::btree_map(
                prop_oneof![
                    Just("action".to_owned()),
                    Just("installation".to_owned()),
                    Just("id".to_owned()),
                    Just("ref".to_owned()),
                    Just("sha".to_owned()),
                    Just("head".to_owned()),
                    Just("repository".to_owned()),
                    Just("commits".to_owned()),
                    "[a-z_]{1,12}",
                ],
                inner,
                0..8
            )
            .prop_map(|m| Value::Object(m.into_iter().collect())),
        ]
    })
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    #[test]
    fn prop_a_correct_signature_always_verifies(
        secret in "[ -~]{1,64}",
        body in prop::collection::vec(any::<u8>(), 0..2048),
    ) {
        let verifier = WebhookVerifier::new(SecretString::from(secret.clone())).unwrap();
        prop_assert_eq!(verifier.verify(sign(&secret, &body).as_bytes(), &body), Ok(()));
    }

    #[test]
    fn prop_any_change_to_the_body_fails(
        body in prop::collection::vec(any::<u8>(), 1..2048),
        index in any::<prop::sample::Index>(),
        flip in 1_u8..=255,
    ) {
        let signature = sign(SECRET, &body);
        let mut tampered = body.clone();
        let i = index.index(tampered.len());
        tampered[i] ^= flip;
        prop_assert_eq!(
            verifier().verify(signature.as_bytes(), &tampered),
            Err(WebhookError::SignatureMismatch)
        );
    }

    #[test]
    fn prop_any_change_to_the_signature_fails(
        body in prop::collection::vec(any::<u8>(), 0..512),
        index in 7_usize..71,
        replacement in prop::sample::select(b"0123456789abcdef".to_vec()),
    ) {
        let mut signature = sign(SECRET, &body).into_bytes();
        prop_assume!(signature[index] != replacement);
        signature[index] = replacement;
        prop_assert_eq!(
            verifier().verify(&signature, &body),
            Err(WebhookError::SignatureMismatch)
        );
    }

    #[test]
    fn prop_a_different_secret_fails(
        other in "[ -~]{1,64}",
        body in prop::collection::vec(any::<u8>(), 0..512),
    ) {
        prop_assume!(other != SECRET);
        prop_assert_eq!(
            verifier().verify(sign(&other, &body).as_bytes(), &body),
            Err(WebhookError::SignatureMismatch)
        );
    }

    #[test]
    fn prop_random_bodies_and_headers_never_panic(
        body in prop::collection::vec(any::<u8>(), 0..1024),
        signature in prop::collection::vec(any::<u8>(), 0..96),
        event in prop::collection::vec(any::<u8>(), 0..40),
        delivery in prop::collection::vec(any::<u8>(), 0..80),
        content_type in prop::option::of(prop::collection::vec(any::<u8>(), 0..40)),
    ) {
        let mut h = HeaderMap::new();
        for (name, value) in [
            ("x-hub-signature-256", Some(signature)),
            ("x-github-event", Some(event)),
            ("x-github-delivery", Some(delivery)),
            ("content-type", content_type),
        ] {
            if let Some(Ok(v)) = value.map(|v| HeaderValue::from_bytes(&v)) {
                h.insert(name, v);
            }
        }
        let _ = verifier().verify_and_parse(&h, &body);
    }

    #[test]
    fn prop_signed_random_payloads_never_panic(
        payload in arbitrary_json(),
        event in prop::sample::select(vec![
            "installation", "installation_repositories", "pull_request", "push", "ping",
        ]),
    ) {
        let body = serde_json::to_vec(&payload).unwrap();
        let _ = verifier().verify_and_parse(&headers(event, &body), &body);
    }

    #[test]
    fn prop_signed_random_bytes_never_panic(
        body in prop::collection::vec(any::<u8>(), 0..1024),
        event in prop::sample::select(vec![
            "installation", "installation_repositories", "pull_request", "push",
        ]),
    ) {
        let result = verifier().verify_and_parse(&headers(event, &body), &body);
        if let Err(err) = result {
            prop_assert!(matches!(err, WebhookError::InvalidPayload(_)));
        }
    }
}
