//! W3C trace context in and out of `jobs.traceparent` (PLAN §10, §21).

use std::collections::HashMap;

use opentelemetry::Context;
use opentelemetry::propagation::TextMapPropagator;
use opentelemetry::trace::TraceContextExt;
use opentelemetry_sdk::propagation::TraceContextPropagator;
use tracing_opentelemetry::OpenTelemetrySpanExt;

const HEADER: &str = "traceparent";

/// The W3C `traceparent` of `span`, to store with a job it enqueues. `None` when the span
/// is not recorded by OpenTelemetry (telemetry off, or a disabled span).
#[must_use]
pub fn traceparent(span: &tracing::Span) -> Option<String> {
    let cx = span.context();
    if !cx.span().span_context().is_valid() {
        return None;
    }
    let mut carrier = HashMap::new();
    TraceContextPropagator::new().inject_context(&cx, &mut carrier);
    carrier.remove(HEADER)
}

/// The 32-hex-digit trace id of `span`, for problem responses and support. `None` when the
/// span is not recorded by OpenTelemetry.
#[must_use]
pub fn trace_id(span: &tracing::Span) -> Option<String> {
    let cx = span.context();
    let span_ref = cx.span();
    let context = span_ref.span_context();
    context.is_valid().then(|| context.trace_id().to_string())
}

/// Whether `value` is a version-00 W3C `traceparent`: `00-<32 hex>-<16 hex>-<2 hex>`, lowercase,
/// with non-zero trace and span ids. The propagator alone accepts shorter ids.
fn is_well_formed(value: &str) -> bool {
    let hex = |part: &str, len: usize| {
        part.len() == len
            && part
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    };
    let parts: Vec<&str> = value.split('-').collect();
    matches!(parts.as_slice(), [version, trace, span, flags]
        if *version == "00"
            && hex(trace, 32)
            && hex(span, 16)
            && hex(flags, 2)
            && trace.bytes().any(|b| b != b'0')
            && span.bytes().any(|b| b != b'0'))
}

/// The remote parent described by a stored `traceparent`, or `None` when it is malformed.
#[must_use]
pub fn context_from_traceparent(traceparent: &str) -> Option<Context> {
    if !is_well_formed(traceparent) {
        return None;
    }
    let carrier = HashMap::from([(HEADER.to_owned(), traceparent.to_owned())]);
    let cx = TraceContextPropagator::new().extract(&carrier);
    cx.span().span_context().is_valid().then_some(cx)
}

/// Makes `span` a child of the stored `traceparent`. A missing or malformed value leaves
/// the span as the root of a new trace.
pub fn set_parent(span: &tracing::Span, traceparent: Option<&str>) {
    if let Some(cx) = traceparent.and_then(context_from_traceparent) {
        // Fails only when the span is disabled or already started; it then stays a root.
        let _ = span.set_parent(cx);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use opentelemetry::trace::{TraceContextExt, TracerProvider as _};
    use opentelemetry_sdk::trace::{InMemorySpanExporter, SdkTracerProvider};
    use tracing_subscriber::layer::SubscriberExt;

    /// Runs `f` under an OpenTelemetry layer and returns the spans it finished. The provider
    /// must outlive the read: shutting it down clears the in-memory exporter.
    fn traced<R>(f: impl FnOnce() -> R) -> (R, Vec<opentelemetry_sdk::trace::SpanData>) {
        let exporter = InMemorySpanExporter::default();
        let provider = SdkTracerProvider::builder()
            .with_simple_exporter(exporter.clone())
            .build();
        let subscriber = tracing_subscriber::registry()
            .with(tracing_opentelemetry::layer().with_tracer(provider.tracer("test")));
        let result = tracing::subscriber::with_default(subscriber, f);
        provider.force_flush().unwrap();
        let spans = exporter.get_finished_spans().unwrap();
        (result, spans)
    }

    #[test]
    fn a_span_yields_a_valid_w3c_traceparent() {
        let (tp, _) = traced(|| {
            let span = tracing::info_span!("enqueue");
            traceparent(&span)
        });
        let tp = tp.expect("traceparent inside a traced span");
        let parts: Vec<&str> = tp.split('-').collect();
        assert_eq!(parts.len(), 4, "{tp}");
        assert_eq!(parts[0], "00");
        assert_eq!(parts[1].len(), 32);
        assert_eq!(parts[2].len(), 16);
        assert!(
            tp.chars().all(|c| c.is_ascii_hexdigit() || c == '-'),
            "{tp}"
        );
    }

    #[test]
    fn without_a_tracing_layer_there_is_no_traceparent() {
        assert_eq!(traceparent(&tracing::Span::none()), None);
        assert_eq!(trace_id(&tracing::Span::none()), None);
    }

    #[test]
    fn the_trace_id_matches_the_traceparent() {
        let ((tp, id), _) = traced(|| {
            let span = tracing::info_span!("request");
            (traceparent(&span), trace_id(&span))
        });
        let (tp, id) = (tp.unwrap(), id.unwrap());
        assert_eq!(id.len(), 32);
        assert!(tp.contains(&id), "{tp} / {id}");
    }

    #[test]
    fn a_job_span_continues_the_trace_of_its_enqueuer() {
        let ((), spans) = traced(|| {
            let enqueue = tracing::info_span!("enqueue");
            let carried = traceparent(&enqueue).expect("traceparent");
            drop(enqueue);
            let job = tracing::info_span!("job");
            set_parent(&job, Some(&carried));
            let _entered = job.enter();
        });
        let enqueue = spans.iter().find(|s| s.name == "enqueue").unwrap();
        let job = spans.iter().find(|s| s.name == "job").unwrap();
        assert_eq!(job.span_context.trace_id(), enqueue.span_context.trace_id());
        assert_eq!(job.parent_span_id, enqueue.span_context.span_id());
    }

    #[test]
    fn parses_only_well_formed_traceparents() {
        let good = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
        let cx = context_from_traceparent(good).expect("valid");
        assert_eq!(
            cx.span().span_context().trace_id().to_string(),
            "4bf92f3577b34da6a3ce929d0e0e4736"
        );
        for bad in [
            "",
            "garbage",
            "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
            "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01",
            "00-4bf92f35-00f0-01",
            "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01",
            "ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-extra",
        ] {
            assert!(context_from_traceparent(bad).is_none(), "{bad:?}");
        }
    }

    #[test]
    fn a_missing_or_malformed_traceparent_leaves_the_span_a_root() {
        let ((), spans) = traced(|| {
            let job = tracing::info_span!("job");
            set_parent(&job, Some("not-a-traceparent"));
            let _entered = job.enter();
        });
        assert_eq!(
            spans[0].parent_span_id,
            opentelemetry::trace::SpanId::INVALID
        );
    }
}
