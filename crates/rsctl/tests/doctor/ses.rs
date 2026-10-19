//! C row 7: Amazon SES, without sending.

use rsctl::sigv4::PathMode;
use wiremock::matchers::method;
use wiremock::{Mock, Request, Respond, ResponseTemplate};

use crate::support::{AwsExpect, Rig, fail, fixture, json, pass, skip_missing, verify_sigv4};

const KEY_ID: &str = "AKIAIOSFODNN7EXAMPLE";
const SECRET: &str = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const REGION: &str = "eu-west-1";

fn all(from: &'static str) -> Vec<(&'static str, &'static str)> {
    vec![
        ("SES_REGION", REGION),
        ("SES_ACCESS_KEY_ID", KEY_ID),
        ("SES_SECRET_ACCESS_KEY", SECRET),
        ("EMAIL_FROM", from),
    ]
}

/// SES's side: verifies the `SigV4` signature (service `ses`), then answers from fixtures.
struct FakeSes {
    expect: AwsExpect,
    account: &'static str,
    identities: Vec<(&'static str, &'static str)>,
}

impl FakeSes {
    fn new(account: &'static str, identities: &[(&'static str, &'static str)]) -> Self {
        Self {
            expect: AwsExpect {
                access_key_id: KEY_ID,
                secret_access_key: SECRET,
                region: REGION,
                service: "ses",
                mode: PathMode::Standard,
                content_sha256: false,
            },
            account,
            identities: identities.to_vec(),
        }
    }
}

fn aws_error(status: u16, kind: &str, fixture_name: &str) -> ResponseTemplate {
    ResponseTemplate::new(status)
        .insert_header(
            "x-amzn-ErrorType",
            format!("{kind}:http://internal.amazon.com/coral/").as_str(),
        )
        .set_body_raw(fixture(fixture_name), "application/json")
}

impl Respond for FakeSes {
    fn respond(&self, request: &Request) -> ResponseTemplate {
        if let Err(code) = verify_sigv4(request, &self.expect) {
            return aws_error(403, code, "ses/unrecognized-client.json");
        }
        let path = request.url.path();
        if path == "/v2/email/account" {
            return json(200, self.account);
        }
        if let Some(identity) = path.strip_prefix("/v2/email/identities/") {
            let identity = identity.replace("%40", "@");
            return match self.identities.iter().find(|(name, _)| *name == identity) {
                Some((_, body)) => json(200, body),
                None => aws_error(404, "NotFoundException", "ses/not-found.json"),
            };
        }
        ResponseTemplate::new(404)
    }
}

async fn mount(rig: &Rig, fake: FakeSes) {
    Mock::given(method("GET"))
        .and(path_regex_any())
        .respond_with(fake)
        .mount(&rig.server)
        .await;
}

pub fn vars() -> Vec<(&'static str, &'static str)> {
    all("Rampsmith <hello@example.com>")
}

pub async fn healthy(server: &wiremock::MockServer) {
    Mock::given(method("GET"))
        .and(path_regex_any())
        .respond_with(FakeSes::new(
            "ses/account.json",
            &[("example.com", "ses/identity-verified.json")],
        ))
        .mount(server)
        .await;
}

fn path_regex_any() -> wiremock::matchers::PathRegexMatcher {
    wiremock::matchers::path_regex("^/v2/email/.*")
}

#[tokio::test]
async fn a_verified_domain_out_of_the_sandbox_passes_with_a_valid_signature() {
    let rig = Rig::new(&all("Rampsmith <hello@example.com>")).await;
    mount(
        &rig,
        FakeSes::new(
            "ses/account.json",
            &[("example.com", "ses/identity-verified.json")],
        ),
    )
    .await;
    let outcome = rig.run("ses.identity").await;
    let detail = pass(&outcome);
    assert!(
        detail.contains("identity example.com is verified"),
        "{detail}"
    );
    assert!(!detail.contains(SECRET) && !detail.contains(KEY_ID));
    // Read-only: nothing but GETs of the two documented paths.
    for request in rig.server.received_requests().await.unwrap() {
        assert_eq!(request.method.as_str(), "GET");
        assert!(request.url.path().starts_with("/v2/email/"));
        assert!(
            !request.url.path().contains("outbound-emails"),
            "the doctor never sends"
        );
    }
}

