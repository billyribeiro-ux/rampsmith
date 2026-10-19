//! Session (ID) token verification against shopify.dev's rules (ADR-022). Written first.

// Integration tests are test code: PLAN §8 denies these lints outside tests only.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use serde_json::{Value, json};
use shopify::{SessionTokenError, SessionTokenVerifier, ShopDomain};
use time::OffsetDateTime;

const CLIENT_ID: &str = "0123456789abcdef0123456789abcdef";
const SECRET: &str = "shpss_test_secret_0123456789";
const NOW: i64 = 1_792_300_000;

fn now() -> OffsetDateTime {
    OffsetDateTime::from_unix_timestamp(NOW).unwrap()
}

fn claims() -> Value {
    json!({
        "iss": "https://demo-store.myshopify.com/admin",
        "dest": "https://demo-store.myshopify.com",
        "aud": CLIENT_ID,
        "sub": "42",
        "exp": NOW + 50,
        "nbf": NOW - 10,
        "iat": NOW - 10,
        "jti": "6b0d8f0e-6a1b-4b8e-9f62-6a1c0b0f5f11",
        "sid": "a1b2c3"
    })
}

fn sign_with(claims: &Value, alg: Algorithm, secret: &str) -> String {
    encode(
        &Header::new(alg),
        claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .unwrap()
}

fn sign(claims: &Value) -> String {
    sign_with(claims, Algorithm::HS256, SECRET)
}

fn verifier() -> SessionTokenVerifier {
    SessionTokenVerifier::new(CLIENT_ID, &SECRET.to_owned().into())
}

fn with(field: &str, value: Value) -> Value {
    let mut c = claims();
    c[field] = value;
    c
}

fn without(field: &str) -> Value {
    let mut c = claims();
    c.as_object_mut().unwrap().remove(field);
    c
}

#[test]
fn a_valid_token_yields_its_shop_and_user() {
    let token = verifier().verify_at(&sign(&claims()), now()).unwrap();
    assert_eq!(token.shop.as_str(), "demo-store.myshopify.com");
    assert_eq!(token.user_id.as_deref(), Some("42"));
    assert_eq!(token.session_id.as_deref(), Some("a1b2c3"));
    assert_eq!(token.expires_at.unix_timestamp(), NOW + 50);
}

#[test]
fn the_signature_must_match_the_client_secret() {
    let token = sign_with(&claims(), Algorithm::HS256, "another-secret");
    assert_eq!(
        verifier().verify_at(&token, now()).unwrap_err(),
        SessionTokenError::BadSignature
    );
}

#[test]
fn only_hs256_is_accepted() {
    for alg in [Algorithm::HS384, Algorithm::HS512] {
        let token = sign_with(&claims(), alg, SECRET);
        assert_eq!(
            verifier().verify_at(&token, now()).unwrap_err(),
            SessionTokenError::WrongAlgorithm,
            "{alg:?}"
        );
    }
}

#[test]
fn an_unsigned_token_is_rejected() {
    // header {"alg":"none","typ":"JWT"} with valid claims and an empty signature
    let header = "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0";
    let signed = sign(&claims());
    let payload = signed.split('.').nth(1).unwrap();
    let token = format!("{header}.{payload}.");
    assert!(verifier().verify_at(&token, now()).is_err());
}

#[test]
fn the_audience_must_be_this_app() {
    let token = sign(&with("aud", json!("someone-else")));
    assert_eq!(
        verifier().verify_at(&token, now()).unwrap_err(),
        SessionTokenError::WrongAudience
    );
}

#[test]
fn expiry_allows_five_seconds_of_clock_skew_and_no_more() {
    let token = sign(&with("exp", json!(NOW)));
    let at = |offset: i64| OffsetDateTime::from_unix_timestamp(NOW + offset).unwrap();
    assert!(verifier().verify_at(&token, at(4)).is_ok());
    assert_eq!(
        verifier().verify_at(&token, at(5)).unwrap_err(),
        SessionTokenError::Expired
    );
}

#[test]
fn not_before_allows_five_seconds_of_clock_skew_and_no_more() {
    let token = sign(&with("nbf", json!(NOW + 5)));
    assert!(verifier().verify_at(&token, now()).is_ok());
    let token = sign(&with("nbf", json!(NOW + 6)));
    assert_eq!(
        verifier().verify_at(&token, now()).unwrap_err(),
        SessionTokenError::NotYetValid
    );
}

#[test]
fn required_claims_must_be_present() {
    for field in ["exp", "nbf", "aud", "iss", "dest"] {
        let token = sign(&without(field));
        assert!(
            matches!(
                verifier().verify_at(&token, now()),
                Err(SessionTokenError::MissingClaim | SessionTokenError::Malformed)
            ),
            "{field}"
        );
    }
}

#[test]
fn the_destination_must_be_a_myshopify_shop() {
    for dest in [
        "https://evil.example.com",
        "https://demo-store.myshopify.com.evil.com",
        "http://demo-store.myshopify.com",
        "https://demo-store.myshopify.com/extra",
        "demo-store.myshopify.com",
        "https://-bad.myshopify.com",
    ] {
        let mut c = with("dest", json!(dest));
        c["iss"] = json!(format!("{dest}/admin"));
        let token = sign(&c);
        assert_eq!(
            verifier().verify_at(&token, now()).unwrap_err(),
            SessionTokenError::BadDestination,
            "{dest}"
        );
    }
}

#[test]
fn issuer_and_destination_hostnames_must_match() {
    let token = sign(&with(
        "iss",
        json!("https://other-store.myshopify.com/admin"),
    ));
    assert_eq!(
        verifier().verify_at(&token, now()).unwrap_err(),
        SessionTokenError::IssuerMismatch
    );
    let token = sign(&with("iss", json!("not a url")));
    assert_eq!(
        verifier().verify_at(&token, now()).unwrap_err(),
        SessionTokenError::IssuerMismatch
    );
}

#[test]
fn garbage_is_malformed() {
    for token in ["", "abc", "a.b.c", "....."] {
        assert!(verifier().verify_at(token, now()).is_err(), "{token:?}");
    }
}

#[test]
fn the_verifier_debug_output_hides_the_secret() {
    let debug = format!("{:?}", verifier());
    assert!(debug.contains(CLIENT_ID));
    assert!(!debug.contains(SECRET));
}

#[test]
fn shop_domains_are_validated_and_lowercased() {
    assert_eq!(
        ShopDomain::parse("Demo-Store.MyShopify.com")
            .unwrap()
            .as_str(),
        "demo-store.myshopify.com"
    );
    assert_eq!(
        ShopDomain::parse("demo.myshopify.com").unwrap().origin(),
        "https://demo.myshopify.com"
    );
    for bad in [
        "",
        "myshopify.com",
        ".myshopify.com",
        "-demo.myshopify.com",
        "demo_store.myshopify.com",
        "demo.store.myshopify.com",
        "demo.myshopify.com.evil.com",
        "demo.myshopify.co",
        "https://demo.myshopify.com",
        &format!("{}.myshopify.com", "a".repeat(250)),
    ] {
        assert!(ShopDomain::parse(bad).is_err(), "{bad:?}");
    }
}
