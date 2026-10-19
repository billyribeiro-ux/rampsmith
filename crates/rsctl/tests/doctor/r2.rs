//! C row 6, R2: the access key writes, reads and deletes an object in each bucket.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use rsctl::sigv4::PathMode;
use wiremock::matchers::any;
use wiremock::{Mock, Request, Respond, ResponseTemplate};

use crate::support::{AwsExpect, Rig, fail, pass, skip_missing, verify_sigv4, xml};

const ACCOUNT: &str = "0123456789abcdef0123456789abcdef";
const KEY_ID: &str = "test-r2-access-key-id-SECRET-1";
const SECRET: &str = "test-r2-secret-access-key-SECRET-2";
const EVIDENCE: &str = "rampsmith-evidence";
const BACKUPS: &str = "rampsmith-backups";

fn all() -> Vec<(&'static str, &'static str)> {
    vec![
        ("R2_ACCOUNT_ID", ACCOUNT),
        ("R2_ACCESS_KEY_ID", KEY_ID),
        ("R2_SECRET_ACCESS_KEY", SECRET),
        ("R2_BUCKET_EVIDENCE", EVIDENCE),
        ("R2_BUCKET_BACKUPS", BACKUPS),
    ]
}

#[derive(Clone, Copy, Default)]
struct Faults {
    deny_put: bool,
    deny_delete: bool,
    wrong_content_on_get: bool,
}

/// R2's S3 API: verifies `SigV4` (service `s3`, region `auto`, signed content hash), keeps
/// objects in memory, and answers with S3's XML errors.
#[derive(Clone)]
struct FakeR2 {
    expect: AwsExpect,
    buckets: Vec<&'static str>,
    objects: Arc<Mutex<HashMap<String, Vec<u8>>>>,
    log: Arc<Mutex<Vec<String>>>,
    faults: Faults,
}

