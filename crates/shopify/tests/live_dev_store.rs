//! The R0 live dev-store check (LAUNCH.md section E, ADR-031).
//!
//! With the founder inputs of LAUNCH.md section C rows 1 and 3 present, this sends one token
//! exchange for the development store to `https://<store>/admin/oauth/access_token` through
//! the crate's real exchange code. The ID token is signed correctly with the app's client
//! secret and addressed to that store and app, but it expired an hour ago, so Shopify cannot
//! install anything for it. The test asserts that the crate classifies Shopify's answer as the
//! stale-ID-token class (`TokenError::InvalidSubjectToken`) and not as rejected credentials.
//! That proves live that the store's domain reaches Shopify's token endpoint, that the form is
//! accepted, that a 400 maps to the stale class, and that Shopify did not answer with the
//! rejected-credentials class. It does not prove the client secret: an ID token signed with a
//! wrong secret is invalid as well, and Shopify may answer it with the same 400 (ADR-031 §3).
//! The request has no side effects.
//!
//! Without the inputs the live test prints a notice naming them and returns. The other tests in
//! this file always run: they check the notice, the input handling and the probe itself
//! against a wiremock endpoint, which is the substitute that passes before the founder adds
//! anything.
//!
//! Nothing here prints a secret, a token, a response body or the store's domain.

// Integration tests are test code: PLAN §8 denies these lints outside tests only.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::collections::HashMap;
use std::time::Duration;

use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use secrecy::{ExposeSecret, SecretString};
use serde_json::json;
use shopify::{
    SessionTokenError, SessionTokenVerifier, ShopDomain, TokenClient, TokenEndpoint, TokenError,
};
use time::OffsetDateTime;
use wiremock::matchers::{method, path};
use wiremock::{Match, Mock, MockServer, Request, ResponseTemplate};

const API_KEY: &str = "SHOPIFY_API_KEY";
const API_SECRET: &str = "SHOPIFY_API_SECRET";
const STORE_DOMAIN: &str = "SHOPIFY_DEV_STORE_DOMAIN";

/// The notice a run without the inputs prints, word for word.
const SKIPPED: &str = "Shopify dev-store live check skipped: needs LAUNCH.md section C rows 1 and 3 (SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SHOPIFY_DEV_STORE_DOMAIN)";
const ANNOTATION: &str = "::notice title=Shopify dev-store live check skipped::";

/// How long ago the probe's ID token expired. App Bridge tokens live one minute.
const EXPIRED_FOR: i64 = 3600;

struct Inputs {
    api_key: String,
    api_secret: SecretString,
    store: ShopDomain,
}

impl Inputs {
    /// `Ok(None)` when any of the three variables is unset or empty (the check is skipped);
    /// an error when all three are set and the domain is not a `*.myshopify.com` host. The
    /// error never repeats a value.
    fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Result<Option<Self>, String> {
        let get = |name: &str| lookup(name).filter(|v| !v.trim().is_empty());
        let (Some(api_key), Some(api_secret), Some(domain)) =
            (get(API_KEY), get(API_SECRET), get(STORE_DOMAIN))
        else {
            return Ok(None);
        };
        let store = ShopDomain::parse(domain.trim())
            .map_err(|_| format!("{STORE_DOMAIN} must be a bare *.myshopify.com host"))?;
        Ok(Some(Self {
            api_key: api_key.trim().to_owned(),
            api_secret: SecretString::from(api_secret.trim().to_owned()),
            store,
        }))
    }
}

/// The skip notice, as a GitHub Actions annotation when `github_actions` is set.
fn skip_notice(github_actions: bool) -> String {
    if github_actions {
        format!("{ANNOTATION}{SKIPPED}")
    } else {
        SKIPPED.to_owned()
    }
}

/// An ID token for `inputs.store` and the app, signed HS256 with the client secret, whose
/// `exp` and `nbf` are an hour and more in the past at `now`.
fn expired_id_token(inputs: &Inputs, now: i64) -> String {
    let exp = now - EXPIRED_FOR;
    let nbf = exp - 60;
    let claims = json!({
        "iss": format!("https://{}/admin", inputs.store),
        "dest": inputs.store.origin(),
        "aud": inputs.api_key,
        "sub": "1",
        "exp": exp,
        "nbf": nbf,
        "iat": nbf,
        "jti": format!("rampsmith-live-check-{exp}"),
        "sid": "rampsmith-live-check",
    });
    encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(inputs.api_secret.expose_secret().as_bytes()),
    )
    .expect("HS256 signing with a byte-string secret cannot fail")
}

