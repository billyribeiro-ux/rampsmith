//! R2, three tokens (ADR-254): the engine's writes, reads and deletes in the evidence bucket
//! and is refused on the backups bucket; the backup service's does the full round trip on the
//! backups bucket; the drill's reads there and is refused a write.
//!
//! The fake models R2's answers: 403 `AccessDenied` for a token that does not cover the bucket
//! or the operation (Cloudflare R2 documentation, "Error codes", 10003), 404 `NoSuchBucket`
//! for a bucket the account does not have.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use rsctl::sigv4::PathMode;
use wiremock::matchers::any;
use wiremock::{Mock, Request, Respond, ResponseTemplate};

use crate::support::{AwsExpect, Rig, fail, pass, skip_missing, verify_sigv4, xml};

const ACCOUNT: &str = "0123456789abcdef0123456789abcdef";
const ENGINE_KEY: &str = "test-r2-access-key-id-SECRET-1";
const ENGINE_SECRET: &str = "test-r2-secret-access-key-SECRET-2";
const BACKUP_KEY: &str = "test-r2-backup-key-id-SECRET-3";
const BACKUP_SECRET: &str = "test-r2-backup-secret-key-SECRET-4";
const DRILL_KEY: &str = "test-r2-drill-key-id-SECRET-5";
const DRILL_SECRET: &str = "test-r2-drill-secret-key-SECRET-6";
const EVIDENCE: &str = "rampsmith-evidence";
const BACKUPS: &str = "rampsmith-backups";

fn all() -> Vec<(&'static str, &'static str)> {
    vec![
        ("R2_ACCOUNT_ID", ACCOUNT),
        ("R2_ACCESS_KEY_ID", ENGINE_KEY),
        ("R2_SECRET_ACCESS_KEY", ENGINE_SECRET),
        ("R2_BUCKET_EVIDENCE", EVIDENCE),
        ("R2_BUCKET_BACKUPS", BACKUPS),
        ("BACKUP_R2_ACCESS_KEY_ID", BACKUP_KEY),
        ("BACKUP_R2_SECRET_ACCESS_KEY", BACKUP_SECRET),
        ("DRILL_R2_ACCESS_KEY_ID", DRILL_KEY),
        ("DRILL_R2_SECRET_ACCESS_KEY", DRILL_SECRET),
    ]
}

/// `all()` with one variable replaced.
fn with(name: &str, value: &'static str) -> Vec<(&'static str, &'static str)> {
    all()
        .into_iter()
        .map(|(k, v)| if k == name { (k, value) } else { (k, v) })
        .collect()
}

/// `all()` without some variables.
fn without(names: &[&str]) -> Vec<(&'static str, &'static str)> {
    all()
        .into_iter()
        .filter(|(k, _)| !names.contains(k))
        .collect()
}

/// What one token may do.
#[derive(Clone, Copy)]
struct Grant {
    key: &'static str,
    secret: &'static str,
    buckets: &'static [&'static str],
    write: bool,
}

/// The tokens as the founder is told to create them (`FOUNDER_SETUP` section 10).
const ENGINE: Grant = Grant {
    key: ENGINE_KEY,
    secret: ENGINE_SECRET,
    buckets: &[EVIDENCE],
    write: true,
};
const BACKUP: Grant = Grant {
    key: BACKUP_KEY,
    secret: BACKUP_SECRET,
    buckets: &[BACKUPS],
    write: true,
};
const DRILL: Grant = Grant {
    key: DRILL_KEY,
    secret: DRILL_SECRET,
    buckets: &[BACKUPS],
    write: false,
};

/// One thing that goes wrong at the vendor, for every token.
#[derive(Clone, Copy, Default, PartialEq, Eq)]
enum Fault {
    #[default]
    None,
    DenyPut,
    DenyDelete,
    DenyGet,
    WrongContentOnGet,
}

/// R2's S3 API: verifies `SigV4` (service `s3`, region `auto`, signed content hash) for the
/// token named in the request, applies that token's grant, keeps objects in memory, and
/// answers with S3's XML errors.
#[derive(Clone)]
struct FakeR2 {
    grants: Vec<Grant>,
    buckets: Vec<&'static str>,
    objects: Arc<Mutex<HashMap<String, Vec<u8>>>>,
    log: Arc<Mutex<Vec<String>>>,
    fault: Fault,
}

