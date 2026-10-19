//! C row 4: the GitHub App's JWT reaches `GET /app`.

use std::sync::{Arc, Mutex};

use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode};
use serde_json::Value;
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, Request, Respond, ResponseTemplate};

use crate::support::{Rig, fail, fixture, now, other_test_key, pass, skip_missing, test_key};

const APP_ID: &str = "1";
const CLIENT_ID: &str = "Iv1.ab1112223334445c";
const WEBHOOK: &str = "test-webhook-secret-SECRET-1";

/// GitHub's side of `GET /app`: only a JWT signed by the app's key gets the app.
struct FakeGithub {
    public_der: Vec<u8>,
    claims: Arc<Mutex<Vec<Value>>>,
    app: String,
}

impl FakeGithub {
    fn new(public_der: &[u8]) -> (Self, Arc<Mutex<Vec<Value>>>) {
        let claims = Arc::new(Mutex::new(Vec::new()));
        (
            Self {
                public_der: public_der.to_vec(),
                claims: Arc::clone(&claims),
                app: fixture("github/app.json"),
            },
            claims,
        )
    }
}

impl Respond for FakeGithub {
    fn respond(&self, request: &Request) -> ResponseTemplate {
        let rejected = || {
            ResponseTemplate::new(401)
                .set_body_raw(fixture("github/401-jwt.json"), "application/json")
                .insert_header("date", "Mon, 19 Oct 2026 12:00:00 GMT")
        };
        let Some(bearer) = request
            .headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
        else {
            return rejected();
        };
        let mut validation = Validation::new(Algorithm::RS256);
        validation.validate_exp = false;
        validation.required_spec_claims.clear();
        let Ok(token) = decode::<Value>(
            bearer,
            &DecodingKey::from_rsa_der(&self.public_der),
            &validation,
        ) else {
            return rejected();
        };
        assert_eq!(token.header.alg, Algorithm::RS256);
        self.claims.lock().unwrap().push(token.claims);
        ResponseTemplate::new(200).set_body_raw(self.app.clone(), "application/json")
    }
}

pub fn healthy_env(pem: &str) -> Vec<(&'static str, String)> {
    env(pem)
}

pub async fn healthy(server: &wiremock::MockServer) {
    let (fake, _) = FakeGithub::new(&test_key().public_der);
    Mock::given(method("GET"))
        .and(path("/app"))
        .respond_with(fake)
        .mount(server)
        .await;
}

fn env(pem: &str) -> Vec<(&'static str, String)> {
    vec![
        ("GITHUB_APP_ID", APP_ID.to_owned()),
        ("GITHUB_APP_CLIENT_ID", CLIENT_ID.to_owned()),
        ("GITHUB_APP_PRIVATE_KEY", pem.to_owned()),
        ("GITHUB_APP_WEBHOOK_SECRET", WEBHOOK.to_owned()),
    ]
}

