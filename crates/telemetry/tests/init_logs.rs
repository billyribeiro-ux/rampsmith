//! `init` installs process-global state, so each scenario runs in its own test binary.

// Integration tests are test code: PLAN §8 denies these lints outside tests only.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use telemetry::{Config, TelemetryError, init};

#[test]
fn json_logs_without_export_and_only_once_per_process() {
    let config = Config {
        service_name: "test",
        service_version: "0.0.0".to_owned(),
        otlp_endpoint: None,
        json_logs: true,
        filter: "info".to_owned(),
    };
    let guard = init(&config).expect("first init succeeds");
    tracing::info!(answer = 42, "telemetry works");
    assert!(matches!(
        init(&config),
        Err(TelemetryError::AlreadyInitialised(_))
    ));
    drop(guard);
}