impl FakeR2 {
    fn new(buckets: &[&'static str], faults: Faults) -> Self {
        Self {
            expect: AwsExpect {
                access_key_id: KEY_ID,
                secret_access_key: SECRET,
                region: "auto",
                service: "s3",
                mode: PathMode::S3,
                content_sha256: true,
            },
            buckets: buckets.to_vec(),
            objects: Arc::default(),
            log: Arc::default(),
            faults,
        }
    }
}

impl Respond for FakeR2 {
    fn respond(&self, request: &Request) -> ResponseTemplate {
        if let Err(code) = verify_sigv4(request, &self.expect) {
            let name = if code == "InvalidAccessKeyId" {
                "r2/invalid-access-key-id.xml"
            } else {
                "r2/signature-does-not-match.xml"
            };
            return xml(403, name);
        }
        let path = request.url.path().to_owned();
        let Some((bucket, key)) = path.trim_start_matches('/').split_once('/') else {
            return xml(404, "r2/no-such-bucket.xml");
        };
        if !self.buckets.contains(&bucket) {
            return xml(404, "r2/no-such-bucket.xml");
        }
        assert!(
            key.starts_with("rsctl-doctor/"),
            "probe objects live under rsctl-doctor/"
        );
        self.log
            .lock()
            .unwrap()
            .push(format!("{} {path}", request.method));
        let mut objects = self.objects.lock().unwrap();
        match request.method.as_str() {
            "PUT" if self.faults.deny_put => xml(403, "r2/access-denied.xml"),
            "PUT" => {
                objects.insert(path, request.body.clone());
                ResponseTemplate::new(200)
                    .insert_header("etag", "\"d41d8cd98f00b204e9800998ecf8427e\"")
            }
            "GET" => match objects.get(&path) {
                Some(_) if self.faults.wrong_content_on_get => {
                    ResponseTemplate::new(200).set_body_bytes(b"something else".to_vec())
                }
                Some(body) => ResponseTemplate::new(200).set_body_bytes(body.clone()),
                None => ResponseTemplate::new(404),
            },
            "DELETE" if self.faults.deny_delete => xml(403, "r2/access-denied.xml"),
            "DELETE" => {
                objects.remove(&path);
                ResponseTemplate::new(204)
            }
            _ => ResponseTemplate::new(405),
        }
    }
}

async fn mount(rig: &Rig, fake: FakeR2) {
    Mock::given(any())
        .respond_with(fake)
        .mount(&rig.server)
        .await;
}

pub fn vars() -> Vec<(&'static str, &'static str)> {
    all()
}

/// Both buckets, healthy.
pub async fn healthy(server: &wiremock::MockServer) {
    let fake = FakeR2::new(&[EVIDENCE, BACKUPS], Faults::default());
    Mock::given(wiremock::matchers::path_regex(
        "^/rampsmith-(evidence|backups)/",
    ))
    .respond_with(fake)
    .mount(server)
    .await;
}

#[tokio::test]
async fn writes_reads_and_deletes_a_signed_probe_object_in_each_bucket() {
    let rig = Rig::new(&all()).await;
    let fake = FakeR2::new(&[EVIDENCE, BACKUPS], Faults::default());
    mount(&rig, fake.clone()).await;

    let evidence = rig.run("r2.evidence").await;
    let backups = rig.run("r2.backups").await;
    assert!(
        pass(&evidence).contains(&format!("`{EVIDENCE}`")),
        "{evidence:?}"
    );
    assert!(
        pass(&backups).contains(&format!("`{BACKUPS}`")),
        "{backups:?}"
    );
    assert!(!pass(&evidence).contains(SECRET) && !pass(&evidence).contains(KEY_ID));

    // Nothing is left behind, and each bucket saw exactly PUT, GET, DELETE of one object.
    assert!(
        fake.objects.lock().unwrap().is_empty(),
        "the probe object was deleted"
    );
    let log = fake.log.lock().unwrap().clone();
    assert_eq!(log.len(), 6, "{log:?}");
    for bucket in [EVIDENCE, BACKUPS] {
        let mine: Vec<&String> = log
            .iter()
            .filter(|line| line.contains(&format!("/{bucket}/")))
            .collect();
        assert_eq!(mine.len(), 3, "{log:?}");
        assert!(
            mine[0].starts_with("PUT ")
                && mine[1].starts_with("GET ")
                && mine[2].starts_with("DELETE ")
        );
        assert!(
            mine[0].contains("/rsctl-doctor/20261019T120000Z-000000000.txt"),
            "{mine:?}"
        );
    }
}

#[tokio::test]
async fn a_wrong_secret_fails_with_s3s_code() {
    let mut vars = all();
    vars[2] = ("R2_SECRET_ACCESS_KEY", "a-different-secret-SECRET-9");
    let rig = Rig::new(&vars).await;
    mount(&rig, FakeR2::new(&[EVIDENCE], Faults::default())).await;
    let outcome = rig.run("r2.evidence").await;
    let detail = fail(&outcome);
    assert!(
        detail.contains("SignatureDoesNotMatch") && detail.contains("R2_SECRET_ACCESS_KEY"),
        "{detail}"
    );
    assert!(!detail.contains("a-different-secret"), "{detail}");
    assert!(
        !detail.contains("we calculated"),
        "vendor text is not printed: {detail}"
    );
}

#[tokio::test]
async fn a_wrong_access_key_id_fails() {
    let mut vars = all();
    vars[1] = ("R2_ACCESS_KEY_ID", "some-other-key-id-SECRET-8");
    let rig = Rig::new(&vars).await;
    mount(&rig, FakeR2::new(&[EVIDENCE], Faults::default())).await;
    assert!(fail(&rig.run("r2.evidence").await).contains("InvalidAccessKeyId"));
}

#[tokio::test]
async fn a_bucket_the_account_does_not_have_fails() {
    let rig = Rig::new(&all()).await;
    mount(&rig, FakeR2::new(&[EVIDENCE], Faults::default())).await;
    let outcome = rig.run("r2.backups").await;
    assert!(fail(&outcome).contains("NoSuchBucket"), "{outcome:?}");
}

#[tokio::test]
async fn a_token_without_write_permission_fails_at_the_write() {
    let rig = Rig::new(&all()).await;
    mount(
        &rig,
        FakeR2::new(
            &[EVIDENCE],
            Faults {
                deny_put: true,
                ..Faults::default()
            },
        ),
    )
    .await;
    let outcome = rig.run("r2.evidence").await;
    let detail = fail(&outcome);
    assert!(
        detail.contains("writing the probe object") && detail.contains("AccessDenied"),
        "{detail}"
    );
}

#[tokio::test]
async fn a_read_back_that_differs_fails_and_the_object_is_still_deleted() {
    let rig = Rig::new(&all()).await;
    let fake = FakeR2::new(
        &[EVIDENCE],
        Faults {
            wrong_content_on_get: true,
            ..Faults::default()
        },
    );
    mount(&rig, fake.clone()).await;
    let outcome = rig.run("r2.evidence").await;
    assert!(fail(&outcome).contains("differs from the one written"));
    assert!(
        fake.objects.lock().unwrap().is_empty(),
        "cleanup runs even when the read-back fails"
    );
}

#[tokio::test]
async fn a_failed_delete_is_reported_with_the_object_left_behind() {
    let rig = Rig::new(&all()).await;
    let fake = FakeR2::new(
        &[EVIDENCE],
        Faults {
            deny_delete: true,
            ..Faults::default()
        },
    );
    mount(&rig, fake.clone()).await;
    let outcome = rig.run("r2.evidence").await;
    assert!(fail(&outcome).contains("left in the bucket"), "{outcome:?}");
    assert_eq!(fake.objects.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn malformed_account_or_bucket_names_fail_before_any_request() {
    let rig = Rig::new(&[
        ("R2_ACCOUNT_ID", "not hex!"),
        ("R2_ACCESS_KEY_ID", KEY_ID),
        ("R2_SECRET_ACCESS_KEY", SECRET),
        ("R2_BUCKET_EVIDENCE", EVIDENCE),
    ])
    .await;
    assert!(fail(&rig.run("r2.evidence").await).contains("R2_ACCOUNT_ID"));

    let rig = Rig::new(&[
        ("R2_ACCOUNT_ID", ACCOUNT),
        ("R2_ACCESS_KEY_ID", KEY_ID),
        ("R2_SECRET_ACCESS_KEY", SECRET),
        ("R2_BUCKET_EVIDENCE", "Bad/Bucket"),
    ])
    .await;
    assert!(fail(&rig.run("r2.evidence").await).contains("R2_BUCKET_EVIDENCE"));
    assert!(rig.server.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn partial_inputs_name_what_is_missing_and_unset_skips_naming_row_6() {
    let rig = Rig::new(&[("R2_ACCOUNT_ID", ACCOUNT), ("R2_BUCKET_BACKUPS", BACKUPS)]).await;
    let outcome = rig.run("r2.backups").await;
    let detail = fail(&outcome);
    assert!(
        detail.contains("incomplete") && detail.contains("R2_ACCESS_KEY_ID"),
        "{detail}"
    );

    let rig = Rig::new(&[]).await;
    assert!(skip_missing(&rig.run("r2.evidence").await).contains("C row 6"));
    assert!(skip_missing(&rig.run("r2.backups").await).contains("C row 6"));
}
