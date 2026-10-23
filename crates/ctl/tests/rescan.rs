//! The scheduled rescan the leader starts (ADR-279, ADR-312): the plan's cadence, the delay per
//! shop, fairness across tenants and one scan per period, against PostgreSQL as the worker role.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use ctl::rescan;
use serde_json::{Value, json};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use uuid::Uuid;

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

/// Stores the shop's plan the way `shop_billing::put` does, cadence included.
async fn plan(w: &World, plan: &str) {
    sqlx::query(
        "insert into shop_billing (shop_id, tenant_id, standing, plan, plan_interval,
                                   render_cadence)
         values ($1, $2, case when $3 = 'free' then 'free_selected' else 'paid' end, $3,
                 case when $3 = 'free' then null else 'monthly' end,
                 case $3 when 'starter' then 'weekly' when 'free' then 'monthly' else 'daily' end)
         on conflict (shop_id) do update
           set plan = excluded.plan, standing = excluded.standing,
               plan_interval = excluded.plan_interval, render_cadence = excluded.render_cadence",
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

async fn clear_scans(w: &World) {
    sqlx::query("delete from scans")
        .execute(&w.owner)
        .await
        .unwrap();
}

/// Another installed shop with the setting on and the given cadence, in `tenant` (a new tenant
/// when `None`). Returns its tenant.
async fn extra_shop(w: &World, tenant: Option<Uuid>, cadence: &str) -> Uuid {
    let tenant = if let Some(t) = tenant {
        t
    } else {
        let t = Uuid::now_v7();
        sqlx::query("insert into tenants (id, kind) values ($1, 'shopify_store')")
            .bind(t)
            .execute(&w.owner)
            .await
            .unwrap();
        t
    };
    let (site, shop) = (Uuid::now_v7(), Uuid::now_v7());
    sqlx::query(
        "insert into sites (id, tenant_id, platform, base_url, settings)
         values ($1, $2, 'shopify', 'https://x.example', '{\"weekly_rescan\": true}')",
    )
    .bind(site)
    .bind(tenant)
    .execute(&w.owner)
    .await
    .unwrap();
    sqlx::query(
        "insert into shopify_shops (id, tenant_id, site_id, shop_domain, scopes, api_version,
                                    status, installed_at)
         values ($1, $2, $3, $4, '{}', '2026-10', 'installed', now())",
    )
    .bind(shop)
    .bind(tenant)
    .bind(site)
    .bind(format!("s{}.myshopify.com", shop.simple()))
    .execute(&w.owner)
    .await
    .unwrap();
    sqlx::query(
        "insert into shop_billing (shop_id, tenant_id, standing, plan, plan_interval, render_cadence)
         values ($1, $2, 'paid', 'growth', 'monthly', $3)",
    )
    .bind(shop)
    .bind(tenant)
    .bind(cadence)
    .execute(&w.owner)
    .await
    .unwrap();
    tenant
}

async fn due(w: &World) -> usize {
    let mut tx = w.db.public().await.unwrap();
    let found = db::repo::rescans::due(&mut tx, 100, 100).await.unwrap();
    tx.commit().await.unwrap();
    found.len()
}