/// Sends the expired token through the crate's exchange and checks the classification.
async fn probe(inputs: &Inputs, endpoint: TokenEndpoint, now: i64) -> Result<(), String> {
    let client = TokenClient::new(
        &inputs.api_key,
        inputs.api_secret.clone(),
        endpoint,
        Duration::from_secs(15),
    )
    .map_err(|e| format!("could not build the token client: {e}"))?;
    let id_token = expired_id_token(inputs, now);
    match client.exchange(&inputs.store, &id_token).await {
        Err(TokenError::InvalidSubjectToken) => Ok(()),
        Err(TokenError::CredentialsRejected) => Err(format!(
            "Shopify rejected the client credentials: {API_KEY} and {API_SECRET} do not match \
             an app it knows"
        )),
        Err(other) => Err(format!(
            "expected the stale-ID-token class (exchange answered 400), got {other:?}"
        )),
        Ok(_) => Err("Shopify exchanged an expired ID token; it should answer 400".to_owned()),
    }
}

fn now() -> i64 {
    OffsetDateTime::now_utc().unix_timestamp()
}

// ---------------------------------------------------------------------------------------
// The live check. Runs only with the founder inputs; otherwise it says what it needs.
// ---------------------------------------------------------------------------------------

#[tokio::test]
async fn an_expired_id_token_is_the_stale_class_on_the_live_token_endpoint() {
    let inputs = match Inputs::from_lookup(|name| std::env::var(name).ok()) {
        Ok(Some(inputs)) => inputs,
        Ok(None) => {
            let github_actions = std::env::var("GITHUB_ACTIONS").is_ok_and(|v| v == "true");
            println!("{}", skip_notice(github_actions));
            return;
        }
        Err(message) => panic!("{message}"),
    };
    if let Err(message) = probe(&inputs, TokenEndpoint::Shopify, now()).await {
        panic!("{message}");
    }
}

// ---------------------------------------------------------------------------------------
// The substitute: everything the live check relies on, against a mock. Always runs.
// ---------------------------------------------------------------------------------------

const FAKE_KEY: &str = "0123456789abcdef0123456789abcdef";
const FAKE_SECRET: &str = "shpss_fake_secret_value";
const FAKE_STORE: &str = "probe-store.myshopify.com";
const FIXED_NOW: i64 = 1_792_400_000;

fn fake_inputs() -> Inputs {
    let vars: HashMap<&'static str, &'static str> = [
        (API_KEY, FAKE_KEY),
        (API_SECRET, FAKE_SECRET),
        (STORE_DOMAIN, FAKE_STORE),
    ]
    .into();
    Inputs::from_lookup(lookup(vars)).unwrap().unwrap()
}

#[test]
fn the_skip_notice_names_the_inputs_and_is_an_annotation_in_github_actions() {
    assert_eq!(
        skip_notice(false),
        "Shopify dev-store live check skipped: needs LAUNCH.md section C rows 1 and 3 \
         (SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SHOPIFY_DEV_STORE_DOMAIN)"
    );
    assert_eq!(
        skip_notice(true),
        "::notice title=Shopify dev-store live check skipped::Shopify dev-store live check \
         skipped: needs LAUNCH.md section C rows 1 and 3 \
         (SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SHOPIFY_DEV_STORE_DOMAIN)"
    );
}

/// A lookup over a fixed set of variables.
fn lookup(vars: HashMap<&'static str, &'static str>) -> impl Fn(&str) -> Option<String> {
    move |name| vars.get(name).map(|v| (*v).to_owned())
}

#[test]
fn the_check_needs_all_three_inputs_and_treats_empty_as_unset() {
    let full: HashMap<&'static str, &'static str> = [
        (API_KEY, FAKE_KEY),
        (API_SECRET, FAKE_SECRET),
        (STORE_DOMAIN, FAKE_STORE),
    ]
    .into();
    assert!(Inputs::from_lookup(lookup(full.clone())).unwrap().is_some());
    for name in [API_KEY, API_SECRET, STORE_DOMAIN] {
        let mut missing = full.clone();
        missing.remove(name);
        assert!(Inputs::from_lookup(lookup(missing)).unwrap().is_none());
        let mut empty = full.clone();
        empty.insert(name, "  ");
        assert!(Inputs::from_lookup(lookup(empty)).unwrap().is_none());
    }
    assert!(Inputs::from_lookup(|_| None).unwrap().is_none());
}