#[tokio::test]
async fn the_exact_address_is_used_when_only_it_is_verified() {
    let rig = Rig::new(&all("hello@example.com")).await;
    mount(
        &rig,
        FakeSes::new(
            "ses/account.json",
            &[("hello@example.com", "ses/identity-verified.json")],
        ),
    )
    .await;
    assert!(pass(&rig.run("ses.identity").await).contains("hello@example.com"));
}

#[tokio::test]
async fn the_sandbox_fails() {
    let rig = Rig::new(&all("hello@example.com")).await;
    mount(
        &rig,
        FakeSes::new(
            "ses/account-sandbox.json",
            &[("example.com", "ses/identity-verified.json")],
        ),
    )
    .await;
    assert!(fail(&rig.run("ses.identity").await).contains("still in the sandbox in eu-west-1"));
}

#[tokio::test]
async fn an_unverified_identity_fails_with_its_status() {
    let rig = Rig::new(&all("hello@example.com")).await;
    mount(
        &rig,
        FakeSes::new(
            "ses/account.json",
            &[("example.com", "ses/identity-pending.json")],
        ),
    )
    .await;
    let outcome = rig.run("ses.identity").await;
    let detail = fail(&outcome);
    assert!(
        detail.contains("not verified for sending") && detail.contains("PENDING"),
        "{detail}"
    );
}

#[tokio::test]
async fn an_unknown_identity_names_both_it_tried() {
    let rig = Rig::new(&all("hello@example.com")).await;
    mount(&rig, FakeSes::new("ses/account.json", &[])).await;
    let outcome = rig.run("ses.identity").await;
    let detail = fail(&outcome);
    assert!(
        detail.contains("example.com or hello@example.com"),
        "{detail}"
    );
}

#[tokio::test]
async fn a_wrong_secret_is_reported_as_rejected_by_aws() {
    let mut vars = all("hello@example.com");
    vars[2] = ("SES_SECRET_ACCESS_KEY", "a-different-secret-key-SECRET");
    let rig = Rig::new(&vars).await;
    mount(
        &rig,
        FakeSes::new(
            "ses/account.json",
            &[("example.com", "ses/identity-verified.json")],
        ),
    )
    .await;
    let outcome = rig.run("ses.identity").await;
    let detail = fail(&outcome);
    assert!(
        detail.contains("403") && detail.contains("SignatureDoesNotMatch"),
        "{detail}"
    );
    assert!(detail.contains("AWS rejected the access key"), "{detail}");
    assert!(!detail.contains("a-different-secret-key"), "{detail}");
}

#[tokio::test]
async fn missing_read_permissions_are_named() {
    let rig = Rig::new(&all("hello@example.com")).await;
    Mock::given(method("GET"))
        .respond_with(aws_error(
            403,
            "AccessDeniedException",
            "ses/access-denied.json",
        ))
        .mount(&rig.server)
        .await;
    let outcome = rig.run("ses.identity").await;
    let detail = fail(&outcome);
    assert!(
        detail.contains("ses:GetAccount") && detail.contains("ses:GetEmailIdentity"),
        "{detail}"
    );
    assert!(
        !detail.contains("arn:aws"),
        "vendor text is not printed: {detail}"
    );
}

#[tokio::test]
async fn bad_inputs_fail_before_any_request() {
    for (region, from, needle) in [
        ("EU WEST", "hello@example.com", "SES_REGION"),
        (REGION, "not an address", "EMAIL_FROM"),
    ] {
        let rig = Rig::new(&[
            ("SES_REGION", region),
            ("SES_ACCESS_KEY_ID", KEY_ID),
            ("SES_SECRET_ACCESS_KEY", SECRET),
            ("EMAIL_FROM", from),
        ])
        .await;
        let outcome = rig.run("ses.identity").await;
        assert!(fail(&outcome).contains(needle), "{outcome:?}");
        assert!(rig.server.received_requests().await.unwrap().is_empty());
    }
}

#[tokio::test]
async fn partial_inputs_and_unset() {
    let rig = Rig::new(&[("SES_REGION", REGION), ("EMAIL_FROM", "hello@example.com")]).await;
    let outcome = rig.run("ses.identity").await;
    let detail = fail(&outcome);
    assert!(
        detail.contains("incomplete") && detail.contains("SES_ACCESS_KEY_ID"),
        "{detail}"
    );

    let rig = Rig::new(&[]).await;
    assert!(skip_missing(&rig.run("ses.identity").await).contains("C row 7"));
}
