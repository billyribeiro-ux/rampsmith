//! C row 9: the OTLP endpoint accepts an empty export.

use wiremock::matchers::{body_bytes, header, method, path};
use wiremock::{Mock, ResponseTemplate};

use crate::support::{Rig, fail, pass, skip_missing};

const HEADERS: &str = "Authorization=Basic%20dGVzdC1pbnN0YW5jZTpTRUNSRVQtdG9rZW4=";

fn vars(base: &str) -> Vec<(&'static str, String)> {
    vec![
        ("OTEL_EXPORTER_OTLP_ENDPOINT", format!("{base}/otlp")),
        ("OTEL_EXPORTER_OTLP_HEADERS", HEADERS.to_owned()),
        ("OTEL_EXPORTER_OTLP_PROTOCOL", "http/protobuf".to_owned()),
    ]
}

pub fn healthy_vars(base: &str) -> Vec<(&'static str, String)> {
    vars(base)
}

pub async fn healthy(server: &wiremock::MockServer) {
    Mock::given(method("POST"))
        .and(path("/otlp/v1/traces"))
        .respond_with(ResponseTemplate::new(200))
        .mount(server)
        .await;
}

async fn rig() -> Rig {
    let server = wiremock::MockServer::start().await;
    let owned = vars(&server.uri());
    let pairs: Vec<(&str, &str)> = owned.iter().map(|(k, v)| (*k, v.as_str())).collect();
    let mut rig = Rig::new(&pairs).await;
    rig.server = server;
    rig
}

#[tokio::test]
async fn an_empty_protobuf_export_is_accepted_with_the_decoded_credentials() {
    let rig = rig().await;
    Mock::given(method("POST"))
        .and(path("/otlp/v1/traces"))
        .and(header("content-type", "application/x-protobuf"))
        .and(header(
            "authorization",
            "Basic dGVzdC1pbnN0YW5jZTpTRUNSRVQtdG9rZW4=",
        ))
        .and(body_bytes(Vec::<u8>::new()))
        .respond_with(
            ResponseTemplate::new(200).insert_header("content-type", "application/x-protobuf"),
        )
        .expect(1)
        .mount(&rig.server)
        .await;
    let outcome = rig.run("otlp.export").await;
    let detail = pass(&outcome);
    assert!(detail.contains("empty trace export"), "{detail}");
    assert!(!detail.contains("dGVzdC1"), "{detail}");
}

#[tokio::test]
async fn rejected_credentials_and_a_wrong_path_fail_with_pointers() {
    let rig = rig().await;
    Mock::given(method("POST"))
        .and(path("/otlp/v1/traces"))
        .respond_with(
            ResponseTemplate::new(401)
                .set_body_string("invalid authentication credentials: SECRET-token"),
        )
        .mount(&rig.server)
        .await;
    let outcome = rig.run("otlp.export").await;
    let detail = fail(&outcome);
    assert!(
        detail.contains("401") && detail.contains("OTEL_EXPORTER_OTLP_HEADERS"),
        "{detail}"
    );
    assert!(!detail.contains("SECRET-token"), "{detail}");

    let rig = self::rig().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(404))
        .mount(&rig.server)
        .await;
    assert!(fail(&rig.run("otlp.export").await).contains("base URL"));
}

#[tokio::test]
async fn grpc_is_refused_without_a_request() {
    let server = wiremock::MockServer::start().await;
    let rig = Rig::new(&[
        ("OTEL_EXPORTER_OTLP_ENDPOINT", server.uri().as_str()),
        ("OTEL_EXPORTER_OTLP_HEADERS", HEADERS),
        ("OTEL_EXPORTER_OTLP_PROTOCOL", "grpc"),
    ])
    .await;
    let outcome = rig.run("otlp.export").await;
    assert!(fail(&outcome).contains("http/protobuf"));
    assert!(server.received_requests().await.unwrap().is_empty());
    assert!(rig.server.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn the_protocol_may_be_left_unset() {
    let server = wiremock::MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/traces"))
        .respond_with(ResponseTemplate::new(200))
        .expect(1)
        .mount(&server)
        .await;
    let rig = Rig::new(&[
        (
            "OTEL_EXPORTER_OTLP_ENDPOINT",
            format!("{}/", server.uri()).as_str(),
        ),
        ("OTEL_EXPORTER_OTLP_HEADERS", HEADERS),
    ])
    .await;
    pass(&rig.run("otlp.export").await);
}

#[tokio::test]
async fn malformed_headers_fail_without_echoing_them() {
    let rig = Rig::new(&[
        (
            "OTEL_EXPORTER_OTLP_ENDPOINT",
            "https://otlp.example.com/otlp",
        ),
        (
            "OTEL_EXPORTER_OTLP_HEADERS",
            "this-has-no-equals-sign-SECRETMARK",
        ),
    ])
    .await;
    let outcome = rig.run("otlp.export").await;
    let detail = fail(&outcome);
    assert!(
        detail.contains("key=value") && !detail.contains("SECRETMARK"),
        "{detail}"
    );
}

#[tokio::test]
async fn plain_http_to_a_remote_host_is_refused() {
    let rig = Rig::new(&[
        (
            "OTEL_EXPORTER_OTLP_ENDPOINT",
            "http://otlp.example.com/otlp",
        ),
        ("OTEL_EXPORTER_OTLP_HEADERS", HEADERS),
    ])
    .await;
    let outcome = rig.run("otlp.export").await;
    assert!(fail(&outcome).contains("https"), "{outcome:?}");
}

#[tokio::test]
async fn endpoint_without_headers_is_a_partial_input() {
    let rig = Rig::new(&[(
        "OTEL_EXPORTER_OTLP_ENDPOINT",
        "https://otlp.example.com/otlp",
    )])
    .await;
    let outcome = rig.run("otlp.export").await;
    let detail = fail(&outcome);
    assert!(
        detail.contains("incomplete") && detail.contains("OTEL_EXPORTER_OTLP_HEADERS"),
        "{detail}"
    );
}

#[tokio::test]
async fn unset_skips_naming_row_9() {
    let rig = Rig::new(&[]).await;
    assert!(skip_missing(&rig.run("otlp.export").await).contains("C row 9"));
}
