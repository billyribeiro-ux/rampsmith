//! Process-wide setup: one call at the top of each binary's `main`.

use std::env;

use opentelemetry::KeyValue;
use opentelemetry::trace::TracerProvider as _;
use opentelemetry_otlp::{MetricExporter, Protocol, SpanExporter, WithExportConfig};
use opentelemetry_sdk::Resource;
use opentelemetry_sdk::metrics::SdkMeterProvider;
use opentelemetry_sdk::propagation::TraceContextPropagator;
use opentelemetry_sdk::trace::SdkTracerProvider;
use thiserror::Error;
use tracing_subscriber::EnvFilter;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

/// How a service reports itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    /// `service.name`, such as `api` or `ctl`.
    pub service_name: &'static str,
    /// `service.version`, normally the crate version or the image's commit.
    pub service_version: String,
    /// Base URL of an OTLP/HTTP collector, such as `https://otlp.example.com/otlp`. Traces go
    /// to `<base>/v1/traces` and metrics to `<base>/v1/metrics`; `None` disables export.
    /// Authentication headers come from the standard `OTEL_EXPORTER_OTLP_HEADERS` variable.
    pub otlp_endpoint: Option<String>,
    /// JSON logs (production) or human-readable logs (local development).
    pub json_logs: bool,
    /// An `EnvFilter` directive such as `info` or `api=debug,info`.
    pub filter: String,
}

impl Config {
    /// Reads `OTEL_EXPORTER_OTLP_ENDPOINT` (export when set), `LOG_FORMAT`
    /// (`pretty` for human-readable logs, JSON otherwise) and `RUST_LOG` (default `info`).
    #[must_use]
    pub fn from_env(service_name: &'static str, service_version: impl Into<String>) -> Self {
        let set = |name: &str| env::var(name).ok().filter(|v| !v.trim().is_empty());
        Self {
            service_name,
            service_version: service_version.into(),
            otlp_endpoint: set("OTEL_EXPORTER_OTLP_ENDPOINT"),
            json_logs: set("LOG_FORMAT").is_none_or(|f| f != "pretty"),
            filter: set("RUST_LOG").unwrap_or_else(|| "info".to_owned()),
        }
    }
}

/// Telemetry could not start.
#[derive(Debug, Error)]
pub enum TelemetryError {
    /// The log filter did not parse.
    #[error("invalid log filter: {0}")]
    Filter(String),
    /// An OTLP exporter could not be built.
    #[error("cannot build the OTLP exporter: {0}")]
    Exporter(String),
    /// A global subscriber was already installed.
    #[error("telemetry was already initialised: {0}")]
    AlreadyInitialised(String),
}

/// Flushes and shuts down exporters when dropped at the end of `main`.
#[must_use = "dropping the guard immediately stops exporting"]
#[derive(Debug)]
pub struct Guard {
    tracer: Option<SdkTracerProvider>,
    meter: Option<SdkMeterProvider>,
}

impl Drop for Guard {
    fn drop(&mut self) {
        // Shutdown errors cannot be reported anywhere useful at this point.
        if let Some(tracer) = self.tracer.take() {
            let _ = tracer.shutdown();
        }
        if let Some(meter) = self.meter.take() {
            let _ = meter.shutdown();
        }
    }
}

/// Installs the W3C trace-context propagator, the OTLP trace and metric pipelines (when
/// exporting) and the global `tracing` subscriber with JSON or pretty logs.
pub fn init(config: &Config) -> Result<Guard, TelemetryError> {
    opentelemetry::global::set_text_map_propagator(TraceContextPropagator::new());
    let filter =
        EnvFilter::try_new(&config.filter).map_err(|e| TelemetryError::Filter(e.to_string()))?;
    let resource = Resource::builder()
        .with_service_name(config.service_name)
        .with_attribute(KeyValue::new(
            "service.version",
            config.service_version.clone(),
        ))
        .build();

    let (tracer, meter) = if let Some(base) = &config.otlp_endpoint {
        let base = base.trim_end_matches('/');
        let spans = SpanExporter::builder()
            .with_http()
            .with_protocol(Protocol::HttpBinary)
            .with_endpoint(format!("{base}/v1/traces"))
            .build()
            .map_err(|e| TelemetryError::Exporter(e.to_string()))?;
        let metrics = MetricExporter::builder()
            .with_http()
            .with_protocol(Protocol::HttpBinary)
            .with_endpoint(format!("{base}/v1/metrics"))
            .build()
            .map_err(|e| TelemetryError::Exporter(e.to_string()))?;
        let tracer = SdkTracerProvider::builder()
            .with_batch_exporter(spans)
            .with_resource(resource.clone())
            .build();
        let meter = SdkMeterProvider::builder()
            .with_periodic_exporter(metrics)
            .with_resource(resource)
            .build();
        opentelemetry::global::set_tracer_provider(tracer.clone());
        opentelemetry::global::set_meter_provider(meter.clone());
        (Some(tracer), Some(meter))
    } else {
        (None, None)
    };

    let otel = tracer.as_ref().map(|provider| {
        tracing_opentelemetry::layer().with_tracer(provider.tracer(config.service_name))
    });
    let json = config.json_logs.then(|| {
        tracing_subscriber::fmt::layer()
            .json()
            .with_current_span(true)
            .with_span_list(false)
            .flatten_event(true)
    });
    let pretty = (!config.json_logs).then(tracing_subscriber::fmt::layer);
    tracing_subscriber::registry()
        .with(filter)
        .with(otel)
        .with(json)
        .with(pretty)
        .try_init()
        .map_err(|e| TelemetryError::AlreadyInitialised(e.to_string()))?;
    Ok(Guard { tracer, meter })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_a_malformed_filter() {
        let config = Config {
            service_name: "test",
            service_version: "0.0.0".to_owned(),
            otlp_endpoint: None,
            json_logs: true,
            filter: "=[".to_owned(),
        };
        assert!(matches!(init(&config), Err(TelemetryError::Filter(_))));
    }
}
