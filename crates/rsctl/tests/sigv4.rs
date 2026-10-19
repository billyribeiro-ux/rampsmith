//! `SigV4` against AWS's published vectors (ADR-154).
//!
//! - `tests/fixtures/sigv4/*` is copied from
//!   <https://github.com/awslabs/aws-c-auth/tree/main/tests/aws-signing-test-suite/v4>
//!   (read 2026-10-19); only the `context.json` whitespace differs, from the repository's
//!   Prettier check. The credentials are AWS's documentation examples.
//! - The two S3 examples are quoted from "Authenticating Requests: Using the Authorization
//!   Header (AWS Signature Version 4)" in the Amazon S3 API reference (read 2026-10-19).

// Integration tests are test code: PLAN §8 denies these lints outside tests only.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::path::PathBuf;

use rsctl::secret::Secret;
use rsctl::sigv4::{Credentials, PathMode, Request, canonical_request, sign, string_to_sign};
use rsctl::util::sha256_hex;
use serde::Deserialize;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

#[derive(Deserialize)]
struct Context {
    credentials: Creds,
    region: String,
    service: String,
    sign_body: bool,
    timestamp: String,
}

#[derive(Deserialize)]
struct Creds {
    access_key_id: String,
    secret_access_key: String,
}

fn fixture(dir: &str, file: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/sigv4")
        .join(dir)
        .join(file);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// Runs one vector from the AWS suite end to end.
fn check_vector(name: &str) {
    let context: Context = serde_json::from_str(&fixture(name, "context.json")).unwrap();
    let raw = fixture(name, "request.txt");
    let (head, body) = raw.split_once("\n\n").unwrap_or((raw.as_str(), ""));
    let mut lines = head.lines();
    let mut request_line = lines.next().unwrap().split(' ');
    let method = request_line.next().unwrap();
    let target = request_line.next().unwrap();
    let (path, query_text) = target.split_once('?').unwrap_or((target, ""));
    let query: Vec<(&str, &str)> = query_text
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| pair.split_once('=').unwrap_or((pair, "")))
        .collect();
    let mut host = "";
    let mut extra: Vec<(&str, &str)> = Vec::new();
    for line in lines {
        let (key, value) = line.split_once(':').unwrap();
        if key.eq_ignore_ascii_case("host") {
            host = value;
        } else {
            extra.push((key, value));
        }
    }
    let payload = sha256_hex(body.as_bytes());
    let request = Request {
        method,
        path,
        query: &query,
        headers: &extra,
        host,
        payload_sha256: &payload,
        sign_content_sha256: context.sign_body,
    };
    let at = OffsetDateTime::parse(&context.timestamp, &Rfc3339).unwrap();
    let credentials = Credentials {
        access_key_id: Secret::new(context.credentials.access_key_id),
        secret_access_key: Secret::new(context.credentials.secret_access_key),
    };

    let signed = sign(
        &credentials,
        &context.region,
        &context.service,
        PathMode::Standard,
        &request,
        at,
    );
    let canonical = canonical_request(&request, PathMode::Standard, &signed.amz_date);
    let scope = format!(
        "20150830/{}/{}/aws4_request",
        context.region, context.service
    );
    assert_eq!(
        canonical.request.trim_end(),
        fixture(name, "header-canonical-request.txt").trim_end(),
        "{name}: canonical request"
    );
    assert_eq!(
        string_to_sign(&signed.amz_date, &scope, &canonical.request).trim_end(),
        fixture(name, "header-string-to-sign.txt").trim_end(),
        "{name}: string to sign"
    );
    assert_eq!(
        signed.signature,
        fixture(name, "header-signature.txt").trim(),
        "{name}: signature"
    );
    assert!(
        signed
            .authorization
            .contains(&format!("Signature={}", signed.signature)),
        "{name}: authorization header carries the signature"
    );
}

#[test]
fn aws_suite_get_vanilla() {
    check_vector("get-vanilla");
}

#[test]
fn aws_suite_query_parameters_are_sorted_after_encoding() {
    check_vector("get-vanilla-query-order-key-case");
    check_vector("get-vanilla-query-unreserved");
    check_vector("get-vanilla-empty-query-key");
}

#[test]
fn aws_suite_header_values_are_trimmed_and_duplicates_joined() {
    check_vector("get-header-value-trim");
    check_vector("get-header-key-duplicate");
}

#[test]
fn aws_suite_paths_are_encoded() {
    check_vector("get-unreserved");
    check_vector("get-utf8");
}