#[test]
fn a_set_but_malformed_store_domain_fails_loudly_without_echoing_it() {
    let vars: HashMap<&'static str, &'static str> = [
        (API_KEY, FAKE_KEY),
        (API_SECRET, FAKE_SECRET),
        (STORE_DOMAIN, "https://not-a-host.example.com/"),
    ]
    .into();
    let error = Inputs::from_lookup(lookup(vars)).err().unwrap();
    assert!(
        error.contains(STORE_DOMAIN) && !error.contains("not-a-host"),
        "{error}"
    );
}

#[test]
fn the_probe_token_is_correct_in_every_way_except_that_it_expired() {
    let inputs = fake_inputs();
    let token = expired_id_token(&inputs, FIXED_NOW);
    let verifier = SessionTokenVerifier::new(FAKE_KEY, &SecretString::from(FAKE_SECRET));
    // Now, the one thing wrong with it is its age.
    let at = OffsetDateTime::from_unix_timestamp(FIXED_NOW).unwrap();
    assert_eq!(
        verifier.verify_at(&token, at).unwrap_err(),
        SessionTokenError::Expired
    );
    // Back when it was current, the verifier accepts it: signature, audience, issuer and
    // destination are all right.
    let then = OffsetDateTime::from_unix_timestamp(FIXED_NOW - EXPIRED_FOR - 30).unwrap();
    let accepted = verifier.verify_at(&token, then).unwrap();
    assert_eq!(accepted.shop.as_str(), FAKE_STORE);
    // A verifier holding another secret rejects the signature, so the token really is
    // signed with the one it was given.
    let other = SessionTokenVerifier::new(FAKE_KEY, &SecretString::from("shpss_other"));
    assert_eq!(
        other.verify_at(&token, then).unwrap_err(),
        SessionTokenError::BadSignature
    );
}

/// Matches the form the live exchange must send for this probe.
struct ProbeForm(Vec<(&'static str, String)>);

impl Match for ProbeForm {
    fn matches(&self, request: &Request) -> bool {
        let got: HashMap<String, String> = url::form_urlencoded::parse(&request.body)
            .into_owned()
            .collect();
        got.len() == self.0.len()
            && self
                .0
                .iter()
                .all(|(k, v)| got.get(*k).map(String::as_str) == Some(v.as_str()))
    }
}

async fn mock_shopify(status: u16) -> MockServer {
    let inputs = fake_inputs();
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path(format!("/{FAKE_STORE}/admin/oauth/access_token")))
        .and(ProbeForm(vec![
            ("client_id", FAKE_KEY.to_owned()),
            ("client_secret", FAKE_SECRET.to_owned()),
            (
                "grant_type",
                "urn:ietf:params:oauth:grant-type:token-exchange".to_owned(),
            ),
            ("subject_token", expired_id_token(&inputs, FIXED_NOW)),
            (
                "subject_token_type",
                "urn:ietf:params:oauth:token-type:id_token".to_owned(),
            ),
            (
                "requested_token_type",
                "urn:shopify:params:oauth:token-type:offline-access-token".to_owned(),
            ),
            ("expiring", "1".to_owned()),
        ]))
        .respond_with(
            ResponseTemplate::new(status).set_body_json(json!({"error": "invalid_request"})),
        )
        .expect(1)
        .mount(&server)
        .await;
    server
}

#[tokio::test]
async fn the_probe_sends_the_documented_exchange_form_and_accepts_a_400_as_stale() {
    let server = mock_shopify(400).await;
    probe(&fake_inputs(), TokenEndpoint::Base(server.uri()), FIXED_NOW)
        .await
        .unwrap();
}

#[tokio::test]
async fn the_probe_fails_when_shopify_answers_anything_but_the_stale_class() {
    for (status, expected) in [
        (403, "rejected the client credentials"),
        (401, "got Rejected"),
        (429, "got RateLimited"),
        (503, "got Upstream"),
    ] {
        let server = mock_shopify(status).await;
        let error = probe(&fake_inputs(), TokenEndpoint::Base(server.uri()), FIXED_NOW)
            .await
            .unwrap_err();
        assert!(error.contains(expected), "{status}: {error}");
        assert!(!error.contains(FAKE_SECRET), "{error}");
    }
    // A 200 would mean Shopify installed the app for an expired token.
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "access_token": "shpat_x", "scope": "read_products", "expires_in": 3600,
            "refresh_token": "shprt_x", "refresh_token_expires_in": 7_776_000
        })))
        .mount(&server)
        .await;
    let error = probe(&fake_inputs(), TokenEndpoint::Base(server.uri()), FIXED_NOW)
        .await
        .unwrap_err();
    assert!(error.contains("exchanged an expired ID token"), "{error}");
    assert!(!error.contains("shpat_x"), "{error}");
}
