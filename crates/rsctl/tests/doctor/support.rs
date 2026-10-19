//! Shared pieces of the probe tests: a recording environment, a rig that runs one check
//! against a local fake, assertions on outcomes, and fakes that verify what a real vendor
//! would verify (`SigV4` signatures, an RS256 JWT).

#![allow(dead_code)]

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;
use std::sync::{Arc, Mutex, OnceLock};

use aws_lc_rs::encoding::AsDer as _;
use aws_lc_rs::rsa::{KeyPair, KeySize};
use aws_lc_rs::signature::KeyPair as _;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use rsctl::doctor::{self, CHECKS, CheckDef, Ctx, Endpoints, Options};
use rsctl::report::{Outcome, Report, SkipKind};
use rsctl::sigv4::{self, Credentials, PathMode};
use rsctl::vars::EnvSource;
use time::{Date, Month, OffsetDateTime, Time};
use wiremock::{MockServer, Request, ResponseTemplate};

/// A fixture file.
pub fn fixture(name: &str) -> String {
    let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("cannot read fixture {path}: {e}"))
}

/// A JSON response with the fixture as its body.
pub fn json(status: u16, name: &str) -> ResponseTemplate {
    ResponseTemplate::new(status).set_body_raw(fixture(name), "application/json")
}

/// An XML response with the fixture as its body.
pub fn xml(status: u16, name: &str) -> ResponseTemplate {
    ResponseTemplate::new(status).set_body_raw(fixture(name), "application/xml")
}

/// The fixed time every probe sees: 2026-10-19 12:00:00 UTC.
pub fn now() -> OffsetDateTime {
    Date::from_calendar_date(2026, Month::October, 19)
        .unwrap()
        .with_time(Time::from_hms(12, 0, 0).unwrap())
        .assume_utc()
}

/// An environment that records which variables were read.
#[derive(Default)]
pub struct RecordingEnv {
    values: BTreeMap<String, String>,
    reads: Mutex<BTreeSet<String>>,
}

impl RecordingEnv {
    pub fn new(pairs: &[(&str, &str)]) -> Self {
        Self {
            values: pairs
                .iter()
                .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
                .collect(),
            reads: Mutex::default(),
        }
    }

    pub fn reads(&self) -> BTreeSet<String> {
        self.reads.lock().unwrap().clone()
    }

    pub fn clear_reads(&self) {
        self.reads.lock().unwrap().clear();
    }
}

impl EnvSource for RecordingEnv {
    fn get(&self, name: &str) -> Option<String> {
        self.reads.lock().unwrap().insert(name.to_owned());
        self.values.get(name).cloned()
    }
}

/// The registry entry with this id.
pub fn def(id: &str) -> &'static CheckDef {
    CHECKS
        .iter()
        .find(|def| def.id == id)
        .unwrap_or_else(|| panic!("no check `{id}`"))
}

/// A fake vendor server and an environment pointing every probe at it.
pub struct Rig {
    pub server: MockServer,
    pub env: Arc<RecordingEnv>,
    pub options: Options,
}

impl Rig {
    pub async fn new(pairs: &[(&str, &str)]) -> Self {
        Self {
            server: MockServer::start().await,
            env: Arc::new(RecordingEnv::new(pairs)),
            options: Options::default(),
        }
    }

    pub fn ctx(&self) -> Arc<Ctx> {
        self.ctx_at(Endpoints::all_at(&self.server.uri()))
    }

    pub fn ctx_at(&self, endpoints: Endpoints) -> Arc<Ctx> {
        let ctx = Ctx::new(
            Arc::clone(&self.env) as Arc<dyn EnvSource>,
            endpoints,
            self.options.clone(),
            Arc::new(now),
        )
        .unwrap();
        // `Ctx::new` reads every secret to register it; what matters below is what a probe reads.
        self.env.clear_reads();
        Arc::new(ctx)
    }

    /// Runs one check and asserts it stayed inside the variables it declares.
    pub async fn run(&self, id: &str) -> Outcome {
        self.run_with(id, &self.ctx()).await
    }

