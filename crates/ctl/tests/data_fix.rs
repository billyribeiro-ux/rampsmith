//! `shopify.apply_data_fix@1` and `shopify.revert_data_fix@1` (ADR-082) against PostgreSQL and a
//! mock Admin API: the snapshot, the conflict check, the audit trail and the one-click undo.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use contracts::{ShopifyApplyDataFix, ShopifyRevertDataFix};
use crypto::KeyRing;
use ctl::jobs::scan_secret::{ScanSecrets, scan_context};
use queue::Failure;
use secrecy::ExposeSecret;
use serde_json::{Value, json};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use uuid::Uuid;
use wiremock::matchers::{body_partial_json, method};
use wiremock::{Mock, ResponseTemplate};

mod support;

use support::world::{World, world};

const MEDIA: &str = "gid://shopify/MediaImage/11";
const PRODUCT: &str = "gid://shopify/Product/1";

fn fixture(name: &str) -> Value {
    let path = format!(
        "{}/../shopify-admin/tests/fixtures/{name}.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn media_node(alt: Option<&str>, status: &str) -> Value {
    json!({"data": {"node": {"__typename": "MediaImage", "id": MEDIA, "alt": alt, "status": status}}})
}

/// The Admin API answers `operation` with `body`, once.
async fn answer_once(w: &World, operation: &str, body: Value) {
    Mock::given(method("POST"))
        .and(body_partial_json(json!({ "operationName": operation })))
        .respond_with(ResponseTemplate::new(200).set_body_json(body))
        .up_to_n_times(1)
        .mount(&w.admin)
        .await;
}

struct Seeded {
    fix: Uuid,
    finding: Uuid,
}

/// A data fix for the alt text of `MEDIA`, finding included.
async fn seed(
    w: &World,
    status: &str,
    approved: bool,
    before: Option<&str>,
    after: &str,
) -> Seeded {
    let tenant = w.session.tenant.as_uuid();
    let site = w.site().await;
    let scan = w.scan().await;
    let (finding, fix) = (Uuid::now_v7(), Uuid::now_v7());
    let finding_status = if status == "applied" { "fixed" } else { "open" };
    let diff = json!({"type": "alt_text", "resource_gid": MEDIA, "field": "alt",
                      "before": before, "after": after});
    let location = json!({"resource": MEDIA, "field": "alt", "owner": PRODUCT});
    sqlx::query(
        "insert into findings (id, tenant_id, site_id, fingerprint, rule_id, criteria, impact,
                               status, source_location, first_seen_scan, last_seen_scan,
                               occurrence_count)
         values ($1, $2, $3, $4, 'rs-media-alt-empty', '{1.1.1}', 'serious', $5, $6, $7, $7, 1)",
    )
    .bind(finding)
    .bind(tenant)
    .bind(site)
    .bind(finding.as_bytes().repeat(2))
    .bind(finding_status)
    .bind(&location)
    .bind(scan)
    .execute(&w.owner)
    .await
    .unwrap();
    sqlx::query(
        "insert into fixes (id, tenant_id, site_id, kind, channel, status, origin, diff,
                            approved_by_ref, approved_at, applied_at)
         values ($1, $2, $3, 'data', 'admin_api', $4, 'rule', $5,
                 case when $6 then '4242' end, case when $6 then now() end,
                 case when $4 in ('applied', 'verified') then now() end)",
    )
    .bind(fix)
    .bind(tenant)
    .bind(site)
    .bind(status)
    .bind(&diff)
    .bind(approved)
    .execute(&w.owner)
    .await
    .unwrap();
    sqlx::query("insert into fix_findings (fix_id, finding_id, tenant_id) values ($1, $2, $3)")
        .bind(fix)
        .bind(finding)
        .bind(tenant)
        .execute(&w.owner)
        .await
        .unwrap();
    sqlx::query(
        "insert into data_fix_snapshots (fix_id, tenant_id, resource_gid, field, before_value,
                                         after_value)
         values ($1, $2, $3, 'alt', $4, $5)",
    )
    .bind(fix)
    .bind(tenant)
    .bind(MEDIA)
    .bind(json!(before))
    .bind(json!(after))
    .execute(&w.owner)
    .await
    .unwrap();
    Seeded { fix, finding }
}