fn scheduled_scans() -> &'static str {
    "select count(*) from scans where trigger = 'scheduled'"
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn a_shop_is_due_only_with_the_setting_on_and_an_interval_without_a_scan(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let w = world(opts, conn).await;
    plan(&w, "starter").await;
    assert_eq!(due(&w).await, 0, "the setting is off by default");
    weekly(&w, true).await;
    assert_eq!(due(&w).await, 1, "never scanned, setting on");

    // Verification scans of a fix do not count; a scan inside the interval does.
    scan_made(&w, "verify", "succeeded", "1 hour").await;
    assert_eq!(due(&w).await, 1);
    scan_made(&w, "manual", "succeeded", "6 days").await;
    assert_eq!(due(&w).await, 0, "scanned six days ago, weekly plan");
    clear_scans(&w).await;

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
    clear_scans(&w).await;
    scan_made(&w, "manual", "running", "3 days").await;
    assert_eq!(due(&w).await, 0, "a scan under way");
    clear_scans(&w).await;

    sqlx::query("update shopify_shops set status = 'uninstalled', uninstalled_at = now()")
        .execute(&w.owner)
        .await
        .unwrap();
    assert_eq!(due(&w).await, 0, "an uninstalled shop");
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn the_plan_sets_the_cadence_free_monthly_starter_weekly_growth_and_pro_daily(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let w = world(opts, conn).await;
    weekly(&w, true).await;
    // (plan, age of the last scan, due?). The delay per shop is under a twelfth of the interval,
    // so a scan a full interval and an eighth old is always due, and one a little younger than
    // the interval never is.
    let cases = [
        ("free", "29 days", false),
        ("free", "34 days", true),
        ("starter", "6 days", false),
        ("starter", "8 days", true),
        ("growth", "20 hours", false),
        ("growth", "27 hours", true),
        ("pro", "20 hours", false),
        ("pro", "27 hours", true),
    ];
    for (name, age, expected) in cases {
        plan(&w, name).await;
        clear_scans(&w).await;
        scan_made(&w, "scheduled", "succeeded", age).await;
        assert_eq!(due(&w).await == 1, expected, "{name}, last scan {age} ago");
    }
    // Downgrading lengthens the interval: a day-old rhythm no longer applies on Free.
    plan(&w, "growth").await;
    clear_scans(&w).await;
    scan_made(&w, "scheduled", "succeeded", "3 days").await;
    assert_eq!(due(&w).await, 1);
    plan(&w, "free").await;
    assert_eq!(due(&w).await, 0, "Free scans monthly");
    // A shop with no plan stored is on Free's cadence too.
    sqlx::query("delete from shop_billing")
        .execute(&w.owner)
        .await
        .unwrap();
    assert_eq!(due(&w).await, 0);
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn shops_are_spread_by_a_bounded_delay_that_does_not_change(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let w = world(opts, conn).await;
    for _ in 0..11 {
        extra_shop(&w, None, "weekly").await;
    }
    weekly(&w, true).await;
    plan(&w, "starter").await;
    // Give all twelve shops a scan of the same age.
    sqlx::query(
        "insert into scans (id, tenant_id, site_id, trigger, status, ruleset_version, created_at)
         select uuidv7(), tenant_id, id, 'scheduled', 'succeeded', 'v',
                now() - interval '7 days' - interval '1 hour'
           from sites",
    )
    .execute(&w.owner)
    .await
    .unwrap();
    let early = due(&w).await;
    assert_eq!(early, due(&w).await, "the delay of a shop is fixed");
    assert!(early <= 12, "at most the twelve shops are due");
    // Seven days exactly: nobody is due before the interval has passed.
    sqlx::query("update scans set created_at = now() - interval '6 days 23 hours'")
        .execute(&w.owner)
        .await
        .unwrap();
    assert_eq!(due(&w).await, 0, "inside the interval");
    // A twelfth of the interval later every shop is due.
    sqlx::query("update scans set created_at = now() - interval '7 days 15 hours'")
        .execute(&w.owner)
        .await
        .unwrap();
    assert_eq!(due(&w).await, 12, "past the interval and the longest delay");
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn one_tenant_with_many_shops_cannot_starve_the_others(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let w = world(opts, conn).await;
    // The world's own shop is a tenant with nothing due (it has no setting). Tenant A has 9
    // shops, tenants B and C one each; none was ever scanned.
    let a = extra_shop(&w, None, "daily").await;
    for _ in 0..8 {
        extra_shop(&w, Some(a), "daily").await;
    }
    let b = extra_shop(&w, None, "daily").await;
    let c = extra_shop(&w, None, "daily").await;

    // With room for three, each tenant's first shop comes before A's second.
    let mut tx = w.db.public().await.unwrap();
    let first = db::repo::rescans::due(&mut tx, 3, 5).await.unwrap();
    tx.commit().await.unwrap();
    let mut tenants: Vec<Uuid> = first.iter().map(|d| d.tenant.as_uuid()).collect();
    tenants.sort();
    let mut expected = vec![a, b, c];
    expected.sort();
    assert_eq!(
        tenants, expected,
        "a tenant took a second turn before the others had one"
    );

    // A round starts five of A's nine at most, and the others' one each.
    let round = rescan::start_due(&w.db).await.unwrap();
    assert_eq!(round.started, rescan::MAX_PER_TENANT_PER_ROUND + 2);
    let per_a: i64 = sqlx::query_scalar("select count(*) from scans where tenant_id = $1")
        .bind(a)
        .fetch_one(&w.owner)
        .await
        .unwrap();
    assert_eq!(per_a, 5);
    for t in [b, c] {
        let n: i64 = sqlx::query_scalar("select count(*) from scans where tenant_id = $1")
            .bind(t)
            .fetch_one(&w.owner)
            .await
            .unwrap();
        assert_eq!(n, 1);
    }
    // The next round takes the rest of A's.
    assert_eq!(rescan::start_due(&w.db).await.unwrap().started, 4);
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn a_due_shop_gets_one_scheduled_scan_per_period_even_from_two_leaders(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let w = world(opts, conn).await;
    weekly(&w, true).await;
    plan(&w, "starter").await;
    scan_made(&w, "manual", "succeeded", "9 days").await;

    let (one, two) = tokio::join!(rescan::start_due(&w.db), rescan::start_due(&w.db));
    let started = one.unwrap().started + two.unwrap().started;
    assert_eq!(started, 1, "two leaders started the same period twice");
    assert_eq!(w.count(scheduled_scans()).await, 1);

    let (payload, key, state): (Value, String, String) = sqlx::query_as(
        "select payload, idempotency_key, state from jobs where queue = 'shopify.read_store'",
    )
    .fetch_one(&w.owner)
    .await
    .unwrap();
    let scan: Uuid = sqlx::query_scalar("select id from scans where trigger = 'scheduled'")
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

    // The scan is under way, so a later round starts nothing, and neither does one after it ends.
    assert_eq!(
        rescan::start_due(&w.db).await.unwrap(),
        rescan::Round::default()
    );
    sqlx::query("update scans set status = 'succeeded'")
        .execute(&w.owner)
        .await
        .unwrap();
    assert_eq!(
        rescan::start_due(&w.db).await.unwrap(),
        rescan::Round::default(),
        "the period already has its scan"
    );
    assert_eq!(w.count(scheduled_scans()).await, 1);
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn free_shops_are_scanned_monthly_and_an_upgrade_speeds_them_up(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let w = world(opts, conn).await;
    weekly(&w, true).await;
    plan(&w, "free").await;
    scan_made(&w, "scheduled", "succeeded", "3 days").await;
    assert_eq!(
        rescan::start_due(&w.db).await.unwrap(),
        rescan::Round::default(),
        "three days into a month"
    );
    plan(&w, "growth").await;
    assert_eq!(rescan::start_due(&w.db).await.unwrap().started, 1);
    assert_eq!(w.count("select count(*) from scans").await, 2);
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
