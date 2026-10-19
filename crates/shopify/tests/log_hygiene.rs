//! What the token client writes to the logs (PLAN §19, audit L7): no shop domain, no token, no
//! secret and no response body, on the success path and on every failure path.

// Integration tests are test code: PLAN §8 denies these lints outside tests only.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::io;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use secrecy::SecretString;
use serde_json::json;
use shopify::{ShopDomain, TokenClient, TokenEndpoint};
use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::fmt::format::FmtSpan;
use wiremock::matchers::method;
use wiremock::{Mock, MockServer, ResponseTemplate};

const CLIENT_ID: &str = "0123456789abcdef0123456789abcdef";
const CLIENT_SECRET: &str = "shpss_client_secret_value";
const ID_TOKEN: &str = "eyJ.id_token.value";
const REFRESH_TOKEN: &str = "shprt_old_refresh";

/// A log sink the test can read back.
#[derive(Clone, Default)]
struct Capture(Arc<Mutex<Vec<u8>>>);

impl Capture {
    fn text(&self) -> String {
        String::from_utf8(self.0.lock().unwrap().clone()).unwrap()
    }
}

impl io::Write for Capture {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl MakeWriter<'_> for Capture {
    type Writer = Self;

    fn make_writer(&self) -> Self {
        self.clone()
    }
}

/// Runs `body` with this crate's spans and events (every level, span open and close included)
/// written to the returned capture. The single-threaded test runtime keeps every task on the
/// thread that holds the default subscriber.
async fn logged<F: Future<Output = ()>>(body: F) -> String {
    let capture = Capture::default();
    let subscriber = tracing_subscriber::fmt()
        .with_env_filter("shopify=trace")
        .with_span_events(FmtSpan::FULL)
        .with_ansi(false)
        .with_writer(capture.clone())
        .finish();
    let guard = tracing::subscriber::set_default(subscriber);
    body.await;
    drop(guard);
    capture.text()
}

fn assert_clean(log: &str) {
    assert!(
        !log.is_empty(),
        "the client logged nothing, so this proves nothing"
    );
    for forbidden in [
        "demo-store",
        "myshopify",
        CLIENT_SECRET,
        ID_TOKEN,
        REFRESH_TOKEN,
        "shpat_new_access",
        "shprt_new_refresh",
        "shpat_leak",
        "shprt_leak",
    ] {
        assert!(
            !log.contains(forbidden),
            "log contains {forbidden:?}:\n{log}"
        );
    }
}

fn client(server: &MockServer) -> TokenClient {
    TokenClient::new(
        CLIENT_ID,
        SecretString::from(CLIENT_SECRET),
        TokenEndpoint::Base(server.uri()),
        Duration::from_secs(2),
    )
    .unwrap()
}

fn shop() -> ShopDomain {
    ShopDomain::parse("demo-store.myshopify.com").unwrap()
}

async fn serve(status: u16, body: serde_json::Value) -> MockServer {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(status).set_body_json(body))
        .mount(&server)
        .await;
    server
}

#[tokio::test]
async fn a_successful_exchange_and_refresh_log_no_shop_token_or_secret() {
    let server = serve(
        200,
        json!({
            "access_token": "shpat_new_access",
            "scope": "read_products",
            "expires_in": 3600,
            "refresh_token": "shprt_new_refresh",
            "refresh_token_expires_in": 7_776_000
        }),
    )
    .await;
    let log = logged(async {
        let c = client(&server);
        c.exchange(&shop(), ID_TOKEN).await.unwrap();
        c.refresh(&shop(), &SecretString::from(REFRESH_TOKEN))
            .await
            .unwrap();
    })
    .await;
    assert_clean(&log);
    assert!(log.contains("exchange") && log.contains("refresh"), "{log}");
}

#[tokio::test]
async fn every_failure_logs_no_shop_token_secret_or_response_body() {
    for status in [400, 401, 403, 404, 429, 500, 503] {
        let server = serve(
            status,
            json!({"error": "x", "error_description": "shpat_leak shprt_leak"}),
        )
        .await;
        let log = logged(async {
            let c = client(&server);
            c.exchange(&shop(), ID_TOKEN).await.unwrap_err();
            c.refresh(&shop(), &SecretString::from(REFRESH_TOKEN))
                .await
                .unwrap_err();
        })
        .await;
        assert_clean(&log);
    }
}
