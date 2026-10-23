//! The app's view of regression records (ADR-310, ADR-311): newest first, only those that found
//! something, a banner that expires and can be dismissed, and nothing across the tenant boundary.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod support;

use db::repo::regressions;
use sqlx::PgPool;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use support::{Graph, app_pool, owner_pool, seed};
use uuid::Uuid;

/// Adds a record for a new scan of the graph's site, `age_days` old.
async fn record(owner: &PgPool, graph: Graph, new: i32, again: i32, age_days: i32) -> Uuid {
    let scan = Uuid::now_v7();
    sqlx::query(
        "insert into scans (id, tenant_id, site_id, trigger, status, ruleset_version)
         values ($1, $2, $3, 'scheduled', 'succeeded', 'axe')",
    )
    .bind(scan)
    .bind(graph.tenant.as_uuid())
    .bind(graph.site.as_uuid())
    .execute(owner)
    .await
    .unwrap();
    let id = Uuid::now_v7();
    sqlx::query(
        "insert into regressions (id, tenant_id, site_id, scan_id, previous_scan_id, new_count,
                                  reappeared_count, findings_seen, pass_rate, items, alert_state,
                                  detected_at)
         values ($1, $2, $3, $4, $5, $6, $7, 3, 91.5, '[]', 'queued',
                 now() - make_interval(days => $8))",
    )
    .bind(id)
    .bind(graph.tenant.as_uuid())
    .bind(graph.site.as_uuid())
    .bind(scan)
    .bind(graph.scan.as_uuid())
    .bind(new)
    .bind(again)
    .bind(age_days)
    .execute(owner)
    .await
    .unwrap();
    id
}

#[sqlx::test]
async fn the_list_has_only_records_that_found_something_newest_first(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let owner = owner_pool(opts.clone(), conn.clone()).await;
    let db = db::Db::from_pool(app_pool(opts, conn).await);
    let g = seed(&db, 1).await;
    let old = record(&owner, g, 1, 0, 5).await;
    let _quiet = record(&owner, g, 0, 0, 3).await;
    let recent = record(&owner, g, 0, 2, 1).await;
    let mut tx = db.tenant(g.tenant).await.unwrap();
    let rows = regressions::list(&mut tx, g.site, 10).await.unwrap();
    assert_eq!(
        rows.iter().map(|r| r.id).collect::<Vec<_>>(),
        vec![recent, old]
    );
    assert_eq!(rows[0].reappeared_count, 2);
    assert_eq!(rows[0].pass_rate, Some(91.5));
}

#[sqlx::test]
async fn the_banner_is_the_newest_undismissed_record_inside_the_window(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let owner = owner_pool(opts.clone(), conn.clone()).await;
    let db = db::Db::from_pool(app_pool(opts, conn).await);
    let g = seed(&db, 1).await;
    let mut tx = db.tenant(g.tenant).await.unwrap();
    assert!(
        regressions::banner(&mut tx, g.site, 7)
            .await
            .unwrap()
            .is_none(),
        "no record, no banner"
    );
    tx.rollback().await.unwrap();

    let stale = record(&owner, g, 1, 0, 9).await;
    let mut tx = db.tenant(g.tenant).await.unwrap();
    assert!(
        regressions::banner(&mut tx, g.site, 7)
            .await
            .unwrap()
            .is_none(),
        "a record older than the window ({stale}) is not shown"
    );
    tx.rollback().await.unwrap();

    let fresh = record(&owner, g, 2, 0, 1).await;
    let mut tx = db.tenant(g.tenant).await.unwrap();
    let shown = regressions::banner(&mut tx, g.site, 7)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(shown.id, fresh);
    assert!(regressions::dismiss(&mut tx, g.site, fresh).await.unwrap());
    assert!(
        regressions::banner(&mut tx, g.site, 7)
            .await
            .unwrap()
            .is_none(),
        "a dismissed record leaves the banner"
    );
    // The record itself stays in the list, and dismissing twice is harmless.
    assert_eq!(
        regressions::list(&mut tx, g.site, 10).await.unwrap().len(),
        2
    );
    assert!(regressions::dismiss(&mut tx, g.site, fresh).await.unwrap());
    tx.commit().await.unwrap();
}

#[sqlx::test]
async fn another_tenants_records_are_invisible_and_cannot_be_dismissed(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let owner = owner_pool(opts.clone(), conn.clone()).await;
    let db = db::Db::from_pool(app_pool(opts, conn).await);
    let a = seed(&db, 1).await;
    let b = seed(&db, 2).await;
    let theirs = record(&owner, b, 3, 0, 0).await;
    let mut tx = db.tenant(a.tenant).await.unwrap();
    let seen = regressions::list(&mut tx, a.site, 10).await.unwrap();
    assert_eq!(seen.len(), 0);
    // A's transaction asked about B's site or B's record finds nothing, and changes nothing.
    let seen = regressions::list(&mut tx, b.site, 10).await.unwrap();
    assert_eq!(seen.len(), 0);
    assert!(
        regressions::get(&mut tx, b.site, theirs)
            .await
            .unwrap()
            .is_none()
    );
    assert!(!regressions::dismiss(&mut tx, b.site, theirs).await.unwrap());
    assert!(!regressions::dismiss(&mut tx, a.site, theirs).await.unwrap());
    tx.rollback().await.unwrap();
    let dismissed: Option<time::OffsetDateTime> =
        sqlx::query_scalar("select dismissed_at from regressions where id = $1")
            .bind(theirs)
            .fetch_one(&owner)
            .await
            .unwrap();
    assert!(dismissed.is_none(), "B's record is untouched");
}

#[sqlx::test]
async fn a_scan_is_evaluated_once_and_a_record_cannot_name_another_tenants_scan(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let owner = owner_pool(opts.clone(), conn.clone()).await;
    let db = db::Db::from_pool(app_pool(opts, conn).await);
    let a = seed(&db, 1).await;
    let b = seed(&db, 2).await;
    let insert = |tenant: Graph, scan: Graph| {
        let owner = owner.clone();
        async move {
            sqlx::query(
                "insert into regressions (id, tenant_id, site_id, scan_id, new_count,
                                          reappeared_count, findings_seen, alert_state)
                 values (gen_random_uuid(), $1, $2, $3, 0, 0, 0, 'not_applicable')",
            )
            .bind(tenant.tenant.as_uuid())
            .bind(tenant.site.as_uuid())
            .bind(scan.scan.as_uuid())
            .execute(&owner)
            .await
        }
    };
    insert(a, a).await.unwrap();
    assert!(insert(a, a).await.is_err(), "one record per scan");
    assert!(
        insert(a, b).await.is_err(),
        "the composite key refuses a scan of another tenant, even for the owner"
    );
}
