//! Agency links (ADR-313, ADR-314): an organization reaches a store only through a link its
//! merchant approved, and loses it the moment either side revokes. Every test here is an
//! authorization test: what the organization must NOT be able to read or do.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod support;

use db::Db;
use db::repo::agency::{self, CodeRefused};
use db::repo::identity;
use domain::UserId;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use support::{Graph, app_pool, seed};
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

async fn user(db: &Db, name: &str) -> UserId {
    let id = UserId::new();
    let mut tx = db.identity().await.unwrap();
    identity::create_user(&mut tx, id, &format!("{name}-{id}@example.com"), name)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    id
}

async fn org(db: &Db, owner: UserId, name: &str) -> Uuid {
    let mut tx = db.identity().await.unwrap();
    let org = agency::create_organization(&mut tx, Uuid::now_v7(), name, owner)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    org.id
}

/// A code for `org`, as the dashboard makes one: only its hash is stored.
async fn code(db: &Db, org: Uuid, by: UserId, seed: u8, ttl: Duration) -> Vec<u8> {
    let hash = vec![seed; 32];
    let mut tx = db.identity().await.unwrap();
    agency::create_code(
        &mut tx,
        Uuid::now_v7(),
        org,
        by,
        &hash,
        OffsetDateTime::now_utc() + ttl,
    )
    .await
    .unwrap()
    .unwrap();
    tx.commit().await.unwrap();
    hash
}

async fn approve(db: &Db, shop: Graph, hash: &[u8]) -> Option<Uuid> {
    let mut tx = db.tenant(shop.tenant).await.unwrap();
    let link = agency::approve(&mut tx, shop.shop, hash, Uuid::now_v7())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    link
}

async fn overview(db: &Db, user: UserId) -> Vec<agency::LinkedStore> {
    let mut tx = db.identity().await.unwrap();
    agency::linked_stores(&mut tx, user).await.unwrap()
}

#[sqlx::test]
async fn only_a_member_makes_codes_and_an_organization_holds_a_few(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let db = Db::from_pool(app_pool(opts, conn).await);
    let (ada, eve) = (user(&db, "ada").await, user(&db, "eve").await);
    let org = org(&db, ada, "Ada Agency").await;

    let mut tx = db.identity().await.unwrap();
    let refused = agency::create_code(
        &mut tx,
        Uuid::now_v7(),
        org,
        eve,
        &[1; 32],
        OffsetDateTime::now_utc() + Duration::days(1),
    )
    .await
    .unwrap();
    assert_eq!(refused, Err(CodeRefused::NotMember), "a stranger made a code");
    tx.rollback().await.unwrap();

    for n in 0..agency::MAX_LIVE_CODES {
        code(&db, org, ada, u8::try_from(n).unwrap() + 10, Duration::days(1)).await;
    }
    let mut tx = db.identity().await.unwrap();
    let refused = agency::create_code(
        &mut tx,
        Uuid::now_v7(),
        org,
        ada,
        &[99; 32],
        OffsetDateTime::now_utc() + Duration::days(1),
    )
    .await
    .unwrap();
    assert_eq!(refused, Err(CodeRefused::TooMany), "the live-code cap did not hold");
}

