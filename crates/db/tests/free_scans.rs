//! The free scanner's anonymous scans (ADR-267): the quota ledger, the 24-hour cache, the one
//! tenantless job the application role may create, and the sweep.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod support;

use db::Db;
use db::repo::free_scans;
use sqlx::PgPool;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use support::{app_pool, owner_pool, worker_pool};
use uuid::Uuid;

const IP: [u8; 32] = [7; 32];
const OTHER_IP: [u8; 32] = [8; 32];

async fn ask(db: &Db, ip: &[u8], domain: &str) -> Uuid {
    let id = Uuid::now_v7();
    let mut tx = db.public().await.unwrap();
    free_scans::create(&mut tx, id, domain, &format!("https://{domain}/"), ip)
        .await
        .unwrap();
    free_scans::enqueue(&mut tx, id).await.unwrap();
    tx.commit().await.unwrap();
    id
}

async fn finish(worker: &PgPool, id: Uuid, status: &str) {
    let sql = match status {
        "complete" => {
            "update free_scans set status = 'complete', finished_at = now(),
                    result = '{\"domain\":\"x\"}' where id = $1"
        }
        "refused" => {
            "update free_scans set status = 'refused', refusal = 'robots', finished_at = now()
              where id = $1"
        }
        _ => "update free_scans set status = 'failed', finished_at = now() where id = $1",
    };
    sqlx::query(sql).bind(id).execute(worker).await.unwrap();
}

#[sqlx::test(migrations = "./migrations")]
async fn a_request_is_recorded_and_queued_for_no_tenant(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let owner = owner_pool(opts.clone(), conn.clone()).await;
    let db = Db::from_pool(app_pool(opts, conn).await);
    let id = ask(&db, &IP, "shop.example.com").await;

    let mut tx = db.public().await.unwrap();
    let scan = free_scans::get(&mut tx, id).await.unwrap().unwrap();
    assert_eq!(scan.status, "queued");
    assert_eq!(scan.domain, "shop.example.com");
    assert_eq!(free_scans::in_flight_count(&mut tx).await.unwrap(), 1);
    let joined = free_scans::in_flight_for(&mut tx, "shop.example.com")
        .await
        .unwrap();
    assert_eq!(joined.map(|s| s.id), Some(id));
    tx.rollback().await.unwrap();

    let (queue, schema, tenant, payload): (String, String, Option<Uuid>, serde_json::Value) =
        sqlx::query_as("select queue, payload_schema, tenant_id, payload from jobs")
            .fetch_one(&owner)
            .await
            .unwrap();
    assert_eq!(queue, "free_scan.run");
    assert_eq!(schema, "free_scan.run@1");
    assert_eq!(tenant, None);
    assert_eq!(payload["free_scan_id"], id.to_string());
}

#[sqlx::test(migrations = "./migrations")]
async fn the_address_is_not_stored_and_enqueueing_twice_makes_one_job(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let owner = owner_pool(opts.clone(), conn.clone()).await;
    let db = Db::from_pool(app_pool(opts, conn).await);
    let id = ask(&db, &IP, "shop.example.com").await;
    let mut tx = db.public().await.unwrap();
    free_scans::enqueue(&mut tx, id).await.unwrap();
    tx.commit().await.unwrap();
    let jobs: i64 = sqlx::query_scalar("select count(*) from jobs")
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(jobs, 1, "the same scan was queued twice");
    // 32 bytes of hash; there is no column that could hold an address.
    let columns: Vec<String> = sqlx::query_scalar(
        "select column_name::text from information_schema.columns where table_name = 'free_scans'",
    )
    .fetch_all(&owner)
    .await
    .unwrap();
    assert!(
        !columns.iter().any(|c| c == "ip" || c == "address"),
        "{columns:?}"
    );
}

/// The application role may create one kind of tenantless job, through the function; it still
/// may not insert a job for no tenant itself (the job table's policy, ADR-003).
#[sqlx::test(migrations = "./migrations")]
async fn the_application_role_cannot_queue_anything_else_for_no_tenant(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let app = app_pool(opts, conn).await;
    let direct = sqlx::query(
        "insert into jobs (id, queue, payload_schema, payload, state, max_attempts)
         values (gen_random_uuid(), 'free_scan.run', 'free_scan.run@1', '{}', 'ready', 3)",
    )
    .execute(&app)
    .await;
    assert!(direct.is_err(), "the app role inserted a tenantless job");
    let unknown = sqlx::query("select free_scan_enqueue($1)")
        .bind(Uuid::now_v7())
        .execute(&app)
        .await;
    assert!(unknown.is_err(), "queued a scan that does not exist");
}

#[sqlx::test(migrations = "./migrations")]
async fn the_application_role_cannot_change_or_delete_a_scan(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let app = app_pool(opts.clone(), conn.clone()).await;
    let db = Db::from_pool(app.clone());
    let id = ask(&db, &IP, "shop.example.com").await;
    let update = sqlx::query("update free_scans set status = 'complete' where id = $1")
        .bind(id)
        .execute(&app)
        .await;
    assert!(update.is_err(), "the api rewrote a scan");
    let delete = sqlx::query("delete from free_scans").execute(&app).await;
    assert!(delete.is_err(), "the api deleted scans");
    let sweep = sqlx::query("select free_scans_sweep()").execute(&app).await;
    assert!(sweep.is_err(), "the api ran the sweep");
}

