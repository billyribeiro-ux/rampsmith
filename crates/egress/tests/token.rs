//! Scan tokens: the engine signs, egress verifies (ADR-025). The vectors in
//! `testdata/tokens.json` were computed independently and are shared with the TypeScript
//! signer's tests.

// Integration tests are test code: PLAN §8 denies these lints outside tests only.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use egress::{ScanToken, TokenKey};
use serde_json::Value;

fn vectors() -> Value {
    serde_json::from_str(include_str!("../testdata/tokens.json")).unwrap()
}

fn key(v: &Value) -> TokenKey {
    TokenKey::new(v["secret"].as_str().unwrap().as_bytes()).unwrap()
}

#[test]
fn the_shared_valid_vectors_verify() {
    let v = vectors();
    let now = v["now"].as_i64().unwrap();
    for case in v["valid"].as_array().unwrap() {
        let token = key(&v)
            .verify(case["token"].as_str().unwrap(), now)
            .unwrap();
        let expected: ScanToken = serde_json::from_value(case["payload"].clone()).unwrap();
        assert_eq!(token, expected);
    }
}

#[test]
fn the_shared_invalid_vectors_are_refused() {
    let v = vectors();
    let now = v["now"].as_i64().unwrap();
    for case in v["invalid"].as_array().unwrap() {
        assert!(
            key(&v)
                .verify(case["token"].as_str().unwrap(), now)
                .is_err(),
            "{}",
            case["why"]
        );
    }
}

#[test]
fn host_matching_follows_the_shared_vectors() {
    let v = vectors();
    let token: ScanToken = serde_json::from_value(v["valid"][0]["payload"].clone()).unwrap();
    for case in v["hosts"].as_array().unwrap() {
        let host = case["host"].as_str().unwrap();
        assert_eq!(
            token.allows(host),
            case["allowed"].as_bool().unwrap(),
            "{host:?}"
        );
    }
}

#[test]
fn signing_round_trips_and_is_bound_to_the_key() {
    let a = TokenKey::new(b"0123456789abcdef0123456789abcdef").unwrap();
    let b = TokenKey::new(b"fedcba9876543210fedcba9876543210").unwrap();
    let token = ScanToken {
        v: 1,
        scan: "scan-1".to_owned(),
        hosts: vec!["shop.example".to_owned()],
        budget: 3,
        exp: 2_000,
    };
    let signed = a.sign(&token).unwrap();
    assert_eq!(a.verify(&signed, 1_000).unwrap(), token);
    assert!(b.verify(&signed, 1_000).is_err());
    assert!(a.verify(&signed, 2_000).is_err(), "expired at exp");
}

#[test]
fn short_keys_are_refused() {
    assert!(TokenKey::new(b"too short").is_err());
}