    pub async fn run_with(&self, id: &str, ctx: &Arc<Ctx>) -> Outcome {
        let def = def(id);
        self.env.clear_reads();
        let outcome = (def.run)(ctx).await;
        let allowed: BTreeSet<String> = def.reads.iter().map(|v| v.name().to_owned()).collect();
        let reads = self.env.reads();
        let outside: Vec<&String> = reads.difference(&allowed).collect();
        assert!(
            outside.is_empty(),
            "{id} read {outside:?}, outside its declared set"
        );
        outcome
    }

    /// Runs the whole registry.
    pub async fn report(&self) -> (Report, Arc<Ctx>) {
        let ctx = self.ctx();
        (doctor::run(Arc::clone(&ctx)).await, ctx)
    }
}

pub fn pass(outcome: &Outcome) -> &str {
    match outcome {
        Outcome::Pass(detail) => detail,
        other => panic!("expected PASS, got {other:?}"),
    }
}

pub fn fail(outcome: &Outcome) -> &str {
    match outcome {
        Outcome::Fail(detail) => detail,
        other => panic!("expected FAIL, got {other:?}"),
    }
}

pub fn skip_missing(outcome: &Outcome) -> &str {
    match outcome {
        Outcome::Skip(SkipKind::MissingInput, detail) => detail,
        other => panic!("expected SKIP (missing input), got {other:?}"),
    }
}

pub fn skip_not_verifiable(outcome: &Outcome) -> &str {
    match outcome {
        Outcome::Skip(SkipKind::NotVerifiable, detail) => detail,
        other => panic!("expected SKIP (not verifiable), got {other:?}"),
    }
}

// ---------------------------------------------------------------------------------------
// SigV4 verification, as AWS and R2 do it on the server side.
// ---------------------------------------------------------------------------------------

/// What a fake AWS-style service expects.
#[derive(Clone)]
pub struct AwsExpect {
    pub access_key_id: &'static str,
    pub secret_access_key: &'static str,
    pub region: &'static str,
    pub service: &'static str,
    pub mode: PathMode,
    pub content_sha256: bool,
}

fn header<'a>(request: &'a Request, name: &str) -> Option<&'a str> {
    request.headers.get(name).and_then(|v| v.to_str().ok())
}

fn parse_amz_date(text: &str) -> Option<OffsetDateTime> {
    if text.len() != 16 || !text.ends_with('Z') || text.as_bytes().get(8) != Some(&b'T') {
        return None;
    }
    let n = |range: std::ops::Range<usize>| text.get(range)?.parse::<u8>().ok();
    let year: i32 = text.get(0..4)?.parse().ok()?;
    let date = Date::from_calendar_date(year, Month::try_from(n(4..6)?).ok()?, n(6..8)?).ok()?;
    Some(
        date.with_time(Time::from_hms(n(9..11)?, n(11..13)?, n(13..15)?).ok()?)
            .assume_utc(),
    )
}

/// Checks that `request` is signed the way `expect` says. `Err` is the AWS error code the
/// real service would answer with.
pub fn verify_sigv4(request: &Request, expect: &AwsExpect) -> Result<(), &'static str> {
    let authorization = header(request, "authorization").ok_or("MissingAuthenticationToken")?;
    let rest = authorization
        .strip_prefix("AWS4-HMAC-SHA256 ")
        .ok_or("IncompleteSignature")?;
    let field = |name: &str| {
        rest.split(", ")
            .find_map(|part| part.strip_prefix(name))
            .ok_or("IncompleteSignature")
    };
    let credential = field("Credential=")?;
    let signed_headers = field("SignedHeaders=")?;
    if !credential.starts_with(&format!("{}/", expect.access_key_id)) {
        return Err("InvalidAccessKeyId");
    }
    let wanted_headers = if expect.content_sha256 {
        "host;x-amz-content-sha256;x-amz-date"
    } else {
        "host;x-amz-date"
    };
    assert_eq!(signed_headers, wanted_headers, "signed header list");
    let amz_date = header(request, "x-amz-date").ok_or("IncompleteSignature")?;
    let at = parse_amz_date(amz_date).ok_or("IncompleteSignature")?;
    let payload = rsctl::util::sha256_hex(&request.body);
    if expect.content_sha256 {
        assert_eq!(
            header(request, "x-amz-content-sha256"),
            Some(payload.as_str()),
            "x-amz-content-sha256 must be the body's SHA-256"
        );
    }
    let host = header(request, "host").ok_or("IncompleteSignature")?;
    let expected = sigv4::sign(
        &Credentials {
            access_key_id: rsctl::secret::Secret::new(expect.access_key_id),
            secret_access_key: rsctl::secret::Secret::new(expect.secret_access_key),
        },
        expect.region,
        expect.service,
        expect.mode,
        &sigv4::Request {
            method: request.method.as_str(),
            path: request.url.path(),
            query: &[],
            headers: &[],
            host,
            payload_sha256: &payload,
            sign_content_sha256: expect.content_sha256,
        },
        at,
    );
    if expected.authorization == authorization {
        Ok(())
    } else {
        Err("SignatureDoesNotMatch")
    }
}