#[sqlx::test(migrations = "./migrations")]
async fn an_address_gets_three_scans_a_day_and_failed_ones_do_not_count(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let worker = worker_pool(opts.clone(), conn.clone()).await;
    let db = Db::from_pool(app_pool(opts, conn).await);
    let first = ask(&db, &IP, "a.example.com").await;
    let second = ask(&db, &IP, "b.example.com").await;
    let third = ask(&db, &IP, "c.example.com").await;
    let mut tx = db.public().await.unwrap();
    let used = free_scans::used_by_ip(&mut tx, &IP).await.unwrap();
    assert_eq!(used.count, 3);
    assert!(
        (86_390..=86_400).contains(&used.frees_in_seconds),
        "{}",
        used.frees_in_seconds
    );
    assert_eq!(
        free_scans::used_by_ip(&mut tx, &OTHER_IP)
            .await
            .unwrap()
            .count,
        0
    );
    tx.rollback().await.unwrap();

    // A scan that failed on our side costs the visitor nothing; a refused one does.
    finish(&worker, first, "failed").await;
    finish(&worker, second, "refused").await;
    finish(&worker, third, "complete").await;
    let mut tx = db.public().await.unwrap();
    assert_eq!(free_scans::used_by_ip(&mut tx, &IP).await.unwrap().count, 2);
    tx.rollback().await.unwrap();
}

#[sqlx::test(migrations = "./migrations")]
async fn a_domain_gets_one_scan_a_day_and_a_complete_one_is_the_cache(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let worker = worker_pool(opts.clone(), conn.clone()).await;
    let db = Db::from_pool(app_pool(opts, conn).await);
    let id = ask(&db, &IP, "shop.example.com").await;
    let mut tx = db.public().await.unwrap();
    assert_eq!(
        free_scans::used_by_domain(&mut tx, "shop.example.com")
            .await
            .unwrap()
            .count,
        1
    );
    assert!(
        free_scans::cached(&mut tx, "shop.example.com")
            .await
            .unwrap()
            .is_none()
    );
    tx.rollback().await.unwrap();

    finish(&worker, id, "complete").await;
    let mut tx = db.public().await.unwrap();
    let hit = free_scans::cached(&mut tx, "shop.example.com")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(hit.id, id);
    assert_eq!(hit.result.unwrap()["domain"], "x");
    assert!(
        free_scans::cached(&mut tx, "other.example.com")
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        free_scans::in_flight_for(&mut tx, "shop.example.com")
            .await
            .unwrap()
            .is_none()
    );
    tx.rollback().await.unwrap();
}

/// Two requests at once for one address cannot both take its last place.
#[sqlx::test(migrations = "./migrations")]
async fn concurrent_requests_cannot_both_take_the_last_place(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let db = Db::from_pool(app_pool(opts, conn).await);
    ask(&db, &IP, "a.example.com").await;
    ask(&db, &IP, "b.example.com").await;
    let mut admitted = Vec::new();
    for domain in ["c.example.com", "d.example.com"] {
        let db = db.clone();
        admitted.push(tokio::spawn(async move {
            let mut tx = db.public().await.unwrap();
            free_scans::lock(&mut tx, &IP, domain).await.unwrap();
            if free_scans::used_by_ip(&mut tx, &IP).await.unwrap().count >= 3 {
                tx.rollback().await.unwrap();
                return false;
            }
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            free_scans::create(
                &mut tx,
                Uuid::now_v7(),
                domain,
                "https://x.example.com/",
                &IP,
            )
            .await
            .unwrap();
            tx.commit().await.unwrap();
            true
        }));
    }
    let mut results = Vec::new();
    for handle in admitted {
        results.push(handle.await.unwrap());
    }
    assert_eq!(
        results.iter().filter(|admitted| **admitted).count(),
        1,
        "{results:?}"
    );
}

#[sqlx::test(migrations = "./migrations")]
async fn the_sweep_ends_stuck_scans_and_deletes_expired_ones(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let owner = owner_pool(opts.clone(), conn.clone()).await;
    let worker = worker_pool(opts.clone(), conn.clone()).await;
    let db = Db::from_pool(app_pool(opts, conn).await);
    let stuck = ask(&db, &IP, "stuck.example.com").await;
    let fresh = ask(&db, &IP, "fresh.example.com").await;
    let old = ask(&db, &OTHER_IP, "old.example.com").await;
    sqlx::query("update free_scans set created_at = now() - interval '11 minutes' where id = $1")
        .bind(stuck)
        .execute(&owner)
        .await
        .unwrap();
    sqlx::query(
        "update free_scans set created_at = now() - interval '25 hours',
                expires_at = now() - interval '1 hour' where id = $1",
    )
    .bind(old)
    .execute(&owner)
    .await
    .unwrap();

    let worker_db = Db::from_pool(worker.clone());
    let mut tx = worker_db.public().await.unwrap();
    let swept = free_scans::sweep(&mut tx).await.unwrap();
    tx.commit().await.unwrap();
    assert_eq!(swept, 1);
    let status: String = sqlx::query_scalar("select status from free_scans where id = $1")
        .bind(stuck)
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(status, "failed");
    let fresh_status: String = sqlx::query_scalar("select status from free_scans where id = $1")
        .bind(fresh)
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(fresh_status, "queued");
    let left: i64 = sqlx::query_scalar("select count(*) from free_scans where id = $1")
        .bind(old)
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(left, 0);
}
