//! C row 9: the OTLP endpoint accepts an empty export (ADR-152).
//!
//! `POST <endpoint>/v1/traces` with `Content-Type: application/x-protobuf` and an empty body.
//! An empty body is a valid `ExportTraceServiceRequest` with no spans, and the OTLP/HTTP
//! specification says a server answers it with 200 and an `ExportTraceServiceResponse`, so
//! nothing is stored. Credentials come from `OTEL_EXPORTER_OTLP_HEADERS`.

use reqwest::Method;
use reqwest::header::{HeaderName, HeaderValue};

use super::common::{Step, gather, request, send, status_text};
use super::{Ctx, ProbeFuture};
use crate::report::Outcome;
use crate::util::percent_decode;
use crate::vars::Var;

pub(super) const READS: &[Var] = &[
    Var::OtelExporterOtlpEndpoint,
    Var::OtelExporterOtlpHeaders,
    Var::OtelExporterOtlpProtocol,
];

/// What `gather` needs: the protocol is optional (its default is `http/protobuf`).
const REQUIRED: &[Var] = &[Var::OtelExporterOtlpEndpoint, Var::OtelExporterOtlpHeaders];

pub(super) fn run(ctx: &Ctx) -> ProbeFuture<'_> {
    Box::pin(async move { probe(ctx).await.unwrap_or_else(|outcome| outcome) })
}

/// Parses `key1=value1,key2=value2` (W3C Baggage style, values percent-decoded), as the
/// OpenTelemetry specification defines `OTEL_EXPORTER_OTLP_HEADERS`.
fn parse_headers(text: &str) -> Result<Vec<(HeaderName, HeaderValue)>, &'static str> {
    let mut headers = Vec::new();
    for pair in text.split(',').map(str::trim).filter(|p| !p.is_empty()) {
        let (name, value) = pair
            .split_once('=')
            .ok_or("OTEL_EXPORTER_OTLP_HEADERS must be key=value pairs separated by commas")?;
        let value = percent_decode(value.trim())
            .ok_or("OTEL_EXPORTER_OTLP_HEADERS has a bad percent escape or is not UTF-8")?;
        let name = HeaderName::from_bytes(name.trim().as_bytes())
            .map_err(|_| "OTEL_EXPORTER_OTLP_HEADERS has an invalid header name")?;
        let mut value = HeaderValue::from_str(&value)
            .map_err(|_| "OTEL_EXPORTER_OTLP_HEADERS has a value that cannot be a header value")?;
        value.set_sensitive(true);
        headers.push((name, value));
    }
    if headers.is_empty() {
        Err("OTEL_EXPORTER_OTLP_HEADERS has no key=value pair")
    } else {
        Ok(headers)
    }
}

async fn probe(ctx: &Ctx) -> Step<Outcome> {
    let inputs = gather(ctx, 9, REQUIRED)?;
    if let Some(protocol) = ctx.vars.get(Var::OtelExporterOtlpProtocol)
        && protocol != "http/protobuf"
    {
        return Ok(Outcome::fail(
            "OTEL_EXPORTER_OTLP_PROTOCOL must be http/protobuf: Rampsmith's exporter speaks OTLP over HTTP (ADR-019), not gRPC or JSON",
        ));
    }
    let headers = match parse_headers(inputs.text(Var::OtelExporterOtlpHeaders)) {
        Ok(headers) => headers,
        Err(reason) => return Ok(Outcome::fail(reason)),
    };
    let base = inputs
        .text(Var::OtelExporterOtlpEndpoint)
        .trim_end_matches('/');
    let url = format!("{base}/v1/traces");
    let mut builder = request(ctx, Method::POST, &url)?
        .header("content-type", "application/x-protobuf")
        .body(Vec::<u8>::new());
    for (name, value) in headers {
        builder = builder.header(name, value);
    }
    let reply = send(ctx, "the OTLP endpoint", builder).await?;
    if reply.is_success() {
        return Ok(Outcome::pass(format!(
            "the endpoint accepted an empty trace export ({})",
            status_text(reply.status, None)
        )));
    }
    let meaning = match reply.status {
        401 | 403 => " (the credentials in OTEL_EXPORTER_OTLP_HEADERS were rejected)",
        404 => {
            " (no OTLP/HTTP traces path here: the endpoint should be the base URL, for Grafana Cloud ending /otlp)"
        }
        _ => "",
    };
    Ok(Outcome::fail(format!(
        "POST /v1/traces failed: {}{meaning}",
        status_text(reply.status, None)
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headers_parse_baggage_style() {
        let parsed = parse_headers("Authorization=Basic%20dXNlcjpwYXNz, x-scope=a%2Cb").unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].0.as_str(), "authorization");
        assert_eq!(parsed[0].1.to_str().unwrap(), "Basic dXNlcjpwYXNz");
        assert_eq!(parsed[1].1.to_str().unwrap(), "a,b");
        assert!(parsed[0].1.is_sensitive());
    }

    #[test]
    fn bad_headers_are_rejected_without_echoing_them() {
        for bad in ["", "novalue", "Authorization=%zz", "bad name=x", "a=b\nc"] {
            let error = parse_headers(bad).unwrap_err();
            assert!(!error.contains(bad) || bad.is_empty(), "{error}");
        }
    }
}