async fn apply(w: &World, fix: Uuid) -> Result<(), Failure> {
    w.jobs
        .dispatch(w.job(
            ShopifyApplyDataFix::QUEUE,
            ShopifyApplyDataFix::SCHEMA,
            json!({"fix_id": fix, "shop_id": w.session.shop_id.as_uuid()}),
        ))
        .await
}

async fn revert(w: &World, fix: Uuid) -> Result<(), Failure> {
    w.jobs
        .dispatch(w.job(
            ShopifyRevertDataFix::QUEUE,
            ShopifyRevertDataFix::SCHEMA,
            json!({"fix_id": fix, "shop_id": w.session.shop_id.as_uuid()}),
        ))
        .await
}

async fn state(w: &World, fix: Uuid) -> (String, Option<String>) {
    sqlx::query_as("select status, error_code from fixes where id = $1")
        .bind(fix)
        .fetch_one(&w.owner)
        .await
        .unwrap()
}

async fn operations(w: &World) -> Vec<String> {
    w.admin
        .received_requests()
        .await
        .unwrap()
        .iter()
        .filter_map(|r| {
            let body: Value = serde_json::from_slice(&r.body).ok()?;
            body["operationName"].as_str().map(str::to_owned)
        })
        .collect()
}

fn code(result: Result<(), Failure>) -> (bool, String) {
    match result {
        Err(Failure::Permanent(e)) => (false, e.code),
        Err(Failure::Retryable(e)) => (true, e.code),
        Ok(()) => panic!("expected a failure"),
    }
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn an_approved_fix_is_written_verified_and_logged_with_who_approved_it(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let w = world(opts, conn).await;
    let s = seed(&w, "approved", true, None, "A snow globe on a table").await;
    answer_once(&w, "RampsmithNodeValue", media_node(None, "READY")).await;
    w.admin_operation("RampsmithSetMediaAlt", fixture("file_update_ok"))
        .await;
    w.admin_operation("RampsmithOwner", fixture("owner_product"))
        .await;

    apply(&w, s.fix).await.unwrap();

    assert_eq!(state(&w, s.fix).await, ("applied".to_owned(), None));
    assert_eq!(
        operations(&w).await,
        [
            "RampsmithNodeValue",
            "RampsmithSetMediaAlt",
            "RampsmithOwner"
        ],
        "read, write, read again"
    );
    let applied: bool =
        sqlx::query_scalar("select applied_at is not null from fixes where id = $1")
            .bind(s.fix)
            .fetch_one(&w.owner)
            .await
            .unwrap();
    assert!(applied);
    // The audit entry says who approved and when, and holds no store content.
    let audit: Value = sqlx::query_scalar(
        "select data from audit_log where action = 'shopify.data_fix_applied' and subject_id = $1",
    )
    .bind(s.fix)
    .fetch_one(&w.owner)
    .await
    .unwrap();
    assert_eq!(audit["approved_by_ref"], "4242");
    assert!(audit["approved_at"].as_str().is_some());
    assert_eq!(audit["resource"], MEDIA);
    assert!(!audit.to_string().contains("snow globe"));
    // A verification scan, the re-read product and the job that checks them.
    let (scan, input): (Uuid, Value) = sqlx::query_as(
        "select s.id, i.payload from scans s join scan_inputs i on i.scan_id = s.id
          where s.trigger = 'verify' and i.kind = 'verify'",
    )
    .fetch_one(&w.owner)
    .await
    .unwrap();
    assert_eq!(input["kind"], "products");
    let planned: i32 = sqlx::query_scalar("select pages_planned from scans where id = $1")
        .bind(scan)
        .fetch_one(&w.owner)
        .await
        .unwrap();
    assert_eq!(planned, 1, "pages_planned is the URL count");
    assert_eq!(input["items"][0]["id"], PRODUCT);
    let job: Value = sqlx::query_scalar("select payload from jobs where queue = 'verify.scan'")
        .fetch_one(&w.owner)
        .await
        .unwrap();
    assert_eq!(job["scan_id"], scan.to_string());
    assert_eq!(job["fix_id"], s.fix.to_string());
    assert!(job["input_id"].is_string());
    assert!(
        job["urls"][0]
            .as_str()
            .unwrap()
            .ends_with("/products/snow-globe")
    );

    // Running the job again changes and asks for nothing.
    let before = operations(&w).await.len();
    apply(&w, s.fix).await.unwrap();
    assert_eq!(operations(&w).await.len(), before);
    assert_eq!(
        w.count("select count(*) from jobs where queue = 'verify.scan'")
            .await,
        1
    );
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn the_verification_scan_of_a_protected_store_gets_the_password_too(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let w = world(opts, conn).await;
    let master = KeyRing::parse("k1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8").unwrap();
    let scan_ring = KeyRing::parse("scan1:Hx4dHBsaGRgXFhUUExIREA8ODQwLCgkIBwYFBAMCAQA").unwrap();
    let site = w.site().await;
    let sealed = master
        .seal(
            b"open-sesame, 12!",
            format!("sites/storefront_password/{site}").as_bytes(),
        )
        .unwrap();
    let (key_id, bytes) = sealed.into_parts();
    sqlx::query(
        "update sites set storefront_password_ct = $1, storefront_password_key_id = $2 where id = $3",
    )
    .bind(bytes)
    .bind(key_id.as_str())
    .bind(site)
    .execute(&w.owner)
    .await
    .unwrap();
    let s = seed(&w, "approved", true, None, "A snow globe on a table").await;
    answer_once(&w, "RampsmithNodeValue", media_node(None, "READY")).await;
    w.admin_operation("RampsmithSetMediaAlt", fixture("file_update_ok"))
        .await;
    w.admin_operation("RampsmithOwner", fixture("owner_product"))
        .await;
    let armed = w
        .jobs
        .clone()
        .with_scan_secrets(ScanSecrets::new(master, scan_ring.clone()));
    armed
        .dispatch(w.job(
            ShopifyApplyDataFix::QUEUE,
            ShopifyApplyDataFix::SCHEMA,
            json!({"fix_id": s.fix, "shop_id": w.session.shop_id.as_uuid()}),
        ))
        .await
        .unwrap();
    let (scan, ct, key): (Uuid, Option<Vec<u8>>, Option<String>) = sqlx::query_as(
        "select id, storefront_password_ct, storefront_password_key_id from scans
          where trigger = 'verify'",
    )
    .fetch_one(&w.owner)
    .await
    .unwrap();
    let opened = scan_ring
        .open_string(
            &key.unwrap(),
            &ct.unwrap(),
            &scan_context(domain::ScanId::from_uuid(scan)),
        )
        .unwrap();
    assert_eq!(opened.expose_secret(), "open-sesame, 12!");
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn a_value_the_merchant_changed_is_never_overwritten(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let w = world(opts, conn).await;
    let s = seed(&w, "approved", true, None, "Draft alt text").await;
    answer_once(
        &w,
        "RampsmithNodeValue",
        media_node(Some("Written by the merchant"), "READY"),
    )
    .await;

    assert_eq!(
        code(apply(&w, s.fix).await),
        (false, "conflict_value_changed".to_owned())
    );

    assert_eq!(
        state(&w, s.fix).await,
        (
            "failed".to_owned(),
            Some("conflict_value_changed".to_owned())
        )
    );
    assert_eq!(
        operations(&w).await,
        ["RampsmithNodeValue"],
        "nothing was written"
    );
    assert_eq!(
        w.count("select count(*) from jobs where queue = 'verify.scan'")
            .await,
        0
    );
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn a_fix_nobody_approved_is_refused_before_shopify_is_asked(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let w = world(opts, conn).await;
    // Status says approved, the approval record is missing: it must still not be written.
    let unapproved = seed(&w, "approved", false, None, "x").await;
    assert_eq!(
        code(apply(&w, unapproved.fix).await),
        (false, "fix_unapproved".to_owned())
    );
    assert_eq!(state(&w, unapproved.fix).await.0, "failed");
    // A fix that is only proposed is not approved.
    let proposed = seed(&w, "proposed", false, None, "y").await;
    assert_eq!(
        code(apply(&w, proposed.fix).await),
        (false, "fix_not_approved".to_owned())
    );
    assert_eq!(state(&w, proposed.fix).await.0, "proposed");
    assert!(
        operations(&w).await.is_empty(),
        "nothing may reach Shopify for an unapproved fix"
    );
    // A fix id that is not this tenant's.
    assert_eq!(
        code(apply(&w, Uuid::now_v7()).await),
        (false, "fix_not_found".to_owned())
    );
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn a_crash_after_the_write_resumes_without_writing_twice(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let w = world(opts, conn).await;
    let s = seed(&w, "applying", true, None, "Resumed").await;
    answer_once(
        &w,
        "RampsmithNodeValue",
        media_node(Some("Resumed"), "READY"),
    )
    .await;
    w.admin_operation("RampsmithOwner", fixture("owner_product"))
        .await;

    apply(&w, s.fix).await.unwrap();

    assert_eq!(state(&w, s.fix).await.0, "applied");
    assert_eq!(
        operations(&w).await,
        ["RampsmithNodeValue", "RampsmithOwner"]
    );
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn shopify_refusals_fail_the_fix_and_outages_and_busy_media_retry(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let w = world(opts, conn).await;
    // userErrors: the fix fails for good, with a code.
    let rejected = seed(&w, "approved", true, None, "Rejected text").await;
    answer_once(&w, "RampsmithNodeValue", media_node(None, "READY")).await;
    w.admin_operation("RampsmithSetMediaAlt", fixture("file_update_user_error"))
        .await;
    assert_eq!(
        code(apply(&w, rejected.fix).await),
        (false, "shopify_rejected".to_owned())
    );
    assert_eq!(state(&w, rejected.fix).await.0, "failed");

    // An image Shopify is still processing: retry, and stay `applying`.
    let busy = seed(&w, "approved", true, None, "Busy text").await;
    answer_once(&w, "RampsmithNodeValue", media_node(None, "PROCESSING")).await;
    assert_eq!(
        code(apply(&w, busy.fix).await),
        (true, "media_not_ready".to_owned())
    );
    assert_eq!(state(&w, busy.fix).await.0, "applying");
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn an_applied_fix_is_undone_when_the_live_value_is_still_the_fixes(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let w = world(opts, conn).await;
    let s = seed(&w, "applied", true, None, "Fix text").await;
    answer_once(
        &w,
        "RampsmithNodeValue",
        media_node(Some("Fix text"), "READY"),
    )
    .await;
    w.admin_operation("RampsmithSetMediaAlt", fixture("file_update_ok"))
        .await;
    // The verification queued by the apply has not run yet.
    sqlx::query(
        "insert into jobs (id, queue, payload_schema, payload, tenant_id, state, idempotency_key)
         values ($1, 'verify.scan', 'verify.scan@1', '{}', $2, 'ready', $3)",
    )
    .bind(Uuid::now_v7())
    .bind(w.session.tenant.as_uuid())
    .bind(format!("verify.scan:{}", s.fix))
    .execute(&w.owner)
    .await
    .unwrap();

    revert(&w, s.fix).await.unwrap();

    assert_eq!(state(&w, s.fix).await, ("reverted".to_owned(), None));
    assert_eq!(
        w.count("select count(*) from jobs where queue = 'verify.scan' and state = 'cancelled'")
            .await,
        1,
        "the pending verification of an undone fix is cancelled"
    );
    let reverted: bool =
        sqlx::query_scalar("select reverted_at is not null from fixes where id = $1")
            .bind(s.fix)
            .fetch_one(&w.owner)
            .await
            .unwrap();
    assert!(reverted);
    let finding: String = sqlx::query_scalar("select status from findings where id = $1")
        .bind(s.finding)
        .fetch_one(&w.owner)
        .await
        .unwrap();
    assert_eq!(
        finding, "open",
        "the finding the fix had closed is open again"
    );
    // The empty string is what restores an unset alt text.
    let write = w
        .admin
        .received_requests()
        .await
        .unwrap()
        .into_iter()
        .find_map(|r| {
            let body: Value = serde_json::from_slice(&r.body).ok()?;
            (body["operationName"] == "RampsmithSetMediaAlt").then_some(body)
        })
        .unwrap();
    assert_eq!(write["variables"]["files"][0]["alt"], "");
    assert_eq!(
        w.count("select count(*) from audit_log where action = 'shopify.data_fix_reverted'")
            .await,
        1
    );
    // Undoing twice is harmless.
    revert(&w, s.fix).await.unwrap();
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn an_undo_refuses_with_a_conflict_when_the_value_changed_since(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let w = world(opts, conn).await;
    let s = seed(&w, "verified", true, Some("Original"), "Fix text").await;
    answer_once(
        &w,
        "RampsmithNodeValue",
        media_node(Some("Edited later by the merchant"), "READY"),
    )
    .await;

    assert_eq!(
        code(revert(&w, s.fix).await),
        (false, "conflict_live_value_changed".to_owned())
    );

    assert_eq!(
        state(&w, s.fix).await.0,
        "verified",
        "the fix is still applied"
    );
    assert_eq!(
        operations(&w).await,
        ["RampsmithNodeValue"],
        "nothing was written"
    );
    assert_eq!(
        w.count("select count(*) from audit_log where action = 'shopify.data_fix_revert_refused'")
            .await,
        1
    );
    // A fix that was never applied cannot be undone.
    let proposed = seed(&w, "proposed", false, None, "z").await;
    assert_eq!(
        code(revert(&w, proposed.fix).await),
        (false, "fix_not_applied".to_owned())
    );
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn the_last_attempt_records_a_failure_instead_of_leaving_the_fix_applying(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let w = world(opts, conn).await;
    let s = seed(&w, "approved", true, None, "Draft alt text").await;
    w.admin_answers(503, json!({})).await;

    // An early attempt retries and leaves the fix where it is.
    assert_eq!(
        code(apply(&w, s.fix).await),
        (true, "shopify_unavailable".to_owned())
    );
    assert_eq!(state(&w, s.fix).await.0, "applying");

    // The last attempt gives up: the fix is failed with a code, the job fails for good.
    let mut last = w.job(
        ShopifyApplyDataFix::QUEUE,
        ShopifyApplyDataFix::SCHEMA,
        json!({"fix_id": s.fix, "shop_id": w.session.shop_id.as_uuid()}),
    );
    last.lease.attempt = last.max_attempts;
    assert_eq!(
        code(w.jobs.dispatch(last).await),
        (false, "retries_exhausted".to_owned())
    );
    assert_eq!(
        state(&w, s.fix).await,
        ("failed".to_owned(), Some("retries_exhausted".to_owned()))
    );
    assert_eq!(
        w.count(
            "select count(*) from audit_log where action = 'shopify.data_fix_failed'
                and data ->> 'code' = 'retries_exhausted'"
        )
        .await,
        1
    );
}
