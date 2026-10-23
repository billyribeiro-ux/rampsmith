//! Audit M3 (ADR-283): no sealed storefront-password copy outlives its scan or its installation.
//! The paths: an installation that ends (any code path that marks the shop as not installed), an
//! undo that cancels a verification, and the hourly backstop.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod support;

use db::Db;
use db::repo::scan_secrets::{self, SealedSecret};
use db::repo::{data_fixes, retention, scans, shopify};
use domain::{ScanId, ScanTrigger};
use sqlx::PgPool;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use support::{Graph, app_pool, ctl_pool, owner_pool, seed};
use uuid::Uuid;

fn copy() -> SealedSecret {
    SealedSecret {
        key_id: "scan-1".to_owned(),
        bytes: vec![1, 2, 3, 4],
    }
}

/// A queued scan of the graph's site holding a sealed copy.
async fn scan_with_copy(db: &Db, g: Graph) -> ScanId {
    let mut tx = db.tenant(g.tenant).await.unwrap();
    let scan = scans::create(
        &mut tx,
        &scans::NewScan {
            site_id: g.site,
            trigger: ScanTrigger::Verify,
            ruleset_version: "axe-4.14.0+test".to_owned(),
            theme_ref: None,
        },
    )
    .await
    .unwrap();
    assert!(
        scan_secrets::set_scan_password(&mut tx, scan.id, Some(&copy()))
            .await
            .unwrap()
    );
    tx.commit().await.unwrap();
    scan.id
}

async fn state(owner: &PgPool, scan: ScanId) -> (String, bool, Option<String>) {
    sqlx::query_as(
        "select status, storefront_password_ct is not null, error_code from scans where id = $1",
    )
    .bind(scan.as_uuid())
    .fetch_one(owner)
    .await
    .unwrap()
}

#[sqlx::test(migrations = "./migrations")]
async fn an_installation_that_ends_cancels_its_open_scans_and_clears_their_copies(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let owner = owner_pool(opts.clone(), conn.clone()).await;
    let db = Db::from_pool(app_pool(opts, conn).await);
    let mine = seed(&db, 1).await;
    let other = seed(&db, 2).await;
    let queued = scan_with_copy(&db, mine).await;
    let other_queued = scan_with_copy(&db, other).await;
    // A scan that already ended keeps its status.
    sqlx::query("update scans set status = 'succeeded', finished_at = now() where id = $1")
        .bind(mine.scan.as_uuid())
        .execute(&owner)
        .await
        .unwrap();

    let mut tx = db.tenant(mine.tenant).await.unwrap();
    assert!(shopify::mark_uninstalled(&mut tx, mine.shop).await.unwrap());
    tx.commit().await.unwrap();

    assert_eq!(
        state(&owner, queued).await,
        (
            "cancelled".to_owned(),
            false,
            Some("shop_uninstalled".to_owned())
        )
    );
    assert_eq!(state(&owner, mine.scan).await.0, "succeeded");
    // Another tenant's scan is untouched.
    assert_eq!(
        state(&owner, other_queued).await,
        ("queued".to_owned(), true, None)
    );
}

#[sqlx::test(migrations = "./migrations")]
async fn undoing_a_fix_ends_the_verification_scan_it_cancels_and_clears_the_copy(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let owner = owner_pool(opts.clone(), conn.clone()).await;
    let db = Db::from_pool(app_pool(opts.clone(), conn.clone()).await);
    let g = seed(&db, 1).await;
    let scan = scan_with_copy(&db, g).await;
    // The undo runs in `ctl`, which may cancel jobs.
    let ctl = Db::from_pool(ctl_pool(opts, conn).await);
    for (key, payload) in [
        (
            format!("verify.scan:{}", g.fix),
            serde_json::json!({ "scan_id": scan.as_uuid() }),
        ),
        // A job without a scan id (older payloads, tests) is cancelled and nothing else changes.
        (
            format!("verify.scan:{}", Uuid::now_v7()),
            serde_json::json!({}),
        ),
    ] {
        sqlx::query(
            "insert into jobs (id, queue, payload_schema, payload, tenant_id, state, idempotency_key)
             values ($1, 'verify.scan', 'verify.scan@1', $2, $3, 'ready', $4)",
        )
        .bind(Uuid::now_v7())
        .bind(payload)
        .bind(g.tenant.as_uuid())
        .bind(key)
        .execute(&owner)
        .await
        .unwrap();
    }

    let mut tx = ctl.tenant(g.tenant).await.unwrap();
    assert_eq!(
        data_fixes::cancel_verification(&mut tx, g.fix)
            .await
            .unwrap(),
        1
    );
    tx.commit().await.unwrap();

    assert_eq!(
        state(&owner, scan).await,
        (
            "cancelled".to_owned(),
            false,
            Some("verification_cancelled".to_owned())
        )
    );
    let left: i64 = sqlx::query_scalar("select count(*) from jobs where state = 'ready'")
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(left, 1, "only the other fix's job is still waiting");
}

#[sqlx::test(migrations = "./migrations")]
async fn the_hourly_sweep_clears_old_copies_and_nothing_else(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let owner = owner_pool(opts.clone(), conn.clone()).await;
    let db = Db::from_pool(app_pool(opts.clone(), conn.clone()).await);
    let worker = ctl_pool(opts, conn).await;
    let g = seed(&db, 1).await;
    let old = scan_with_copy(&db, g).await;
    let fresh = scan_with_copy(&db, g).await;
    sqlx::query("update scans set created_at = now() - interval '61 minutes' where id = $1")
        .bind(old.as_uuid())
        .execute(&owner)
        .await
        .unwrap();
    sqlx::query("update scans set created_at = now() - interval '59 minutes' where id = $1")
        .bind(fresh.as_uuid())
        .execute(&owner)
        .await
        .unwrap();

    let swept = Db::from_pool(worker);
    let mut tx = swept.public().await.unwrap();
    assert_eq!(retention::scan_passwords(&mut tx).await.unwrap(), 1);
    tx.commit().await.unwrap();

    // The old copy is gone and its scan keeps its own status; the fresh copy stays.
    assert_eq!(state(&owner, old).await, ("queued".to_owned(), false, None));
    assert_eq!(
        state(&owner, fresh).await,
        ("queued".to_owned(), true, None)
    );
    // Idempotent.
    let mut tx = swept.public().await.unwrap();
    assert_eq!(retention::scan_passwords(&mut tx).await.unwrap(), 0);
    tx.rollback().await.unwrap();
}

#[sqlx::test(migrations = "./migrations")]
async fn the_application_role_cannot_run_the_sweep(opts: PgPoolOptions, conn: PgConnectOptions) {
    let app = app_pool(opts, conn).await;
    let refused = sqlx::query("select scan_passwords_sweep()")
        .execute(&app)
        .await;
    assert!(refused.is_err(), "the application role cleared copies");
}