#[sqlx::test]
async fn the_overview_shows_a_store_only_after_its_merchant_approved_and_not_after_a_revoke(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let db = Db::from_pool(app_pool(opts, conn).await);
    let (a, b) = (seed(&db, 1).await, seed(&db, 2).await);
    let ada = user(&db, "ada").await;
    let org = org(&db, ada, "Ada Agency").await;

    // Created codes link nothing by themselves.
    let hash = code(&db, org, ada, 1, Duration::days(1)).await;
    assert!(overview(&db, ada).await.is_empty(), "a code alone linked a store");

    let link = approve(&db, a, &hash).await.expect("the code was valid");
    let stores = overview(&db, ada).await;
    assert_eq!(stores.len(), 1, "only the approved store is listed");
    assert_eq!(stores[0].link_id, link);
    assert_eq!(stores[0].organization_name, "Ada Agency");
    assert!(stores[0].scan_status.is_some(), "the latest scan is shown");

    // The other store never granted anything: not listed, whatever the organization knows.
    let unlinked = shop_domain(&db, b).await;
    assert!(
        stores.iter().all(|s| s.shop_domain != unlinked),
        "an unlinked store appeared"
    );

    // The merchant revokes: the next read already lacks it.
    let mut tx = db.tenant(a.tenant).await.unwrap();
    assert!(agency::revoke(&mut tx, a.shop, link).await.unwrap());
    tx.commit().await.unwrap();
    assert!(overview(&db, ada).await.is_empty(), "a revoked link still showed");

    // And a fresh code links it again, as a new link.
    let again = code(&db, org, ada, 2, Duration::days(1)).await;
    let second = approve(&db, a, &again).await.expect("a new code works");
    assert_ne!(second, link);
    assert_eq!(overview(&db, ada).await.len(), 1);
}

async fn shop_domain(db: &Db, graph: Graph) -> String {
    let mut tx = db.tenant(graph.tenant).await.unwrap();
    db::repo::shopify::get(&mut tx, graph.shop)
        .await
        .unwrap()
        .map(|s| s.shop_domain)
        .unwrap_or_default()
}

#[sqlx::test]
async fn another_organizations_user_sees_nothing_of_a_link_and_cannot_end_it(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let db = Db::from_pool(app_pool(opts, conn).await);
    let a = seed(&db, 1).await;
    let (ada, eve) = (user(&db, "ada").await, user(&db, "eve").await);
    let ada_org = org(&db, ada, "Ada Agency").await;
    let _eve_org = org(&db, eve, "Eve Agency").await;
    let hash = code(&db, ada_org, ada, 3, Duration::days(1)).await;
    let link = approve(&db, a, &hash).await.unwrap();

    assert!(overview(&db, eve).await.is_empty(), "a stranger saw the link");
    let mut tx = db.identity().await.unwrap();
    assert!(
        !agency::unlink(&mut tx, eve, link).await.unwrap(),
        "a stranger ended the link"
    );
    tx.commit().await.unwrap();
    assert_eq!(overview(&db, ada).await.len(), 1, "the link was damaged");

    // A member ends it: effective at once, and the merchant no longer lists it.
    let mut tx = db.identity().await.unwrap();
    assert!(agency::unlink(&mut tx, ada, link).await.unwrap());
    assert!(
        !agency::unlink(&mut tx, ada, link).await.unwrap(),
        "an ended link ended twice"
    );
    tx.commit().await.unwrap();
    assert!(overview(&db, ada).await.is_empty());
    let mut tx = db.tenant(a.tenant).await.unwrap();
    assert!(agency::links_of_shop(&mut tx, a.shop).await.unwrap().is_empty());
}