async fn rig_with(vars: &[(&'static str, String)]) -> Rig {
    let pairs: Vec<(&str, &str)> = vars.iter().map(|(k, v)| (*k, v.as_str())).collect();
    Rig::new(&pairs).await
}

#[tokio::test]
async fn a_jwt_signed_with_the_apps_key_reaches_get_app() {
    let rig = rig_with(&env(&test_key().pkcs1_pem)).await;
    let (fake, claims) = FakeGithub::new(&test_key().public_der);
    Mock::given(method("GET"))
        .and(path("/app"))
        .and(header("accept", "application/vnd.github+json"))
        .and(header("x-github-api-version", "2026-03-10"))
        .respond_with(fake)
        .expect(1)
        .mount(&rig.server)
        .await;
    let outcome = rig.run("github.app").await;
    let detail = pass(&outcome);
    assert!(
        detail.contains("app 1") && detail.contains("`octoapp`"),
        "{detail}"
    );
    assert!(!detail.contains(WEBHOOK));

    // GitHub's JWT rules: RS256, `iss` the client id, `iat` backdated 60 s, `exp` under 10 minutes.
    let claims = claims.lock().unwrap();
    let claims = &claims[0];
    let at = now().unix_timestamp();
    assert_eq!(claims["iss"], CLIENT_ID);
    assert_eq!(claims["iat"], at - 60);
    assert_eq!(claims["exp"], at + 540);
}

#[tokio::test]
async fn a_pkcs8_key_works_too() {
    let rig = rig_with(&env(&test_key().pkcs8_pem)).await;
    let (fake, _) = FakeGithub::new(&test_key().public_der);
    Mock::given(method("GET"))
        .and(path("/app"))
        .respond_with(fake)
        .mount(&rig.server)
        .await;
    pass(&rig.run("github.app").await);
}

#[tokio::test]
async fn a_key_stored_on_one_line_with_escaped_newlines_works() {
    let one_line = test_key().pkcs1_pem.trim_end().replace('\n', "\\n");
    let rig = rig_with(&env(&one_line)).await;
    let (fake, _) = FakeGithub::new(&test_key().public_der);
    Mock::given(method("GET"))
        .and(path("/app"))
        .respond_with(fake)
        .mount(&rig.server)
        .await;
    pass(&rig.run("github.app").await);
}

#[tokio::test]
async fn the_wrong_private_key_is_rejected_by_github_and_reported_without_the_key() {
    // The app's real key is `test_key()`; the environment holds a different one.
    let rig = rig_with(&env(&other_test_key().pkcs1_pem)).await;
    let (fake, claims) = FakeGithub::new(&test_key().public_der);
    Mock::given(method("GET"))
        .and(path("/app"))
        .respond_with(fake)
        .mount(&rig.server)
        .await;
    let outcome = rig.run("github.app").await;
    let detail = fail(&outcome);
    assert!(
        detail.contains("401") && detail.contains("does not belong"),
        "{detail}"
    );
    assert!(
        !detail.contains("BEGIN") && !detail.contains("PRIVATE"),
        "{detail}"
    );
    assert!(claims.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_clock_far_from_githubs_is_called_out_on_a_401() {
    let rig = rig_with(&env(&test_key().pkcs1_pem)).await;
    Mock::given(method("GET"))
        .and(path("/app"))
        .respond_with(
            ResponseTemplate::new(401)
                .insert_header("date", "Mon, 19 Oct 2026 12:30:00 GMT")
                .set_body_raw(fixture("github/401-jwt.json"), "application/json"),
        )
        .mount(&rig.server)
        .await;
    let outcome = rig.run("github.app").await;
    let detail = fail(&outcome);
    assert!(detail.contains("clock is -1800 s"), "{detail}");
}

#[tokio::test]
async fn an_app_id_that_differs_from_the_key_s_app_fails() {
    let mut vars = env(&test_key().pkcs1_pem);
    vars[0].1 = "2".to_owned();
    let rig = rig_with(&vars).await;
    let (fake, _) = FakeGithub::new(&test_key().public_der);
    Mock::given(method("GET"))
        .and(path("/app"))
        .respond_with(fake)
        .mount(&rig.server)
        .await;
    let detail = fail(&rig.run("github.app").await).to_owned();
    assert!(
        detail.contains("authenticates as app 1, not GITHUB_APP_ID 2"),
        "{detail}"
    );
}

#[tokio::test]
async fn a_client_id_that_differs_from_the_apps_fails() {
    let mut vars = env(&test_key().pkcs1_pem);
    vars[1].1 = "Iv1.0000000000000000".to_owned();
    let rig = rig_with(&vars).await;
    let (fake, _) = FakeGithub::new(&test_key().public_der);
    Mock::given(method("GET"))
        .and(path("/app"))
        .respond_with(fake)
        .mount(&rig.server)
        .await;
    assert!(fail(&rig.run("github.app").await).contains("differs from GITHUB_APP_CLIENT_ID"));
}

#[tokio::test]
async fn bad_inputs_fail_before_any_request_and_never_echo_the_key() {
    let mut vars =
        env("-----BEGIN RSA PRIVATE KEY-----\nAAAA-SECRETMARK\n-----END RSA PRIVATE KEY-----");
    let rig = rig_with(&vars).await;
    let outcome = rig.run("github.app").await;
    let detail = fail(&outcome);
    assert!(detail.contains("not an RSA private key"), "{detail}");
    assert!(!detail.contains("SECRETMARK"), "{detail}");
    assert!(rig.server.received_requests().await.unwrap().is_empty());

    vars[0].1 = "app-one".to_owned();
    let rig = rig_with(&vars).await;
    assert!(fail(&rig.run("github.app").await).contains("GITHUB_APP_ID is not a number"));
}

#[tokio::test]
async fn partial_inputs_name_what_is_missing_and_unset_skips() {
    let rig = Rig::new(&[
        ("GITHUB_APP_ID", APP_ID),
        ("GITHUB_APP_CLIENT_ID", CLIENT_ID),
    ])
    .await;
    let outcome = rig.run("github.app").await;
    let detail = fail(&outcome);
    assert!(
        detail.contains("incomplete")
            && detail.contains("GITHUB_APP_PRIVATE_KEY")
            && detail.contains("GITHUB_APP_WEBHOOK_SECRET"),
        "{detail}"
    );

    let rig = Rig::new(&[]).await;
    assert!(skip_missing(&rig.run("github.app").await).contains("C row 4"));
}