impl FakeR2 {
    fn new(grants: &[Grant], buckets: &[&'static str], fault: Fault) -> Self {
        Self {
            grants: grants.to_vec(),
            buckets: buckets.to_vec(),
            objects: Arc::default(),
            log: Arc::default(),
            fault,
        }
    }

    /// The grant whose access key signed the request.
    fn grant_for(&self, request: &Request) -> Option<Grant> {
        let authorization = request.headers.get("authorization")?.to_str().ok()?;
        let credential = authorization.split("Credential=").nth(1)?;
        self.grants
            .iter()
            .copied()
            .find(|grant| credential.starts_with(&format!("{}/", grant.key)))
    }
}

impl Respond for FakeR2 {
    fn respond(&self, request: &Request) -> ResponseTemplate {
        let Some(grant) = self.grant_for(request) else {
            return xml(403, "r2/invalid-access-key-id.xml");
        };
        let expect = AwsExpect {
            access_key_id: grant.key,
            secret_access_key: grant.secret,
            region: "auto",
            service: "s3",
            mode: PathMode::S3,
            content_sha256: true,
        };
        if verify_sigv4(request, &expect).is_err() {
            return xml(403, "r2/signature-does-not-match.xml");
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
            .push(format!("{} {path} {}", request.method, grant.key));
        // A token that does not cover the bucket, or the operation, is refused.
        let writes = matches!(request.method.as_str(), "PUT" | "DELETE");
        if !grant.buckets.contains(&bucket) || (writes && !grant.write) {
            return xml(403, "r2/access-denied.xml");
        }
        let mut objects = self.objects.lock().unwrap();
        match request.method.as_str() {
            "PUT" if (self.fault == Fault::DenyPut) => xml(403, "r2/access-denied.xml"),
            "PUT" => {
                objects.insert(path, request.body.clone());
                ResponseTemplate::new(200)
                    .insert_header("etag", "\"d41d8cd98f00b204e9800998ecf8427e\"")
            }
            "GET" if (self.fault == Fault::DenyGet) => xml(403, "r2/access-denied.xml"),
            "GET" => match objects.get(&path) {
                Some(_) if (self.fault == Fault::WrongContentOnGet) => {
                    ResponseTemplate::new(200).set_body_bytes(b"something else".to_vec())
                }
                Some(body) => ResponseTemplate::new(200).set_body_bytes(body.clone()),
                None => ResponseTemplate::new(404),
            },
            "DELETE" if (self.fault == Fault::DenyDelete) => xml(403, "r2/access-denied.xml"),
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

/// Both buckets, the three tokens as the founder creates them.
pub async fn healthy(server: &wiremock::MockServer) {
    let fake = FakeR2::new(&[ENGINE, BACKUP, DRILL], &[EVIDENCE, BACKUPS], Fault::None);
    Mock::given(wiremock::matchers::path_regex(
        "^/rampsmith-(evidence|backups)/",
    ))
    .respond_with(fake)
    .mount(server)
    .await;
}

fn healthy_fake() -> FakeR2 {
    FakeR2::new(&[ENGINE, BACKUP, DRILL], &[EVIDENCE, BACKUPS], Fault::None)
}

#[tokio::test]
async fn each_token_writes_reads_and_deletes_a_signed_probe_object_in_its_bucket() {
    let rig = Rig::new(&all()).await;
    let fake = healthy_fake();
    mount(&rig, fake.clone()).await;

    let evidence = rig.run("r2.evidence").await;
    let backups = rig.run("r2.backup-token").await;
    assert!(
        pass(&evidence).contains(&format!("`{EVIDENCE}`")),
        "{evidence:?}"
    );
    assert!(
        pass(&backups).contains(&format!("`{BACKUPS}`")),
        "{backups:?}"
    );
    for secret in [ENGINE_KEY, ENGINE_SECRET, BACKUP_KEY, BACKUP_SECRET] {
        assert!(!pass(&evidence).contains(secret) && !pass(&backups).contains(secret));
    }

    // Nothing is left behind, and each bucket saw exactly PUT, GET, DELETE of one object, from
    // the token that belongs to it.
    assert!(
        fake.objects.lock().unwrap().is_empty(),
        "the probe object was deleted"
    );
    let log = fake.log.lock().unwrap().clone();
    assert_eq!(log.len(), 6, "{log:?}");
    for (bucket, key) in [(EVIDENCE, ENGINE_KEY), (BACKUPS, BACKUP_KEY)] {
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
        assert!(mine.iter().all(|line| line.ends_with(key)), "{mine:?}");
        assert!(
            mine[0].contains("/rsctl-doctor/20261019T120000Z-000000000.txt"),
            "{mine:?}"
        );
    }
}

#[tokio::test]
async fn the_engines_token_is_refused_on_the_backups_bucket_and_that_is_a_pass() {
    let rig = Rig::new(&all()).await;
    let fake = healthy_fake();
    mount(&rig, fake.clone()).await;
    let outcome = rig.run("r2.engine-not-backups").await;
    let detail = pass(&outcome);
    assert!(
        detail.contains("R2_ACCESS_KEY_ID is refused")
            && detail.contains(&format!("`{BACKUPS}`"))
            && detail.contains("AccessDenied"),
        "{detail}"
    );
    // One write and one read, both from the engine's key, both refused: nothing was stored.
    let log = fake.log.lock().unwrap().clone();
    assert_eq!(log.len(), 2, "{log:?}");
    assert!(
        log[0].starts_with("PUT ") && log[1].starts_with("GET "),
        "{log:?}"
    );
    assert!(log.iter().all(|line| line.ends_with(ENGINE_KEY)), "{log:?}");
    assert!(fake.objects.lock().unwrap().is_empty());
    assert!(!detail.contains(ENGINE_KEY) && !detail.contains(ENGINE_SECRET));
}

#[tokio::test]
async fn an_engine_token_that_covers_the_backups_bucket_fails_and_the_probe_is_deleted() {
    let rig = Rig::new(&all()).await;
    let too_wide = Grant {
        buckets: &[EVIDENCE, BACKUPS],
        ..ENGINE
    };
    let fake = FakeR2::new(
        &[too_wide, BACKUP, DRILL],
        &[EVIDENCE, BACKUPS],
        Fault::None,
    );
    mount(&rig, fake.clone()).await;
    let outcome = rig.run("r2.engine-not-backups").await;
    let detail = fail(&outcome);
    assert!(
        detail.contains("R2_ACCESS_KEY_ID can write to the backups bucket")
            && detail.contains("evidence bucket only"),
        "{detail}"
    );
    assert!(
        fake.objects.lock().unwrap().is_empty(),
        "the object the too-wide token wrote was deleted"
    );
}

#[tokio::test]
async fn an_engine_token_that_can_only_read_the_backups_bucket_still_fails() {
    let rig = Rig::new(&all()).await;
    // Object Read on both buckets: writes refused on the backups bucket, reads allowed.
    let fake = FakeR2::new(
        &[
            Grant {
                buckets: &[EVIDENCE, BACKUPS],
                write: false,
                ..ENGINE
            },
            BACKUP,
            DRILL,
        ],
        &[EVIDENCE, BACKUPS],
        Fault::None,
    );
    mount(&rig, fake).await;
    let outcome = rig.run("r2.engine-not-backups").await;
    assert!(
        fail(&outcome).contains("can read the backups bucket"),
        "{outcome:?}"
    );
}

#[tokio::test]
async fn an_unknown_engine_key_is_not_a_refusal() {
    // A key R2 does not know proves nothing about scope, so the negative check fails.
    let rig = Rig::new(&with("R2_ACCESS_KEY_ID", "some-other-key-id-SECRET-8")).await;
    mount(&rig, healthy_fake()).await;
    let detail_outcome = rig.run("r2.engine-not-backups").await;
    let detail = fail(&detail_outcome);
    assert!(
        detail.contains("InvalidAccessKeyId") && detail.contains("R2_ACCESS_KEY_ID"),
        "{detail}"
    );
}

#[tokio::test]
async fn a_missing_backups_bucket_is_not_a_refusal_either() {
    let rig = Rig::new(&all()).await;
    mount(
        &rig,
        FakeR2::new(&[ENGINE, BACKUP, DRILL], &[EVIDENCE], Fault::None),
    )
    .await;
    assert!(fail(&rig.run("r2.engine-not-backups").await).contains("NoSuchBucket"));
}

#[tokio::test]
async fn the_drill_token_reads_and_is_refused_a_write() {
    let rig = Rig::new(&all()).await;
    let fake = healthy_fake();
    mount(&rig, fake.clone()).await;
    let outcome = rig.run("r2.drill-token").await;
    let detail = pass(&outcome);
    assert!(
        detail.contains(&format!("`{BACKUPS}`")) && detail.contains("refused a write"),
        "{detail}"
    );
    let log = fake.log.lock().unwrap().clone();
    assert_eq!(log.len(), 2, "{log:?}");
    assert!(
        log[0].starts_with("GET ") && log[1].starts_with("PUT "),
        "{log:?}"
    );
    assert!(log.iter().all(|line| line.ends_with(DRILL_KEY)), "{log:?}");
    assert!(fake.objects.lock().unwrap().is_empty());
    assert!(!detail.contains(DRILL_KEY) && !detail.contains(DRILL_SECRET));
}

#[tokio::test]
async fn a_drill_token_that_can_write_fails_and_the_probe_is_deleted() {
    let rig = Rig::new(&all()).await;
    let writable = Grant {
        write: true,
        ..DRILL
    };
    let fake = FakeR2::new(
        &[ENGINE, BACKUP, writable],
        &[EVIDENCE, BACKUPS],
        Fault::None,
    );
    mount(&rig, fake.clone()).await;
    let outcome = rig.run("r2.drill-token").await;
    assert!(
        fail(&outcome).contains("must be Object Read only"),
        "{outcome:?}"
    );
    assert!(fake.objects.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_drill_token_without_read_fails_at_the_read() {
    let rig = Rig::new(&all()).await;
    let fake = FakeR2::new(
        &[ENGINE, BACKUP, DRILL],
        &[EVIDENCE, BACKUPS],
        Fault::DenyGet,
    );
    mount(&rig, fake).await;
    let outcome = rig.run("r2.drill-token").await;
    let detail = fail(&outcome);
    assert!(
        detail.contains("reading from the bucket") && detail.contains("AccessDenied"),
        "{detail}"
    );
}

#[tokio::test]
async fn the_drill_token_on_another_bucket_than_the_backups_fails() {
    // A drill token scoped to the evidence bucket (a mix-up) is refused on the backups bucket
    // even for the read: the drill could not restore anything.
    let rig = Rig::new(&all()).await;
    let misplaced = Grant {
        buckets: &[EVIDENCE],
        ..DRILL
    };
    mount(
        &rig,
        FakeR2::new(
            &[ENGINE, BACKUP, misplaced],
            &[EVIDENCE, BACKUPS],
            Fault::None,
        ),
    )
    .await;
    assert!(fail(&rig.run("r2.drill-token").await).contains("reading from the bucket"));
}

#[tokio::test]
async fn the_backup_token_cannot_stand_in_for_the_engines_or_the_other_way_round() {
    // Each check uses only its own pair: swap the pairs and both fail on scope.
    let mut swapped = without(&[
        "R2_ACCESS_KEY_ID",
        "R2_SECRET_ACCESS_KEY",
        "BACKUP_R2_ACCESS_KEY_ID",
        "BACKUP_R2_SECRET_ACCESS_KEY",
    ]);
    swapped.extend([
        ("R2_ACCESS_KEY_ID", BACKUP_KEY),
        ("R2_SECRET_ACCESS_KEY", BACKUP_SECRET),
        ("BACKUP_R2_ACCESS_KEY_ID", ENGINE_KEY),
        ("BACKUP_R2_SECRET_ACCESS_KEY", ENGINE_SECRET),
    ]);
    let rig = Rig::new(&swapped).await;
    mount(&rig, healthy_fake()).await;
    assert!(fail(&rig.run("r2.evidence").await).contains("AccessDenied"));
    assert!(fail(&rig.run("r2.backup-token").await).contains("AccessDenied"));
}

#[tokio::test]
async fn with_only_the_engines_token_set_the_backup_checks_skip_and_send_nothing() {
    // No fallback to the engine's token: the backup and drill checks need their own variables.
    let rig = Rig::new(&without(&[
        "BACKUP_R2_ACCESS_KEY_ID",
        "BACKUP_R2_SECRET_ACCESS_KEY",
        "DRILL_R2_ACCESS_KEY_ID",
        "DRILL_R2_SECRET_ACCESS_KEY",
    ]))
    .await;
    mount(&rig, healthy_fake()).await;
    for id in ["r2.backup-token", "r2.drill-token"] {
        let outcome = rig.run(id).await;
        assert!(
            skip_missing(&outcome).contains("C row 16"),
            "{id}: {outcome:?}"
        );
    }
    assert!(rig.server.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn a_wrong_secret_fails_with_s3s_code_naming_the_tokens_own_variable() {
    for (id, secret_var, key_var) in [
        ("r2.evidence", "R2_SECRET_ACCESS_KEY", "R2_ACCESS_KEY_ID"),
        (
            "r2.backup-token",
            "BACKUP_R2_SECRET_ACCESS_KEY",
            "BACKUP_R2_ACCESS_KEY_ID",
        ),
    ] {
        let rig = Rig::new(&with(secret_var, "a-different-secret-SECRET-9")).await;
        mount(&rig, healthy_fake()).await;
        let outcome = rig.run(id).await;
        let detail = fail(&outcome);
        assert!(
            detail.contains("SignatureDoesNotMatch") && detail.contains(secret_var),
            "{id}: {detail}"
        );
        assert!(!detail.contains("a-different-secret"), "{detail}");
        assert!(
            !detail.contains("we calculated"),
            "vendor text is not printed: {detail}"
        );

        let rig = Rig::new(&with(key_var, "some-other-key-id-SECRET-8")).await;
        mount(&rig, healthy_fake()).await;
        let detail_outcome = rig.run(id).await;
        let detail = fail(&detail_outcome);
        assert!(
            detail.contains("InvalidAccessKeyId") && detail.contains(key_var),
            "{id}: {detail}"
        );
    }
}

#[tokio::test]
async fn a_bucket_the_account_does_not_have_fails() {
    let rig = Rig::new(&all()).await;
    mount(
        &rig,
        FakeR2::new(&[ENGINE, BACKUP, DRILL], &[EVIDENCE], Fault::None),
    )
    .await;
    let outcome = rig.run("r2.backup-token").await;
    assert!(fail(&outcome).contains("NoSuchBucket"), "{outcome:?}");
}

#[tokio::test]
async fn a_token_without_write_permission_fails_at_the_write() {
    let rig = Rig::new(&all()).await;
    mount(
        &rig,
        FakeR2::new(
            &[ENGINE, BACKUP, DRILL],
            &[EVIDENCE, BACKUPS],
            Fault::DenyPut,
        ),
    )
    .await;
    let outcome = rig.run("r2.evidence").await;
    let detail = fail(&outcome);
    assert!(
        detail.contains("writing the probe object") && detail.contains("AccessDenied"),
        "{detail}"
    );
    // The backup service given the drill's read-only token fails the same way.
    let vars: Vec<_> = all()
        .into_iter()
        .map(|(k, v)| match k {
            "BACKUP_R2_ACCESS_KEY_ID" => (k, DRILL_KEY),
            "BACKUP_R2_SECRET_ACCESS_KEY" => (k, DRILL_SECRET),
            _ => (k, v),
        })
        .collect();
    let rig = Rig::new(&vars).await;
    mount(&rig, healthy_fake()).await;
    let outcome = rig.run("r2.backup-token").await;
    assert!(
        fail(&outcome).contains("writing the probe object")
            && fail(&outcome).contains("AccessDenied"),
        "{outcome:?}"
    );
}

#[tokio::test]
async fn a_read_back_that_differs_fails_and_the_object_is_still_deleted() {
    let rig = Rig::new(&all()).await;
    let fake = FakeR2::new(
        &[ENGINE, BACKUP, DRILL],
        &[EVIDENCE, BACKUPS],
        Fault::WrongContentOnGet,
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
        &[ENGINE, BACKUP, DRILL],
        &[EVIDENCE, BACKUPS],
        Fault::DenyDelete,
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
        ("R2_ACCESS_KEY_ID", ENGINE_KEY),
        ("R2_SECRET_ACCESS_KEY", ENGINE_SECRET),
        ("R2_BUCKET_EVIDENCE", EVIDENCE),
    ])
    .await;
    assert!(fail(&rig.run("r2.evidence").await).contains("R2_ACCOUNT_ID"));

    let rig = Rig::new(&[
        ("R2_ACCOUNT_ID", ACCOUNT),
        ("R2_ACCESS_KEY_ID", ENGINE_KEY),
        ("R2_SECRET_ACCESS_KEY", ENGINE_SECRET),
        ("R2_BUCKET_EVIDENCE", "Bad/Bucket"),
    ])
    .await;
    assert!(fail(&rig.run("r2.evidence").await).contains("R2_BUCKET_EVIDENCE"));

    let rig = Rig::new(&with("R2_BUCKET_BACKUPS", "Bad/Bucket")).await;
    for id in ["r2.backup-token", "r2.drill-token", "r2.engine-not-backups"] {
        assert!(
            fail(&rig.run(id).await).contains("R2_BUCKET_BACKUPS"),
            "{id}"
        );
    }
    assert!(rig.server.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn partial_inputs_name_what_is_missing_and_unset_skips_naming_the_row() {
    let rig = Rig::new(&[("R2_ACCOUNT_ID", ACCOUNT), ("R2_BUCKET_BACKUPS", BACKUPS)]).await;
    let outcome = rig.run("r2.engine-not-backups").await;
    let detail = fail(&outcome);
    assert!(
        detail.contains("incomplete") && detail.contains("R2_ACCESS_KEY_ID"),
        "{detail}"
    );
    // Half of row 16's own pair set: incomplete, naming the other half.
    let rig = Rig::new(&without(&["BACKUP_R2_SECRET_ACCESS_KEY"])).await;
    let outcome = rig.run("r2.backup-token").await;
    let detail = fail(&outcome);
    assert!(
        detail.contains("incomplete")
            && detail.contains("BACKUP_R2_SECRET_ACCESS_KEY")
            && detail.contains("C row 16"),
        "{detail}"
    );

    let rig = Rig::new(&[]).await;
    assert!(skip_missing(&rig.run("r2.evidence").await).contains("C row 6"));
    assert!(skip_missing(&rig.run("r2.engine-not-backups").await).contains("C row 6"));
    assert!(skip_missing(&rig.run("r2.backup-token").await).contains("C row 16"));
    assert!(skip_missing(&rig.run("r2.drill-token").await).contains("C row 16"));
}

#[tokio::test]
async fn strict_never_asks_the_engines_token_to_reach_the_backups_bucket() {
    // Every required input present, the engine's token covering the evidence bucket only (the
    // way it must be): the whole R2 set passes under --strict. The only request the engine's
    // token makes to the backups bucket is the one that must be refused.
    let mut rig = Rig::new(&all()).await;
    rig.options.rows = vec![6, 16];
    let fake = healthy_fake();
    mount(&rig, fake.clone()).await;
    let (report, _) = rig.report().await;
    let r2: Vec<_> = report
        .findings
        .iter()
        .filter(|f| f.id.starts_with("r2."))
        .collect();
    assert_eq!(r2.len(), 4, "{report:?}");
    for finding in &r2 {
        assert!(
            matches!(finding.outcome, rsctl::report::Outcome::Pass(_)),
            "{}: {:?}",
            finding.id,
            finding.outcome
        );
    }
    let log = fake.log.lock().unwrap().clone();
    let engine_on_backups: Vec<&String> = log
        .iter()
        .filter(|line| line.contains(&format!("/{BACKUPS}/")) && line.ends_with(ENGINE_KEY))
        .collect();
    assert_eq!(
        engine_on_backups.len(),
        2,
        "only the PUT and the GET of the negative check: {log:?}"
    );
}
