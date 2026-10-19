//! No secret reaches output: not through `Debug`, `Display`, an error message, the redactor's
//! gaps, or a failed run of the whole CLI (ADR-151).

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    unreachable_pub
)]

use std::collections::HashMap;
use std::io::Cursor;
use std::sync::Arc;

use rsctl::app::{self, Io, Runtime};
use rsctl::cli::Cli;
use rsctl::doctor::Endpoints;
use rsctl::http::{Http, HttpError};
use rsctl::keys;
use rsctl::secret::{REDACTED, Redactor, Secret};
use rsctl::sigv4::{self, Credentials, PathMode};
use rsctl::vars::{MapEnv, Var, Vars};
use time::OffsetDateTime;

const NEEDLE: &str = "SECRETNEEDLE-0123456789-abcdef";

#[derive(Debug)]
#[allow(dead_code)]
struct Holder {
    name: &'static str,
    secret: Secret,
    nested: Vec<Option<Secret>>,
    map: HashMap<&'static str, Secret>,
}

#[test]
fn debug_and_display_hide_the_value_in_every_format_and_container() {
    let secret = Secret::new(NEEDLE);
    let holder = Holder {
        name: "holder",
        secret: secret.clone(),
        nested: vec![Some(secret.clone()), None],
        map: HashMap::from([("k", secret.clone())]),
    };
    let renderings = [
        format!("{secret:?}"),
        format!("{secret:#?}"),
        format!("{secret}"),
        format!("{secret:>40}"),
        format!("{secret:^40}"),
        secret.to_string(),
        format!("{holder:?}"),
        format!("{holder:#?}"),
        format!("{:?}", (&secret, 1)),
        format!("{:?}", Some(&secret)),
        format!("{:?}", anyhow::anyhow!("failed with {secret}")),
        format!("{}", anyhow::anyhow!("failed with {secret:?}")),
    ];
    for text in renderings {
        assert!(!text.contains(NEEDLE), "{text}");
        assert!(!text.contains("SECRETNEEDLE"), "{text}");
    }
    assert_eq!(format!("{secret}"), REDACTED);
}

#[test]
fn credentials_and_signatures_do_not_debug_print_their_secrets() {
    let credentials = Credentials {
        access_key_id: Secret::new("AKIDEXAMPLE-NEEDLE"),
        secret_access_key: Secret::new(NEEDLE),
    };
    let signed = sigv4::sign(
        &credentials,
        "auto",
        "s3",
        PathMode::S3,
        &sigv4::Request {
            method: "GET",
            path: "/bucket/key",
            query: &[],
            headers: &[],
            host: "example.r2.cloudflarestorage.com",
            payload_sha256: &rsctl::util::sha256_hex(b""),
            sign_content_sha256: true,
        },
        OffsetDateTime::from_unix_timestamp(1_760_000_000).unwrap(),
    );
    for text in [
        format!("{credentials:?}"),
        format!("{credentials:#?}"),
        format!("{signed:?}"),
    ] {
        assert!(!text.contains("NEEDLE"), "{text}");
        assert!(!text.contains(&signed.signature), "{text}");
    }
}

#[test]
fn vars_gathered_values_and_the_redactor_do_not_debug_print_values() {
    let env = MapEnv::from_pairs(&[("ANTHROPIC_API_KEY", NEEDLE), ("STRIPE_SECRET_KEY", NEEDLE)]);
    let vars = Vars::new(Arc::new(env));
    let gathered = vars.gather(5, &[Var::AnthropicApiKey]).unwrap();
    let redactor = Redactor::new();
    vars.register_secrets(&redactor);
    for text in [
        format!("{vars:?}"),
        format!("{gathered:?}"),
        format!("{redactor:?}"),
    ] {
        assert!(!text.contains("NEEDLE"), "{text}");
    }
    assert_eq!(redactor.scrub(&format!("a {NEEDLE} b")), "a [REDACTED] b");
}

#[test]
fn the_redactor_catches_re_encodings_and_pem_lines() {
    let pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEAnotARealKeyJustLongEnoughToCount0001\nqwertyuiopasdfghjklzxcvbnm0123456789QWERTYUIOP==\n-----END RSA PRIVATE KEY-----";
    let redactor = Redactor::new();
    redactor.register(&Secret::new(pem));
    redactor.register(&Secret::new("a b/c+d=e"));
    let text = "line one\nqwertyuiopasdfghjklzxcvbnm0123456789QWERTYUIOP==\nencoded a%20b%2Fc%2Bd%3De and raw a b/c+d=e";
    let scrubbed = redactor.scrub(text);
    assert!(!scrubbed.contains("qwertyuiop"), "{scrubbed}");
    assert!(!scrubbed.contains("a%20b%2F"), "{scrubbed}");
    assert!(!scrubbed.contains("a b/c+d=e"), "{scrubbed}");
}

#[test]
fn every_secret_variable_is_registered_before_any_probe_runs() {
    let pairs: Vec<(String, String)> = Var::ALL
        .iter()
        .filter(|var| var.is_secret())
        .map(|var| {
            (
                var.name().to_owned(),
                format!("VALUE-OF-{}-0123", var.name()),
            )
        })
        .collect();
    let borrowed: Vec<(&str, &str)> = pairs
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    let vars = Vars::new(Arc::new(MapEnv::from_pairs(&borrowed)));
    let redactor = Redactor::new();
    vars.register_secrets(&redactor);
    let everything = pairs
        .iter()
        .map(|(_, v)| v.as_str())
        .collect::<Vec<_>>()
        .join(" | ");
    let scrubbed = redactor.scrub(&everything);
    assert!(!scrubbed.contains("VALUE-OF-"), "{scrubbed}");
}

