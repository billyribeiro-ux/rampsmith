//! Helpers shared by the probes.

use reqwest::{Method, RequestBuilder};
use serde::Deserialize;
use serde_json::Value;

use super::Ctx;
use crate::http::{HttpError, Reply, authority, check_url};
use crate::report::Outcome;
use crate::secret::Secret;
use crate::sigv4::{self, Credentials, PathMode};
use crate::util::{safe_token, sha256_hex};
use crate::vars::{Gathered, Var};

/// The result type probes use internally: `Err` is an outcome that ends the probe early.
pub(super) type Step<T> = Result<T, Outcome>;

/// A value that can be sent in an HTTP header: visible ASCII, no spaces.
pub(super) fn header_safe(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|b| (0x21..=0x7e).contains(&b))
}

/// The outcome for a request that got no response.
pub(super) fn unreachable(vendor: &str, error: HttpError) -> Outcome {
    Outcome::fail(format!("{vendor} could not be reached: {error}"))
}

/// The outcome for an input that cannot go into a header.
pub(super) fn bad_header(name: &str) -> Outcome {
    Outcome::fail(format!(
        "{name} contains characters that cannot be sent in an HTTP header (spaces, line breaks or non-ASCII)"
    ))
}

/// `HTTP 401` style prefix with an optional vendor code.
pub(super) fn status_text(status: u16, code: Option<&str>) -> String {
    match code {
        Some(code) if !code.is_empty() => format!("HTTP {status} {}", safe_token(code)),
        _ => format!("HTTP {status}"),
    }
}

/// Reads `needs` for a row, or the outcome for the gap.
pub(super) fn gather(ctx: &Ctx, row: u8, needs: &[Var]) -> Step<Gathered> {
    ctx.vars
        .gather(row, needs)
        .map_err(|gap| Outcome::from_gap(&gap))
}

/// Sends a request and reads the reply, or the outcome for a transport failure.
pub(super) async fn send(ctx: &Ctx, vendor: &str, request: RequestBuilder) -> Step<Reply> {
    ctx.http
        .send(request)
        .await
        .map_err(|error| unreachable(vendor, error))
}

/// A request builder for `url`.
pub(super) fn request(ctx: &Ctx, method: Method, url: &str) -> Step<RequestBuilder> {
    ctx.request(method, url)
}

/// Stripe, Anthropic and OAuth-style error bodies: `{"error": {"type": ..., "code": ...}}`
/// or `{"error": "code"}`. Returns the code, never the message.
pub(super) fn error_code(body: &[u8]) -> Option<String> {
    #[derive(Deserialize)]
    struct Detail {
        #[serde(rename = "type")]
        kind: Option<String>,
        code: Option<String>,
    }
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Error {
        Code(String),
        Detail(Detail),
    }
    #[derive(Deserialize)]
    struct Envelope {
        error: Option<Error>,
    }
    let envelope: Envelope = serde_json::from_slice(body).ok()?;
    match envelope.error? {
        Error::Code(code) => Some(code),
        Error::Detail(detail) => detail.code.or(detail.kind),
    }
}

