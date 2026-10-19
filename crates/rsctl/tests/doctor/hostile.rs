//! A vendor that echoes everything it was sent back at the caller, in every shape an error
//! can take, must not make a secret appear in the report. Two layers are exercised: probes
//! print vendor error codes only (never free text), and the redactor scrubs whatever is left.

use std::fmt::Write as _;

use rsctl::report::Target;
use rsctl::vars::Var;
use wiremock::matchers::any;
use wiremock::{Mock, Request, Respond, ResponseTemplate};

use crate::support::{Rig, master_ring, test_key};

#[derive(Clone, Copy, Debug)]
enum Shape {
    /// The request, as plain text.
    Text,
    /// The request inside every field a JSON error might carry.
    Json,
    /// The request inside an S3 error document.
    Xml,
    /// The request as a GraphQL error.
    GraphQl,
}

struct Echo {
    status: u16,
    shape: Shape,
}

impl Respond for Echo {
    fn respond(&self, request: &Request) -> ResponseTemplate {
        let mut echoed = format!("{} {}\n", request.method, request.url);
        for (name, value) in &request.headers {
            let _ = writeln!(echoed, "{name}: {}", value.to_str().unwrap_or(""));
        }
        echoed.push_str(&String::from_utf8_lossy(&request.body));
        let escaped = serde_json::to_string(&echoed).unwrap();
        let body = match self.shape {
            Shape::Text => echoed.clone(),
            Shape::Json => format!(
                r#"{{"error":{{"type":{escaped},"code":{escaped},"message":{escaped}}},"message":{escaped},"error_description":{escaped},"success":false,"error-codes":[{escaped}],"errors":[{{"code":1,"message":{escaped}}}]}}"#
            ),
            Shape::Xml => {
                format!("<Error><Code>{echoed}</Code><Message>{echoed}</Message></Error>")
            }
            Shape::GraphQl => format!(
                r#"{{"errors":[{{"message":{escaped},"extensions":{{"code":{escaped}}}}}],"data":null}}"#
            ),
        };
        ResponseTemplate::new(self.status)
            .insert_header(
                "x-amzn-ErrorType",
                format!("{echoed}:x").replace('\n', " ").as_str(),
            )
            .insert_header("date", "Mon, 19 Oct 2026 12:30:00 GMT")
            .set_body_raw(body, "application/json")
    }
}

/// An environment with a recognisable value in every secret variable, shaped well enough for
/// each probe to send its request.
fn environment() -> Vec<(String, String)> {
    let key = test_key();
    let mut env: Vec<(String, String)> = vec![
        ("SHOPIFY_API_KEY", "0123456789abcdef0123456789abcdef"),
        ("SHOPIFY_PARTNER_ORG_ID", "4321"),
        ("SHOPIFY_APP_GID", "gid://shopify/App/1234"),
        ("SHOPIFY_DEV_STORE_DOMAIN", "rampsmith-dev-a.myshopify.com"),
        (
            "SHOPIFY_DEV_STORE_B_DOMAIN",
            "rampsmith-dev-b.myshopify.com",
        ),
        ("GITHUB_APP_ID", "1"),
        ("GITHUB_APP_CLIENT_ID", "Iv1.ab1112223334445c"),
        ("R2_ACCOUNT_ID", "0123456789abcdef0123456789abcdef"),
        ("R2_BUCKET_EVIDENCE", "rampsmith-evidence"),
        ("R2_BUCKET_BACKUPS", "rampsmith-backups"),
        ("TURNSTILE_SITE_KEY", "0x4AAAAAAAsitekey"),
        ("SES_REGION", "eu-west-1"),
        ("EMAIL_FROM", "hello@example.com"),
        ("STRIPE_PUBLISHABLE_KEY", "pk_test_not_a_real_key_marker"),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_owned(), v.to_owned()))
    .collect();
    // Every other secret gets a unique, recognisable value. Stripe's must keep its prefix.
    for var in Var::ALL.iter().filter(|var| var.is_secret()) {
        let value = match var {
            Var::GithubAppPrivateKey => key.pkcs1_pem.clone(),
            Var::RampsmithMasterKeys => master_ring(),
            Var::StripeSecretKey => "sk_test_ECHOME0123456789abcdef".to_owned(),
            Var::StripeWebhookSecret => "whsec_ECHOME0123456789abcdef".to_owned(),
            Var::OtelExporterOtlpHeaders => {
                "Authorization=Basic%20ECHOME0123456789abcdef".to_owned()
            }
            other => format!("ECHOME-{}-0123456789abcdef", other.name()),
        };
        env.push((var.name().to_owned(), value));
    }
    env.push((
        "OTEL_EXPORTER_OTLP_ENDPOINT".to_owned(),
        "PLACEHOLDER".to_owned(),
    ));
    env
}

#[tokio::test]
async fn no_secret_reaches_the_report_whatever_the_vendor_echoes() {
    let mut env = environment();
    for status in [200_u16, 400, 401, 403, 404, 500] {
        for shape in [Shape::Text, Shape::Json, Shape::Xml, Shape::GraphQl] {
            let server = wiremock::MockServer::start().await;
            Mock::given(any())
                .respond_with(Echo { status, shape })
                .mount(&server)
                .await;
            for (name, value) in &mut env {
                if name == "OTEL_EXPORTER_OTLP_ENDPOINT" {
                    *value = format!("{}/otlp", server.uri());
                }
            }
            let borrowed: Vec<(&str, &str)> =
                env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
            let mut rig = Rig::new(&borrowed).await;
            rig.server = server;
            rig.options.target = Target::Staging;
            rig.options.production_shopify_api_key = Some("other".to_owned());
            rig.options.production_github_app_id = Some("999".to_owned());
            let (report, ctx) = rig.report().await;

            let mut rendered = vec![
                report.render_text(&ctx.redactor, false),
                report.render_json(&ctx.redactor, true),
            ];
            // The details a probe itself produced, before the redactor, for the shapes that
            // carry vendor *text* (a code echoed through `safe_token` is the redactor's job).
            if matches!(shape, Shape::Text | Shape::Xml) {
                rendered.push(
                    report
                        .findings
                        .iter()
                        .map(|f| match &f.outcome {
                            rsctl::report::Outcome::Pass(d)
                            | rsctl::report::Outcome::Fail(d)
                            | rsctl::report::Outcome::Skip(_, d) => d.clone(),
                        })
                        .collect::<Vec<_>>()
                        .join("\n"),
                );
            }
            for text in &rendered {
                assert!(
                    !text.contains("ECHOME"),
                    "status {status}, {shape:?}:\n{text}"
                );
                assert!(
                    !text.contains("BEGIN RSA PRIVATE KEY"),
                    "status {status}, {shape:?}"
                );
                let master = env
                    .iter()
                    .find(|(k, _)| k == "RAMPSMITH_MASTER_KEYS")
                    .unwrap();
                let key_part = master.1.split(':').nth(1).unwrap();
                assert!(!text.contains(key_part), "status {status}, {shape:?}");
                // No bearer credential or basic auth blob either.
                assert!(!text.contains("Basic%20"), "status {status}, {shape:?}");
            }
        }
    }
}
