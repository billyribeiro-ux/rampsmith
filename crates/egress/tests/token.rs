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

use egress::{MAX_TOKEN_AHEAD_SECS, Refusal, ScanToken, TokenKey};
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
        exp: 1_100,
    };
    let signed = a.sign(&token).unwrap();
    assert_eq!(a.verify(&signed, 1_000).unwrap(), token);
    assert!(b.verify(&signed, 1_000).is_err());
    assert!(a.verify(&signed, 1_099).is_ok(), "valid until exp");
    assert!(a.verify(&signed, 1_100).is_err(), "expired at exp");
    assert!(a.verify(&signed, 1_200).is_err(), "expired after exp");
}

/// Audit L14: a token whose expiry is more than five minutes away is not one the engine
/// signed (it signs two-minute tokens) and is refused, however good its signature.
#[test]
fn a_token_that_expires_too_far_ahead_is_refused() {
    let key = TokenKey::new(b"0123456789abcdef0123456789abcdef").unwrap();
    let now = 1_000_000;
    let signed = |exp: i64| {
        key.sign(&ScanToken {
            v: 1,
            scan: "scan-1".to_owned(),
            hosts: vec!["shop.example".to_owned()],
            budget: 3,
            exp,
        })
        .unwrap()
    };
    assert_eq!(MAX_TOKEN_AHEAD_SECS, 300);
    // The engine's own lifetime, and exactly the limit, are accepted.
    assert!(key.verify(&signed(now + 120), now).is_ok());
    assert!(key.verify(&signed(now + 300), now).is_ok());
    // One second past the limit, a day, and the largest value are not.
    for exp in [now + 301, now + 86_400, i64::MAX] {
        assert!(
            matches!(key.verify(&signed(exp), now), Err(Refusal::BadToken)),
            "exp {exp}"
        );
    }
    // The limit moves with the clock: later, the same token is within reach.
    assert!(key.verify(&signed(now + 301), now + 1).is_ok());
    // Nothing overflows when the clock is at the end of time.
    assert!(key.verify(&signed(i64::MAX), i64::MAX).is_err());
}

#[test]
fn short_keys_are_refused() {
    assert!(TokenKey::new(b"too short").is_err());
}