/// The `extensions.code` of each GraphQL error in a response body.
pub(super) fn graphql_codes(body: &Value) -> Vec<String> {
    body.get("errors")
        .and_then(Value::as_array)
        .map(|errors| {
            errors
                .iter()
                .map(|error| {
                    error
                        .pointer("/extensions/code")
                        .and_then(Value::as_str)
                        .map_or_else(|| "GraphQL error".to_owned(), safe_token)
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Whether a GraphQL body carries an `errors` array.
pub(super) fn has_graphql_errors(body: &Value) -> bool {
    body.get("errors")
        .and_then(Value::as_array)
        .is_some_and(|errors| !errors.is_empty())
}

/// The text between `<tag>` and `</tag>` in an XML body (S3 and R2 error documents).
pub(super) fn xml_tag(body: &[u8], tag: &str) -> Option<String> {
    let text = String::from_utf8_lossy(body);
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = text.find(&open)? + open.len();
    let rest = text.get(start..)?;
    let end = rest.find(&close)?;
    rest.get(..end).map(str::to_owned)
}

/// `https://<shop>` for a validated shop domain, or the test override.
pub(super) fn shop_base(ctx: &Ctx, domain: &str, name: &str) -> Step<String> {
    let shop = shopify::ShopDomain::parse(domain).map_err(|_| {
        Outcome::fail(format!(
            "{name} is not a *.myshopify.com domain (use the permanent domain, without https://)"
        ))
    })?;
    Ok(ctx.endpoints.shop_origin.as_deref().map_or_else(
        || shop.origin(),
        |origin| origin.trim_end_matches('/').to_owned(),
    ))
}

/// What an AWS-signed request is signed for.
#[derive(Debug, Clone, Copy)]
pub(super) struct AwsScope<'a> {
    pub(super) region: &'a str,
    pub(super) service: &'a str,
    pub(super) mode: PathMode,
    /// Whether to sign (and send) `x-amz-content-sha256`; S3 and R2 need it.
    pub(super) content_sha256: bool,
}

/// A `SigV4`-signed request to `url` (no query string).
pub(super) fn aws_request(
    ctx: &Ctx,
    method: Method,
    url: &str,
    credentials: &Credentials,
    scope: AwsScope<'_>,
    body: &[u8],
) -> Step<RequestBuilder> {
    let parsed =
        check_url(url).map_err(|e| Outcome::fail(format!("cannot build the request: {e}")))?;
    let host = authority(&parsed);
    let payload = sha256_hex(body);
    let signed = sigv4::sign(
        credentials,
        scope.region,
        scope.service,
        scope.mode,
        &sigv4::Request {
            method: method.as_str(),
            path: parsed.path(),
            query: &[],
            headers: &[],
            host: &host,
            payload_sha256: &payload,
            sign_content_sha256: scope.content_sha256,
        },
        ctx.now(),
    );
    let mut builder = request(ctx, method, url)?
        .header("x-amz-date", signed.amz_date)
        .header("authorization", signed.authorization);
    if let Some(content) = signed.content_sha256 {
        builder = builder.header("x-amz-content-sha256", content);
    }
    if !body.is_empty() {
        builder = builder.body(body.to_vec());
    }
    Ok(builder)
}

/// Registers a token a probe minted, so a stray echo is scrubbed from the output.
pub(super) fn register(ctx: &Ctx, secret: &Secret) {
    ctx.redactor.register(secret);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_safety() {
        assert!(header_safe("sk-ant-api03-abc_DEF"));
        assert!(!header_safe(""));
        assert!(!header_safe("two words"));
        assert!(!header_safe("line\nbreak"));
        assert!(!header_safe("ünicode"));
    }

    #[test]
    fn error_codes_come_from_the_envelope() {
        assert_eq!(
            error_code(br#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#).as_deref(),
            Some("authentication_error")
        );
        assert_eq!(
            error_code(br#"{"error":{"type":"invalid_request_error","code":"api_key_invalid","message":"x"}}"#).as_deref(),
            Some("api_key_invalid")
        );
        assert_eq!(
            error_code(br#"{"error":"invalid_client","error_description":"free text"}"#).as_deref(),
            Some("invalid_client")
        );
        assert_eq!(error_code(b"not json"), None);
    }

    #[test]
    fn graphql_error_codes_are_extensions_only() {
        let body: Value = serde_json::from_str(
            r#"{"errors":[{"message":"free text with sk_secret","extensions":{"code":"ACCESS_DENIED"}},{"message":"x"}]}"#,
        )
        .unwrap();
        assert_eq!(graphql_codes(&body), vec!["ACCESS_DENIED", "GraphQL error"]);
        assert!(has_graphql_errors(&body));
        assert!(!has_graphql_errors(&serde_json::json!({"data": {}})));
    }

    #[test]
    fn xml_tags_are_extracted() {
        let body = b"<?xml version=\"1.0\"?><Error><Code>SignatureDoesNotMatch</Code><Message>x</Message></Error>";
        assert_eq!(
            xml_tag(body, "Code").as_deref(),
            Some("SignatureDoesNotMatch")
        );
        assert_eq!(xml_tag(body, "Nope"), None);
    }
}
