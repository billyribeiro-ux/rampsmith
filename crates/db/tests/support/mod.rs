//! Shared fixtures for the database tests (ADR-015).
//!
//! `#[sqlx::test]` hands each test a fresh, migrated database and connect options for the
//! superuser in `DATABASE_URL`. Superusers bypass row-level security, so `app_db` builds a
//! pool whose every connection switches to the non-owner `rampsmith_app` role, exactly the
//! privileges production runs with (ADR-006).

#![allow(dead_code, unreachable_pub, clippy::missing_panics_doc)]
#![allow(clippy::unwrap_used, clippy::expect_used)]

use db::Db;
use db::repo::{findings, scans, sites, tenants};
use domain::{Impact, Platform, ScanTrigger, TenantId, TenantKind};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::{Executor, PgPool};

/// A pool connected as `rampsmith_app`.
pub async fn app_pool(opts: PgPoolOptions, conn: PgConnectOptions) -> PgPool {
    opts.after_connect(|c, _| {
        Box::pin(async move {
            c.execute("set role rampsmith_app").await?;
            Ok(())
        })
    })
    .connect_with(conn)
    .await
    .expect("connect as rampsmith_app")
}

/// Password of the throw-away `LOGIN` roles the tests create. They exist only on the test
/// cluster, and every test removes the ones it made.
pub const TEST_ROLE_PASSWORD: &str = "rampsmith-test-only";

/// Creates the `LOGIN` role `name` with `attributes` (for example `in role rampsmith_app`),
/// replacing a leftover of an earlier run that died before cleaning up. Names are unique per
/// test, because roles are cluster-wide and tests run in parallel.
pub async fn create_login_role(owner: &PgPool, name: &str, attributes: &str) {
    drop_role(owner, name).await;
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "create role {name} login password '{TEST_ROLE_PASSWORD}' {attributes}"
    )))
    .execute(owner)
    .await
    .expect("create the login role");
}

/// Removes `name` and anything it owns in this database. Does nothing if it does not exist.
pub async fn drop_role(owner: &PgPool, name: &str) {
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "do $$ begin
           if exists (select 1 from pg_roles where rolname = '{name}') then
             reassign owned by {name} to current_user;
             drop owned by {name};
             drop role {name};
           end if;
         end $$"
    )))
    .execute(owner)
    .await
    .expect("drop the login role");
}

/// Connect options for `name`, which [`create_login_role`] made, to the same database.
pub fn as_role(conn: &PgConnectOptions, name: &str) -> PgConnectOptions {
    conn.clone().username(name).password(TEST_ROLE_PASSWORD)
}

/// A one-connection pool logged in as `name`.
pub async fn pool_as(opts: &PgPoolOptions, conn: &PgConnectOptions, name: &str) -> PgPool {
    opts.clone()
        .max_connections(2)
        .connect_with(as_role(conn, name))
        .await
        .expect("connect as the login role")
}

/// A superuser pool, for assertions that must see past row-level security.
pub async fn owner_pool(opts: PgPoolOptions, conn: PgConnectOptions) -> PgPool {
    opts.connect_with(conn).await.expect("connect as owner")
}

/// Everything one tenant owns, created through the repositories.
#[derive(Debug, Clone, Copy)]
pub struct Graph {
    pub tenant: TenantId,
    pub site: domain::SiteId,
    pub scan: domain::ScanId,
    pub finding: domain::FindingId,
    pub fix: domain::FixId,
    pub shop: domain::ShopId,
}