// ---------------------------------------------------------------------------------------
// An RSA key for the GitHub App tests, made on the fly so no private key is committed.
// ---------------------------------------------------------------------------------------

pub struct TestKey {
    /// PKCS#1 `RSAPrivateKey`, as GitHub issues for an app ("BEGIN RSA PRIVATE KEY").
    pub pkcs1_pem: String,
    /// PKCS#8 `PrivateKeyInfo` ("BEGIN PRIVATE KEY").
    pub pkcs8_pem: String,
    /// `RSAPublicKey` DER, for `DecodingKey::from_rsa_der`.
    pub public_der: Vec<u8>,
}

fn pem(label: &str, der: &[u8]) -> String {
    let body = STANDARD.encode(der);
    let mut out = String::new();
    let _ = writeln!(out, "-----BEGIN {label}-----");
    for chunk in body.as_bytes().chunks(64) {
        out.push_str(std::str::from_utf8(chunk).unwrap());
        out.push('\n');
    }
    let _ = writeln!(out, "-----END {label}-----");
    out
}

/// Reads one DER element: `(tag, content, rest)`.
fn der_element(buf: &[u8]) -> (u8, &[u8], &[u8]) {
    let tag = buf[0];
    let (len, header) = if buf[1] & 0x80 == 0 {
        (usize::from(buf[1]), 2)
    } else {
        let n = usize::from(buf[1] & 0x7f);
        (
            buf[2..2 + n]
                .iter()
                .fold(0_usize, |acc, b| (acc << 8) | usize::from(*b)),
            2 + n,
        )
    };
    (tag, &buf[header..header + len], &buf[header + len..])
}

/// The PKCS#1 key inside a PKCS#8 `PrivateKeyInfo`.
fn pkcs1_from_pkcs8(pkcs8: &[u8]) -> Vec<u8> {
    let (_, info, _) = der_element(pkcs8);
    let (_, _version, info) = der_element(info);
    let (_, _algorithm, info) = der_element(info);
    let (tag, key, _) = der_element(info);
    assert_eq!(tag, 0x04, "privateKey is an OCTET STRING");
    key.to_vec()
}

fn make_key() -> TestKey {
    let pair = KeyPair::generate(KeySize::Rsa2048).unwrap();
    let pkcs8 = pair.as_der().unwrap();
    TestKey {
        pkcs1_pem: pem("RSA PRIVATE KEY", &pkcs1_from_pkcs8(pkcs8.as_ref())),
        pkcs8_pem: pem("PRIVATE KEY", pkcs8.as_ref()),
        public_der: pair.public_key().as_ref().to_vec(),
    }
}

pub fn test_key() -> &'static TestKey {
    static KEY: OnceLock<TestKey> = OnceLock::new();
    KEY.get_or_init(make_key)
}

/// A second key, for "the wrong key" tests.
pub fn other_test_key() -> &'static TestKey {
    static KEY: OnceLock<TestKey> = OnceLock::new();
    KEY.get_or_init(make_key)
}

/// A real master key ring for row 12 and for the tests that need a valid one.
pub fn master_ring() -> String {
    format!("k1:{}", crypto::KeyRing::generate_master_key().unwrap())
}
