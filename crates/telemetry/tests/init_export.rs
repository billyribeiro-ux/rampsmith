//! `init` installs process-global state, so each scenario runs in its own test binary.

// Integration tests are test code: PLAN §8 denies these lints outside tests only.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use telemetry::{Config, init};

/// Building and shutting down the exporters inside a Tokio runtime must not panic, even when
/// the collector is unreachable: telemetry never takes a service down.
#[tokio::test(flavor = "multi_thread")]
async fn an_unreachable_collector_never_fails_the_service() {
    let config = Config {
        service_name: "test",
        service_version: "0.0.0".to_owned(),
        otlp_endpoint: Some("http://127.0.0.1:9/".to_owned()),
        json_logs: false,
        filter: "info".to_owned(),
    };
    let guard = tokio::task::spawn_blocking(move || init(&config))
        .await
        .unwrap()
        .expect("init");
    tracing::info_span!("work").in_scope(|| tracing::info!("inside a span"));
    tokio::task::spawn_blocking(move || drop(guard))
        .await
        .unwrap();
}