/// Creates a tenant with one site, Shopify shop and tokens, scan, finding, occurrence, fix
/// and audit entry.
pub async fn seed(db: &Db, label: u8) -> Graph {
    let tenant = TenantId::new();
    let mut tx = db.tenant(tenant).await.unwrap();
    tenants::create(&mut tx, TenantKind::ShopifyStore)
        .await
        .unwrap();
    let site = sites::create(
        &mut tx,
        &sites::NewSite {
            platform: Platform::Shopify,
            base_url: format!("https://store-{label}.example"),
            primary_locale: "en".to_owned(),
        },
    )
    .await
    .unwrap();
    let scan = scans::create(
        &mut tx,
        &scans::NewScan {
            site_id: site.id,
            trigger: ScanTrigger::Manual,
            ruleset_version: "axe-4.14.0+test".to_owned(),
            theme_ref: None,
        },
    )
    .await
    .unwrap();
    let finding = findings::record(
        &mut tx,
        &findings::Observation {
            site_id: site.id,
            scan_id: scan.id,
            fingerprint: [label; 32],
            rule_id: "image-alt".to_owned(),
            criteria: vec!["1.1.1".to_owned()],
            impact: Impact::Critical,
            occurrence_count: 3,
        },
    )
    .await
    .unwrap();
    db::repo::occurrences::insert(
        &mut tx,
        &[db::repo::occurrences::NewOccurrence {
            finding_id: finding.id,
            scan_id: scan.id,
            page_url: format!("https://store-{label}.example/products/a"),
            page_state: domain::PageState::Default,
            target: "main img".to_owned(),
            html_excerpt: "<img src=\"a.jpg\">".to_owned(),
            captured_at: time::OffsetDateTime::now_utc(),
        }],
    )
    .await
    .unwrap();
    let fix = db::repo::fixes::propose(
        &mut tx,
        &db::repo::fixes::NewFix {
            site_id: site.id,
            kind: domain::FixKind::Data,
            channel: domain::FixChannel::AdminApi,
            origin: domain::FixOrigin::Ai,
            model: Some("claude-haiku-5-5".to_owned()),
            prompt_version: Some("alt-text@1".to_owned()),
            confidence: Some(0.912),
            diff: Some(serde_json::json!({"resource": "MediaImage/1", "field": "alt", "before": "", "after": "Red wool scarf"})),
            finding_ids: vec![finding.id],
        },
    )
    .await
    .unwrap();
    db::repo::audit::append(
        &mut tx,
        &db::repo::audit::NewEntry {
            actor_kind: domain::ActorKind::System,
            actor_id: None,
            action: "fix.proposed".to_owned(),
            subject_type: "fix".to_owned(),
            subject_id: fix.id.as_uuid(),
            data: serde_json::json!({}),
        },
    )
    .await
    .unwrap();
    let shop = seed_shop(&mut tx, site.id, label).await;
    tx.commit().await.unwrap();
    Graph {
        tenant,
        site: site.id,
        scan: scan.id,
        finding: finding.id,
        fix: fix.id,
        shop,
    }
}

/// Installs `store-<label>.myshopify.com` on `site` with tokens.
pub async fn seed_shop(tx: &mut db::TenantTx, site: domain::SiteId, label: u8) -> domain::ShopId {
    let shop = db::repo::shopify::install(
        tx,
        &db::repo::shopify::NewShop {
            site_id: site,
            shop_domain: format!("store-{label}.myshopify.com"),
            scopes: vec!["read_products".to_owned()],
            api_version: "2026-10".to_owned(),
        },
    )
    .await
    .unwrap();
    db::repo::shopify::put_tokens(tx, shop.id, &sealed_tokens(label))
        .await
        .unwrap();
    shop.id
}

/// Placeholder ciphertext; the repository stores bytes and never decrypts.
pub fn sealed_tokens(label: u8) -> db::repo::shopify::SealedTokens {
    // A fixed instant: rows round-trip at microsecond precision, so tests compare whole values.
    let now = time::OffsetDateTime::from_unix_timestamp(1_792_300_000).unwrap()
        + time::Duration::minutes(i64::from(label));
    db::repo::shopify::SealedTokens {
        access_ct: vec![label, 1, 2, 3],
        refresh_ct: vec![label, 4, 5, 6],
        key_id: "k1".to_owned(),
        access_expires_at: now + time::Duration::hours(1),
        refresh_expires_at: now + time::Duration::days(90),
    }
}

/// Asserts that a listing is empty, printing what it held otherwise.
#[track_caller]
pub fn assert_empty<T: std::fmt::Debug>(items: &[T]) {
    assert!(items.is_empty(), "expected nothing, got {items:?}");
}