#[test]
fn aws_suite_post_with_and_without_a_signed_body() {
    check_vector("post-vanilla");
    check_vector("post-x-www-form-urlencoded");
}

fn s3_example_credentials() -> Credentials {
    Credentials {
        access_key_id: Secret::new("AKIAIOSFODNN7EXAMPLE"),
        secret_access_key: Secret::new("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"),
    }
}

fn s3_example_time() -> OffsetDateTime {
    OffsetDateTime::parse("2013-05-24T00:00:00Z", &Rfc3339).unwrap()
}

#[test]
fn s3_documentation_example_get_object_with_range() {
    let empty = sha256_hex(b"");
    let request = Request {
        method: "GET",
        path: "/test.txt",
        query: &[],
        headers: &[("Range", "bytes=0-9")],
        host: "examplebucket.s3.amazonaws.com",
        payload_sha256: &empty,
        sign_content_sha256: true,
    };
    let signed = sign(
        &s3_example_credentials(),
        "us-east-1",
        "s3",
        PathMode::S3,
        &request,
        s3_example_time(),
    );
    let canonical = canonical_request(&request, PathMode::S3, &signed.amz_date);
    assert_eq!(
        canonical.request,
        "GET\n/test.txt\n\nhost:examplebucket.s3.amazonaws.com\nrange:bytes=0-9\n\
         x-amz-content-sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n\
         x-amz-date:20130524T000000Z\n\nhost;range;x-amz-content-sha256;x-amz-date\n\
         e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    assert_eq!(
        string_to_sign(
            &signed.amz_date,
            "20130524/us-east-1/s3/aws4_request",
            &canonical.request
        ),
        "AWS4-HMAC-SHA256\n20130524T000000Z\n20130524/us-east-1/s3/aws4_request\n\
         7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972"
    );
    assert_eq!(
        signed.signature,
        "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
    );
}

#[test]
fn s3_documentation_example_put_object_with_a_dollar_in_the_key() {
    let payload = sha256_hex(b"Welcome to Amazon S3.");
    assert_eq!(
        payload,
        "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072"
    );
    let request = Request {
        method: "PUT",
        // The wire form of `test$file.text`.
        path: "/test%24file.text",
        query: &[],
        headers: &[
            ("Date", "Fri, 24 May 2013 00:00:00 GMT"),
            ("x-amz-storage-class", "REDUCED_REDUNDANCY"),
        ],
        host: "examplebucket.s3.amazonaws.com",
        payload_sha256: &payload,
        sign_content_sha256: true,
    };
    let signed = sign(
        &s3_example_credentials(),
        "us-east-1",
        "s3",
        PathMode::S3,
        &request,
        s3_example_time(),
    );
    assert_eq!(
        signed.signature,
        "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd"
    );
    assert!(
        signed.authorization.contains(
            "SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class"
        )
    );
}

#[test]
fn services_other_than_s3_encode_the_path_a_second_time() {
    let empty = sha256_hex(b"");
    let request = Request {
        method: "GET",
        path: "/v2/email/identities/ops%40example.com",
        query: &[],
        headers: &[],
        host: "email.us-east-1.amazonaws.com",
        payload_sha256: &empty,
        sign_content_sha256: false,
    };
    let standard = canonical_request(&request, PathMode::Standard, "20261019T120000Z");
    let s3 = canonical_request(&request, PathMode::S3, "20261019T120000Z");
    assert!(
        standard
            .request
            .contains("\n/v2/email/identities/ops%2540example.com\n")
    );
    assert!(
        s3.request
            .contains("\n/v2/email/identities/ops%40example.com\n")
    );
}

#[test]
fn debug_output_hides_the_authorization_header() {
    let empty = sha256_hex(b"");
    let request = Request {
        method: "GET",
        path: "/",
        query: &[],
        headers: &[],
        host: "example.amazonaws.com",
        payload_sha256: &empty,
        sign_content_sha256: false,
    };
    let signed = sign(
        &s3_example_credentials(),
        "us-east-1",
        "service",
        PathMode::Standard,
        &request,
        s3_example_time(),
    );
    let shown = format!("{signed:?}");
    assert!(!shown.contains("AKIAIOSFODNN7EXAMPLE"), "{shown}");
    assert!(!shown.contains(&signed.signature), "{shown}");
    let creds = format!("{:?}", s3_example_credentials());
    assert!(
        !creds.contains("AKIAIOSFODNN7EXAMPLE") && !creds.contains("wJalr"),
        "{creds}"
    );
}