#[test]
fn http_errors_are_fixed_text_that_never_holds_the_url() {
    for error in [
        HttpError::BadUrl,
        HttpError::Insecure,
        HttpError::Timeout,
        HttpError::Connect,
        HttpError::Body,
        HttpError::Request,
    ] {
        for text in [error.to_string(), format!("{error:?}")] {
            assert!(
                !text.contains("http") || text == "the endpoint must use https",
                "{text}"
            );
        }
    }
    // The URL carries a secret here, in the userinfo, path and query.
    let http = Http::new(std::time::Duration::from_secs(2)).unwrap();
    let url = format!("http://user:{NEEDLE}@example.com/{NEEDLE}?token={NEEDLE}");
    let error = http.request(reqwest::Method::GET, &url).unwrap_err();
    assert_eq!(error, HttpError::Insecure);
    assert!(!error.to_string().contains("NEEDLE") && !format!("{error:?}").contains("NEEDLE"));
}

#[tokio::test]
async fn a_failed_connection_does_not_echo_the_url_it_tried() {
    let http = Http::new(std::time::Duration::from_secs(2)).unwrap();
    // Port 1 on loopback refuses the connection.
    let url = format!("http://127.0.0.1:1/{NEEDLE}?token={NEEDLE}");
    let request = http.request(reqwest::Method::GET, &url).unwrap();
    let error = http.send(request).await.unwrap_err();
    assert_eq!(error, HttpError::Connect);
    assert!(!error.to_string().contains("NEEDLE") && !format!("{error:?}").contains("NEEDLE"));
}

#[test]
fn key_errors_never_contain_key_material() {
    let ring = keys::generate(
        OffsetDateTime::from_unix_timestamp(1_760_000_000).unwrap(),
        Some("k1"),
    )
    .unwrap();
    let key = ring.ring.expose().split(':').nth(1).unwrap().to_owned();
    // Break the ring in several ways that keep the key text in the input.
    let broken = [
        format!("k1:{key},k1:{key}"),
        format!("K1:{key}"),
        format!("k1:{key}x"),
        key.clone(),
        format!("k1:{key},"),
    ];
    for bad in &broken {
        for result in [
            keys::rotate(bad, OffsetDateTime::UNIX_EPOCH, None).map(|u| u.active),
            keys::drop_keys(bad, &["k1".to_owned()]).map(|u| u.active),
            keys::ids(bad).map(|ids| ids.join(",")),
        ] {
            if let Err(error) = result {
                let text = format!("{error} / {error:?}");
                assert!(!text.contains(&key), "{text}");
            }
        }
    }
    assert!(format!("{ring:?}").contains("REDACTED") && !format!("{ring:?}").contains(&key));
}

/// Runs the doctor through the real command layer against vendors that refuse the connection,
/// with a recognisable secret in every secret variable.
#[tokio::test]
async fn a_whole_failed_run_prints_no_secret_to_either_stream() {
    let pairs: Vec<(String, String)> = Var::ALL
        .iter()
        .map(|var| {
            let value = if var.is_secret() {
                format!("ECHOME-{}-0123456789", var.name())
            } else {
                // Public identifiers, shaped so the probes get as far as sending.
                match var {
                    Var::ShopifyPartnerOrgId => "4321".to_owned(),
                    Var::ShopifyAppGid => "gid://shopify/App/1".to_owned(),
                    Var::ShopifyDevStoreDomain => "a.myshopify.com".to_owned(),
                    Var::ShopifyDevStoreBDomain => "b.myshopify.com".to_owned(),
                    Var::GithubAppId => "1".to_owned(),
                    Var::R2AccountId => "0123456789abcdef".to_owned(),
                    Var::R2BucketEvidence => "bucket-one".to_owned(),
                    Var::R2BucketBackups => "bucket-two".to_owned(),
                    Var::SesRegion => "eu-west-1".to_owned(),
                    Var::EmailFrom => "hello@example.com".to_owned(),
                    Var::OtelExporterOtlpEndpoint => "http://127.0.0.1:1/otlp".to_owned(),
                    other => format!("public-{}", other.name()),
                }
            };
            (var.name().to_owned(), value)
        })
        .collect();
    let borrowed: Vec<(&str, &str)> = pairs
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    // Every vendor is a closed port on loopback.
    let dead = Endpoints::all_at("http://127.0.0.1:1");
    for json in [false, true] {
        let runtime = Runtime {
            env: Arc::new(MapEnv::from_pairs(&borrowed)),
            endpoints: dead.clone(),
            clock: Arc::new(OffsetDateTime::now_utc),
        };
        let cli = <Cli as clap::Parser>::try_parse_from(
            ["rsctl", "doctor", "--environment", "staging"]
                .into_iter()
                .chain(json.then_some("--json")),
        )
        .unwrap();
        let (mut stdin, mut out, mut err) = (Cursor::new(Vec::new()), Vec::new(), Vec::new());
        let code = app::run(
            cli,
            runtime,
            &mut Io {
                stdin: &mut stdin,
                stdout: &mut out,
                stderr: &mut err,
            },
        )
        .await;
        let (out, err) = (
            String::from_utf8(out).unwrap(),
            String::from_utf8(err).unwrap(),
        );
        assert_eq!(code, 1, "unreachable vendors fail the run:\n{out}");
        assert!(
            out.contains("could not be reached") || out.contains("could not connect"),
            "{out}"
        );
        for stream in [&out, &err] {
            assert!(!stream.contains("ECHOME"), "{stream}");
        }
    }
}
