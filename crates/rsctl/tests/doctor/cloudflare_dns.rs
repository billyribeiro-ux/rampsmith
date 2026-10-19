//! C row 10: the optional Cloudflare DNS token reads its zone.

use wiremock::matchers::{header, method, path, query_param};
use wiremock::{Mock, ResponseTemplate};

use crate::support::{Rig, fail, json, pass, skip_missing};

const TOKEN: &str = "test-cloudflare-token-SECRET-1";

pub fn vars() -> Vec<(&'static str, &'static str)> {
    vec![("CLOUDFLARE_API_TOKEN", TOKEN)]
}

pub async fn healthy(server: &wiremock::MockServer) {
    Mock::given(method("GET"))
        .and(path("/client/v4/zones"))
        .respond_with(json(200, "cloudflare/zones.json"))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path(
            "/client/v4/zones/023e105f4ecef8ad9ca31a8372d0c353/dns_records",
        ))
        .respond_with(json(200, "cloudflare/dns-records.json"))
        .mount(server)
        .await;
}

async fn rig() -> Rig {
    Rig::new(&[("CLOUDFLARE_API_TOKEN", TOKEN)]).await
}

#[tokio::test]
async fn the_token_lists_zones_and_reads_dns_records() {
    let rig = rig().await;
    Mock::given(method("GET"))
        .and(path("/client/v4/zones"))
        .and(header("authorization", format!("Bearer {TOKEN}").as_str()))
        .respond_with(json(200, "cloudflare/zones.json"))
        .expect(1)
        .mount(&rig.server)
        .await;
    Mock::given(method("GET"))
        .and(path(
            "/client/v4/zones/023e105f4ecef8ad9ca31a8372d0c353/dns_records",
        ))
        .and(query_param("per_page", "1"))
        .and(header("authorization", format!("Bearer {TOKEN}").as_str()))
        .respond_with(json(200, "cloudflare/dns-records.json"))
        .expect(1)
        .mount(&rig.server)
        .await;
    let outcome = rig.run("cloudflare.dns").await;
    let detail = pass(&outcome);
    assert!(
        detail.contains("2 zone(s)") && detail.contains("example.com"),
        "{detail}"
    );
    assert!(!detail.contains(TOKEN));
}

#[tokio::test]
async fn an_invalid_token_fails_with_cloudflares_numeric_code() {
    let rig = rig().await;
    Mock::given(method("GET"))
        .and(path("/client/v4/zones"))
        .respond_with(json(403, "cloudflare/error-9109.json"))
        .mount(&rig.server)
        .await;
    let outcome = rig.run("cloudflare.dns").await;
    let detail = fail(&outcome);
    assert!(
        detail.contains("403") && detail.contains("9109") && detail.contains("Zone:Read"),
        "{detail}"
    );
    assert!(
        !detail.contains("Invalid access token"),
        "vendor text is not printed: {detail}"
    );
}

#[tokio::test]
async fn a_token_that_sees_no_zone_fails() {
    let rig = rig().await;
    Mock::given(method("GET"))
        .and(path("/client/v4/zones"))
        .respond_with(json(200, "cloudflare/zones-empty.json"))
        .mount(&rig.server)
        .await;
    assert!(fail(&rig.run("cloudflare.dns").await).contains("sees no zones"));
}

#[tokio::test]
async fn a_token_that_cannot_read_dns_records_fails() {
    let rig = rig().await;
    Mock::given(method("GET"))
        .and(path("/client/v4/zones"))
        .respond_with(json(200, "cloudflare/zones.json"))
        .mount(&rig.server)
        .await;
    Mock::given(method("GET"))
        .and(path(
            "/client/v4/zones/023e105f4ecef8ad9ca31a8372d0c353/dns_records",
        ))
        .respond_with(json(403, "cloudflare/error-10000.json"))
        .mount(&rig.server)
        .await;
    let outcome = rig.run("cloudflare.dns").await;
    let detail = fail(&outcome);
    assert!(
        detail.contains("reading DNS records") && detail.contains("10000"),
        "{detail}"
    );
}

#[tokio::test]
async fn a_non_json_answer_fails() {
    let rig = rig().await;
    Mock::given(method("GET"))
        .and(path("/client/v4/zones"))
        .respond_with(ResponseTemplate::new(200).set_body_string("<html>"))
        .mount(&rig.server)
        .await;
    assert!(fail(&rig.run("cloudflare.dns").await).contains("listing zones failed"));
}

#[tokio::test]
async fn unset_skips_naming_row_10() {
    let rig = Rig::new(&[]).await;
    let outcome = rig.run("cloudflare.dns").await;
    let detail = skip_missing(&outcome);
    assert!(detail.contains("C row 10"), "{detail}");
}