#[sqlx::test]
async fn codes_work_once_before_they_expire_and_only_for_a_shop_of_the_caller(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let pool = app_pool(opts, conn).await;
    let db = Db::from_pool(pool.clone());
    let (a, b) = (seed(&db, 1).await, seed(&db, 2).await);
    let ada = user(&db, "ada").await;
    let org = org(&db, ada, "Ada Agency").await;

    // Unknown.
    assert_eq!(approve(&db, a, &[7; 32]).await, None, "an unknown code linked");

    // Expired: made already past its time.
    let stale = code(&db, org, ada, 4, Duration::seconds(-5)).await;
    assert_eq!(approve(&db, a, &stale).await, None, "an expired code linked");
    let mut tx = db.tenant(a.tenant).await.unwrap();
    assert!(agency::preview_code(&mut tx, &stale).await.unwrap().is_none());

    // Single use: the second shop to present it gets nothing.
    let hash = code(&db, org, ada, 5, Duration::days(1)).await;
    let mut tx = db.tenant(a.tenant).await.unwrap();
    let seen = agency::preview_code(&mut tx, &hash).await.unwrap().unwrap();
    assert_eq!(seen.organization_name, "Ada Agency");
    tx.rollback().await.unwrap();
    assert!(approve(&db, a, &hash).await.is_some());
    assert_eq!(approve(&db, b, &hash).await, None, "a used code linked twice");
    let mut tx = db.tenant(b.tenant).await.unwrap();
    assert!(
        agency::preview_code(&mut tx, &hash).await.unwrap().is_none(),
        "a used code still previewed"
    );
    tx.rollback().await.unwrap();

    // The function refuses a shop that is not the transaction's tenant: shop B under A's tenant.
    let hash = code(&db, org, ada, 6, Duration::days(1)).await;
    let mut tx = db.tenant(a.tenant).await.unwrap();
    let crossed = agency::approve(&mut tx, b.shop, &hash, Uuid::now_v7()).await;
    assert!(crossed.is_err(), "a tenant granted another tenant's shop");
    drop(tx);
    // Nor can it be passed another tenant's id from inside a tenant transaction.
    let mut raw = pool.begin().await.unwrap();
    sqlx::query("select set_config('app.tenant_id', $1, true)")
        .bind(b.tenant.to_string())
        .execute(&mut *raw)
        .await
        .unwrap();
    let forged: Result<Option<Uuid>, _> =
        sqlx::query_scalar("select agency_approve_link($1, $2, $3, $4)")
            .bind(a.tenant.as_uuid())
            .bind(a.shop.as_uuid())
            .bind(&hash)
            .bind(Uuid::now_v7())
            .fetch_one(&mut *raw)
            .await;
    assert!(forged.is_err(), "a forged tenant argument was accepted");
    drop(raw);
    // Only the one legitimate link (shop A, approved above) exists; the refused grants added none.
    let stores = overview(&db, ada).await;
    assert_eq!(stores.len(), 1, "a refused grant still linked");
    assert_ne!(stores[0].shop_domain, shop_domain(&db, b).await);
}

#[sqlx::test]
async fn the_dashboard_connection_cannot_read_links_or_other_tenants_tables(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let pool = app_pool(opts, conn).await;
    let db = Db::from_pool(pool.clone());
    let a = seed(&db, 1).await;
    let ada = user(&db, "ada").await;
    let org = org(&db, ada, "Ada Agency").await;
    let hash = code(&db, org, ada, 8, Duration::days(1)).await;
    approve(&db, a, &hash).await.unwrap();

    // With no tenant set, the app role's raw reads of every tenant table fail closed: this is
    // the identity transaction's view, and the only way the agency's reads reach a tenant is
    // through `agency_linked_stores`, which starts from live links.
    for table in ["store_links", "findings", "scans", "regressions", "shopify_shops"] {
        let result: Result<i64, _> =
            sqlx::query_scalar(sqlx::AssertSqlSafe(format!("select count(*) from {table}")))
                .fetch_one(&pool)
                .await;
        assert!(result.is_err(), "{table} answered a read with no tenant set");
    }

    // The overview function returns nothing for an id that is in no organization.
    assert!(overview(&db, UserId::new()).await.is_empty());
}

#[sqlx::test]
async fn one_tenant_cannot_list_or_revoke_another_tenants_links(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let db = Db::from_pool(app_pool(opts, conn).await);
    let (a, b) = (seed(&db, 1).await, seed(&db, 2).await);
    let ada = user(&db, "ada").await;
    let org = org(&db, ada, "Ada Agency").await;
    let link = approve(&db, a, &code(&db, org, ada, 9, Duration::days(1)).await)
        .await
        .unwrap();

    let mut tx = db.tenant(b.tenant).await.unwrap();
    assert!(agency::links_of_shop(&mut tx, b.shop).await.unwrap().is_empty());
    assert!(
        !agency::revoke(&mut tx, b.shop, link).await.unwrap(),
        "tenant B revoked tenant A's link"
    );
    assert!(
        !agency::revoke(&mut tx, a.shop, link).await.unwrap(),
        "tenant B revoked it by naming A's shop"
    );
    tx.commit().await.unwrap();
    assert_eq!(overview(&db, ada).await.len(), 1, "the link did not survive");
}
