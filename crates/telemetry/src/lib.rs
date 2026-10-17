//! OpenTelemetry for the Rust services (PLAN §21): traces and metrics over OTLP, structured
//! JSON logs, and W3C trace context carried through jobs so one trace follows a request from
//! webhook to scan to fix to pull request.

mod init;
mod propagation;

pub use init::{Config, Guard, TelemetryError, init};
pub use propagation::{context_from_traceparent, set_parent, trace_id, traceparent};
