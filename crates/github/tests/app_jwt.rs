//! App JWTs (PLAN §15 "Authentication", ADR-122): RS256, `iat` 60 seconds back, `exp` within
//! GitHub's 10-minute maximum, `iss` the client ID, and a private key that never shows up in
//! `Debug` output or error messages.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod support;

use aws_lc_rs::signature::{RSA_PKCS1_2048_8192_SHA256, UnparsedPublicKey};
use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use github::{AppCredentials, AppIssuer, AppPrivateKey, JWT_BACKDATE, JWT_EXPIRES_IN, KeyError};
use secrecy::{ExposeSecret, SecretString};
use serde_json::{Value, json};
use support::{CLIENT_ID, START, credentials, key, pem, pkcs1_pem, pkcs8_pem};
use time::OffsetDateTime;

fn decode(part: &str) -> Value {
    serde_json::from_slice(&URL_SAFE_NO_PAD.decode(part).unwrap()).unwrap()
}

fn now() -> OffsetDateTime {
    OffsetDateTime::from_unix_timestamp(START).unwrap()
}

#[test]
fn jwt_claims_follow_githubs_rules() {
    let jwt = credentials().jwt(now()).unwrap();
    let token = jwt.expose_secret();
    let parts: Vec<&str> = token.split('.').collect();
    assert_eq!(parts.len(), 3);
    assert_eq!(decode(parts[0]), json!({"alg": "RS256", "typ": "JWT"}));
    let claims = decode(parts[1]);
    assert_eq!(claims["iss"], CLIENT_ID);
    assert_eq!(claims["iat"], START - 60, "iat is 60 seconds in the past");
    assert_eq!(claims["exp"], START + 540, "exp is 9 minutes ahead");
    let lifetime = claims["exp"].as_i64().unwrap() - claims["iat"].as_i64().unwrap();
    assert!(lifetime <= 600, "GitHub's maximum is 10 minutes");
    assert_eq!(
        claims.as_object().unwrap().len(),
        3,
        "only iat, exp and iss"
    );
    assert_eq!(jwt.issued_at(), now() - JWT_BACKDATE);
    assert_eq!(jwt.expires_at(), now() + JWT_EXPIRES_IN);
}

#[test]
fn jwt_signature_verifies_with_the_apps_public_key() {
    let jwt = credentials().jwt(now()).unwrap();
    let token = jwt.expose_secret();
    let (signed, signature) = token.rsplit_once('.').unwrap();
    let signature = URL_SAFE_NO_PAD.decode(signature).unwrap();
    let public = UnparsedPublicKey::new(&RSA_PKCS1_2048_8192_SHA256, &key().public);
    assert!(public.verify(signed.as_bytes(), &signature).is_ok());
    let mut tampered = signed.to_owned();
    tampered.push('x');
    assert!(public.verify(tampered.as_bytes(), &signature).is_err());
}

#[test]
fn pkcs1_and_pkcs8_keys_sign_identically() {
    let pkcs8 = AppCredentials::new(
        AppIssuer::client_id(CLIENT_ID).unwrap(),
        AppPrivateKey::from_pem(&pkcs8_pem()).unwrap(),
    );
    // RSA PKCS#1 v1.5 signatures are deterministic, so both encodings of one key agree.
    assert_eq!(
        pkcs8.jwt(now()).unwrap().expose_secret(),
        credentials().jwt(now()).unwrap().expose_secret()
    );
}

#[test]
fn a_key_with_literal_backslash_n_from_an_environment_variable_loads() {
    let flattened = pem("RSA PRIVATE KEY", &key().pkcs1).replace('\n', "\\n");
    assert!(AppPrivateKey::from_pem(&SecretString::from(flattened)).is_ok());
}

#[test]
fn the_app_id_is_accepted_as_issuer() {
    let creds = AppCredentials::new(
        AppIssuer::app_id(123),
        AppPrivateKey::from_pem(&pkcs1_pem()).unwrap(),
    );
    let jwt = creds.jwt(now()).unwrap();
    let claims = decode(jwt.expose_secret().split('.').nth(1).unwrap());
    assert_eq!(claims["iss"], "123");
}

/// Fragments of the key's base64 body that must never appear anywhere.
fn key_fragments() -> Vec<String> {
    let body = STANDARD.encode(&key().pkcs1);
    vec![body[64..96].to_owned(), body[200..232].to_owned()]
}

#[test]
fn private_key_never_appears_in_debug_output() {
    let creds = credentials();
    let key = AppPrivateKey::from_pem(&pkcs1_pem()).unwrap();
    let shown = format!("{creds:?} {key:?} {creds:#?}");
    for fragment in key_fragments() {
        assert!(!shown.contains(&fragment), "{shown}");
    }
    assert!(shown.contains("REDACTED"));
}

#[test]
fn jwt_never_appears_in_debug_output() {
    let jwt = credentials().jwt(now()).unwrap();
    let shown = format!("{jwt:?}");
    let signature = jwt.expose_secret().rsplit_once('.').unwrap().1;
    assert!(!shown.contains(signature), "{shown}");
    assert!(!shown.contains(jwt.expose_secret().split('.').nth(1).unwrap()));
}

#[test]
fn key_errors_never_contain_key_material() {
    let full = pem("RSA PRIVATE KEY", &key().pkcs1);
    let cases = [
        // Truncated body: base64 still valid, key rejected.
        full.replacen(&full[100..164], "", 1),
        // Corrupt base64.
        full.replacen(&full[100..104], "!!!!", 1),
        // Wrong label around a real key.
        full.replace("RSA PRIVATE KEY", "EC PRIVATE KEY"),
        // Missing END line.
        full.lines().take(5).collect::<Vec<_>>().join("\n"),
    ];
    for pem in cases {
        let err = AppPrivateKey::from_pem(&SecretString::from(pem)).unwrap_err();
        let shown = format!("{err} {err:?}");
        for fragment in key_fragments() {
            assert!(!shown.contains(&fragment), "{shown}");
        }
        assert!(matches!(
            err,
            KeyError::Rejected
                | KeyError::InvalidBase64
                | KeyError::UnsupportedLabel
                | KeyError::NotPem
        ));
    }
}

#[test]
fn a_pkcs1_body_under_a_pkcs8_label_is_rejected() {
    let mislabeled = pem("PRIVATE KEY", &key().pkcs1);
    assert_eq!(
        AppPrivateKey::from_pem(&SecretString::from(mislabeled)).unwrap_err(),
        KeyError::Rejected
    );
}
