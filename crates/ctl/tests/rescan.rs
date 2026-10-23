//! The weekly rescan the leader starts (ADR-279), against PostgreSQL as the worker role.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use ctl::rescan;
use serde_json::{Value, json};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};

mod support;

use support::world::{World, world};

async fn weekly(w: &World, on: bool) {
    sqlx::query("update sites set settings = jsonb_build_object('weekly_rescan', $2::boolean) where id = $1")
        .bind(w.site().await)
        .bind(on)
        .execute(&w.owner)
        .await
        .unwrap();
}

async fn plan(w: &World, plan: &str) {
    sqlx::query(
        "insert into shop_billing (shop_id, tenant_id, standing, plan, plan_interval)
         values ($1, $2, case when $3 = 'free' then 'free_selected' else 'paid' end, $3,
                 case when $3 = 'free' then null else 'monthly' end)
         on conflict (shop_id) do update
           set plan = excluded.plan, standing = excluded.standing,
               plan_interval = excluded.plan_interval",
    )
    .bind(w.session.shop_id.as_uuid())
    .bind(w.session.tenant.as_uuid())
    .bind(plan)
    .execute(&w.owner)
    .await
    .unwrap();
}

/// A scan of the shop's site made `age` ago.
async fn scan_made(w: &World, trigger: &str, status: &str, age: &str) {
    sqlx::query(
        "insert into scans (id, tenant_id, site_id, trigger, status, ruleset_version, created_at)
         values (uuidv7(), $1, $2, $3, $4, 'v', now() - $5::interval)",
    )
    .bind(w.session.tenant.as_uuid())
    .bind(w.site().await)
    .bind(trigger)
    .bind(status)
    .bind(age)
    .execute(&w.owner)
    .await
    .unwrap();
}

async fn due(w: &World) -> usize {
    let mut tx = w.db.public().await.unwrap();
    let found = db::repo::rescans::due(&mut tx, None, 100).await.unwrap();
    tx.commit().await.unwrap();
    found.len()
}

fn scheduled_scans() -> &'static str {
    "select count(*) from scans where trigger = 'scheduled'"
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn a_shop_is_due_only_with_the_setting_on_and_a_week_without_a_scan(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let w = world(opts, conn).await;
    assert_eq!(due(&w).await, 0, "the setting is off by default");
    weekly(&w, true).await;
    assert_eq!(due(&w).await, 1, "never scanned, setting on");

    // Verification scans of a fix do not count; a scan inside the week does.
    scan_made(&w, "verify", "succeeded", "1 hour").await;
    assert_eq!(due(&w).await, 1);
    scan_made(&w, "manual", "succeeded", "6 days").await;
    assert_eq!(due(&w).await, 0, "scanned six days ago");
    sqlx::query("delete from scans")
        .execute(&w.owner)
        .await
        .unwrap();

    scan_made(&w, "scheduled", "succeeded", "8 days").await;
    assert_eq!(due(&w).await, 1, "eight days ago");
    // A failure is retried the next day, not on every tick.
    scan_made(&w, "scheduled", "failed", "2 hours").await;
    assert_eq!(due(&w).await, 0, "failed two hours ago");
    sqlx::query("delete from scans where status = 'failed'")
        .execute(&w.owner)
        .await
        .unwrap();
    scan_made(&w, "scheduled", "failed", "2 days").await;
    assert_eq!(due(&w).await, 1, "failed two days ago");
    sqlx::query("delete from scans")
        .execute(&w.owner)
        .await
        .unwrap();
    scan_made(&w, "manual", "running", "3 days").await;
    assert_eq!(due(&w).await, 0, "a scan under way");
    sqlx::query("delete from scans")
        .execute(&w.owner)
        .await
        .unwrap();

    sqlx::query("update shopify_shops set status = 'uninstalled', uninstalled_at = now()")
        .execute(&w.owner)
        .await
        .unwrap();
    assert_eq!(due(&w).await, 0, "an uninstalled shop");
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn a_due_shop_on_a_plan_with_weekly_rescans_gets_one_scheduled_scan(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let w = world(opts, conn).await;
    weekly(&w, true).await;
    plan(&w, "starter").await;
    scan_made(&w, "manual", "succeeded", "9 days").await;

    let first = rescan::start_due(&w.db).await.unwrap();
    assert_eq!(
        first,
        rescan::Round {
            started: 1,
            skipped: 0
        }
    );
    assert_eq!(w.count(scheduled_scans()).await, 1);

    let (payload, key, state): (Value, String, String) = sqlx::query_as(
        "select payload, idempotency_key, state from jobs where queue = 'shopify.read_store'",
    )
    .fetch_one(&w.owner)
    .await
    .unwrap();
    let scan: uuid::Uuid = sqlx::query_scalar("select id from scans where trigger = 'scheduled'")
        .fetch_one(&w.owner)
        .await
        .unwrap();
    assert_eq!(payload["scan_id"], json!(scan));
    assert_eq!(payload["shop_id"], json!(w.session.shop_id.as_uuid()));
    assert_eq!(key, format!("shopify.read_store:{scan}"));
    assert_eq!(state, "ready");
    let (actor, data): (String, Value) =
        sqlx::query_as("select actor_kind, data from audit_log where action = 'scan.started'")
            .fetch_one(&w.owner)
            .await
            .unwrap();
    assert_eq!(actor, "system");
    assert_eq!(data, json!({"trigger": "scheduled"}));

    // The scan is under way, so the shop is not due and a second round starts nothing.
    let second = rescan::start_due(&w.db).await.unwrap();
    assert_eq!(second, rescan::Round::default());
    assert_eq!(w.count(scheduled_scans()).await, 1);
    assert_eq!(
        w.count("select count(*) from jobs where queue = 'shopify.read_store'")
            .await,
        1
    );
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn a_plan_without_weekly_rescans_gets_none_and_does_not_hide_other_shops(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let w = world(opts, conn).await;
    weekly(&w, true).await;
    // No plan stored: Free's entitlements, which are monthly.
    let none = rescan::start_due(&w.db).await.unwrap();
    assert_eq!(
        none,
        rescan::Round {
            started: 0,
            skipped: 1
        }
    );
    plan(&w, "free").await;
    let free = rescan::start_due(&w.db).await.unwrap();
    assert_eq!(
        free,
        rescan::Round {
            started: 0,
            skipped: 1
        }
    );
    assert_eq!(w.count("select count(*) from scans").await, 0);
    assert_eq!(
        w.count("select count(*) from jobs where queue = 'shopify.read_store'")
            .await,
        0
    );

    // Upgrading starts the scan on the next round.
    plan(&w, "growth").await;
    let upgraded = rescan::start_due(&w.db).await.unwrap();
    assert_eq!(upgraded.started, 1);
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn a_shop_that_switched_the_setting_off_is_not_started(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let w = world(opts, conn).await;
    weekly(&w, true).await;
    plan(&w, "starter").await;
    weekly(&w, false).await;
    assert_eq!(due(&w).await, 0);
    assert_eq!(
        rescan::start_due(&w.db).await.unwrap(),
        rescan::Round::default()
    );
    assert_eq!(w.count(scheduled_scans()).await, 0);
}
