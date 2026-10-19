//! AWS Signature Version 4, for the two AWS-signed APIs the doctor calls: Cloudflare R2's
//! S3 endpoint (service `s3`, region `auto`) and Amazon SES's v2 API (service `ses`).
//!
//! It is written here, not taken from `aws-sdk-s3`, because the doctor needs four requests
//! and the SDK would add well over a hundred crates (ADR-152). The signer is checked against
//! AWS's published test vectors (`tests/sigv4.rs`): the `aws-signing-test-suite` and the
//! worked example in the Amazon S3 documentation.
//!
//! Sources: <https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html>
//! for the algorithm, and botocore's `auth.py` for the one rule the page leaves out: every
//! service except S3 URI-encodes the (already encoded) request path a second time.

use std::fmt::{self, Write as _};

use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;
use time::OffsetDateTime;

use crate::secret::Secret;
use crate::util::{compact_date, compact_timestamp, hex, uri_encode};

const ALGORITHM: &str = "AWS4-HMAC-SHA256";

/// How the request path is canonicalised.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathMode {
    /// Amazon S3 (and R2): the path is used exactly as sent.
    S3,
    /// Every other service: the path as sent is URI-encoded once more.
    Standard,
}

/// An access key pair. Both halves are secrets.
#[derive(Debug, Clone)]
pub struct Credentials {
    /// The access key id.
    pub access_key_id: Secret,
    /// The secret access key.
    pub secret_access_key: Secret,
}

/// What gets signed.
#[derive(Debug, Clone, Copy)]
pub struct Request<'a> {
    /// `GET`, `PUT`, `DELETE`, ...
    pub method: &'a str,
    /// The path as sent on the wire (already percent-encoded). `/` when empty.
    pub path: &'a str,
    /// Query parameters, decoded.
    pub query: &'a [(&'a str, &'a str)],
    /// Headers to sign besides `host`, `x-amz-date` and `x-amz-content-sha256`. These must be
    /// sent with exactly these values.
    pub headers: &'a [(&'a str, &'a str)],
    /// The `Host` header value (`host` or `host:port`).
    pub host: &'a str,
    /// Hex SHA-256 of the body (of the empty string when there is none).
    pub payload_sha256: &'a str,
    /// Whether to sign an `x-amz-content-sha256` header carrying `payload_sha256` (S3 needs it).
    pub sign_content_sha256: bool,
}

/// The canonical request and its signed-header list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Canonical {
    /// The canonical request text.
    pub request: String,
    /// `host;x-amz-date;...`.
    pub signed_headers: String,
}

/// A signed request: set these headers on it.
#[derive(Clone, PartialEq, Eq)]
pub struct Signed {
    /// The `x-amz-date` header.
    pub amz_date: String,
    /// The `x-amz-content-sha256` header, when it was signed.
    pub content_sha256: Option<String>,
    /// The `Authorization` header.
    pub authorization: String,
    /// The hex signature, as it appears in `authorization`.
    pub signature: String,
}

impl fmt::Debug for Signed {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // The Authorization header carries the access key id and a signature.
        f.debug_struct("Signed").finish_non_exhaustive()
    }
}

/// Collapses runs of spaces and tabs to one space and trims the ends.
fn normalise_value(value: &str) -> String {
    value
        .split([' ', '\t'])
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// Builds the canonical request (steps 1 and 2 of the signing process).
#[must_use]
pub fn canonical_request(request: &Request<'_>, mode: PathMode, amz_date: &str) -> Canonical {
    let mut headers: Vec<(String, String)> = vec![
        ("host".to_owned(), normalise_value(request.host)),
        ("x-amz-date".to_owned(), amz_date.to_owned()),
    ];
    if request.sign_content_sha256 {
        headers.push((
            "x-amz-content-sha256".to_owned(),
            request.payload_sha256.to_owned(),
        ));
    }
    headers.extend(
        request
            .headers
            .iter()
            .map(|(name, value)| (name.to_ascii_lowercase(), normalise_value(value))),
    );
    // Stable: repeated header names keep the order they were given in.
    headers.sort_by(|a, b| a.0.cmp(&b.0));
    let mut merged: Vec<(String, String)> = Vec::new();
    for (name, value) in headers {
        match merged.last_mut() {
            Some((last, joined)) if *last == name => {
                joined.push(',');
                joined.push_str(&value);
            }
            _ => merged.push((name, value)),
        }
    }
    let mut canonical_headers = String::new();
    for (name, value) in &merged {
        // Writing to a String cannot fail.
        let _ = writeln!(canonical_headers, "{name}:{value}");
    }
    let signed_headers = merged
        .iter()
        .map(|(n, _)| n.as_str())
        .collect::<Vec<_>>()
        .join(";");

    let path = if request.path.is_empty() {
        "/"
    } else {
        request.path
    };
    let canonical_path = match mode {
        PathMode::S3 => path.to_owned(),
        PathMode::Standard => uri_encode(path, false),
    };
    let mut pairs: Vec<(String, String)> = request
        .query
        .iter()
        .map(|(k, v)| (uri_encode(k, true), uri_encode(v, true)))
        .collect();
    pairs.sort();
    let query = pairs
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("&");

    let text = format!(
        "{}\n{}\n{}\n{}\n{}\n{}",
        request.method.to_ascii_uppercase(),
        canonical_path,
        query,
        canonical_headers,
        signed_headers,
        request.payload_sha256
    );
    Canonical {
        request: text,
        signed_headers,
    }
}

/// The string to sign (step 3).
#[must_use]
pub fn string_to_sign(amz_date: &str, scope: &str, canonical_request: &str) -> String {
    format!(
        "{ALGORITHM}\n{amz_date}\n{scope}\n{}",
        crate::util::sha256_hex(canonical_request.as_bytes())
    )
}

fn hmac(key: &[u8], data: &[u8]) -> [u8; 32] {
    // HMAC accepts keys of any length, so `new_from_slice` cannot fail; the fallback keeps
    // the function total without an `expect`.
    let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(key) else {
        return [0; 32];
    };
    mac.update(data);
    mac.finalize().into_bytes().into()
}

/// The derived signing key (step 4).
#[must_use]
pub fn signing_key(secret: &str, date: &str, region: &str, service: &str) -> [u8; 32] {
    let k_date = hmac(format!("AWS4{secret}").as_bytes(), date.as_bytes());
    let k_region = hmac(&k_date, region.as_bytes());
    let k_service = hmac(&k_region, service.as_bytes());
    hmac(&k_service, b"aws4_request")
}

/// Signs `request` at time `at` and returns the headers to send.
#[must_use]
pub fn sign(
    credentials: &Credentials,
    region: &str,
    service: &str,
    mode: PathMode,
    request: &Request<'_>,
    at: OffsetDateTime,
) -> Signed {
    let amz_date = compact_timestamp(at);
    let date = compact_date(at);
    let scope = format!("{date}/{region}/{service}/aws4_request");
    let canonical = canonical_request(request, mode, &amz_date);
    let to_sign = string_to_sign(&amz_date, &scope, &canonical.request);
    let key = signing_key(
        credentials.secret_access_key.expose(),
        &date,
        region,
        service,
    );
    let signature = hex(&hmac(&key, to_sign.as_bytes()));
    let authorization = format!(
        "{ALGORITHM} Credential={}/{scope}, SignedHeaders={}, Signature={signature}",
        credentials.access_key_id.expose(),
        canonical.signed_headers
    );
    Signed {
        amz_date,
        content_sha256: request
            .sign_content_sha256
            .then(|| request.payload_sha256.to_owned()),
        authorization,
        signature,
    }
}
