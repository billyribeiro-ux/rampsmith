//! The per-shop token lock (audit M5, ADR-041): in-process single flight, a bounded wait in
//! the database, and one pool connection per holder.

// Integration tests are test code: PLAN §8 denies these lints outside tests only.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod support;

use std::time::{Duration, Instant};

use db::repo::tenants;
use db::{Db, DbError};
use domain::{TenantId, TenantKind};
use sqlx::PgPool;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use support::app_pool;

const SHOP: &str = "lock-test.myshopify.com";

async fn small_db(opts: PgPoolOptions, conn: PgConnectOptions, connections: u32) -> (Db, PgPool) {
    let pool = app_pool(opts.max_connections(connections), conn).await;
    (Db::from_pool(pool.clone()), pool)
}

fn in_use(pool: &PgPool) -> usize {
    pool.size() as usize - pool.num_idle()
}

#[sqlx::test]
async fn a_second_holder_in_the_same_process_waits_without_a_connection(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let (db, pool) = small_db(opts, conn, 3).await;
    let first = db.shop_lock(SHOP).await.unwrap();

    // Ten more requests for the same shop queue up in the process, not in the pool.
    let waiters: Vec<_> = (0..10)
        .map(|_| {
            let db = db.clone();
            tokio::spawn(async move { db.shop_lock(SHOP).await.unwrap().release().await })
        })
        .collect();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(in_use(&pool), 1, "only the holder may hold a connection");
    db.ping().await.unwrap();

    first.release().await.unwrap();
    for waiter in waiters {
        waiter.await.unwrap().unwrap();
    }
}

#[sqlx::test]
async fn different_shops_do_not_wait_for_each_other(opts: PgPoolOptions, conn: PgConnectOptions) {
    let (db, _) = small_db(opts, conn, 4).await;
    let a = db.shop_lock("a-shop.myshopify.com").await.unwrap();
    let started = Instant::now();
    let b = db.shop_lock("b-shop.myshopify.com").await.unwrap();
    assert!(started.elapsed() < Duration::from_secs(1));
    a.release().await.unwrap();
    b.release().await.unwrap();
}

#[sqlx::test]
async fn lock_holders_never_take_more_than_half_the_pool(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    // Four connections: two shops may hold locks; a third waits for a permit, and the other
    // two connections keep serving everyone else.
    let (db, pool) = small_db(opts, conn, 4).await;
    let a = db.shop_lock("a-shop.myshopify.com").await.unwrap();
    let b = db.shop_lock("b-shop.myshopify.com").await.unwrap();
    let third = tokio::time::timeout(
        Duration::from_millis(300),
        db.shop_lock("c-shop.myshopify.com"),
    )
    .await;
    assert!(third.is_err(), "a third holder must wait for a permit");
    assert_eq!(in_use(&pool), 2);
    db.ping().await.unwrap();
    db.ping().await.unwrap();

    a.release().await.unwrap();
    let c = db.shop_lock("c-shop.myshopify.com").await.unwrap();
    c.release().await.unwrap();
    b.release().await.unwrap();
}

/// Another process (here: a second `Db` with its own in-process queue) holds the lock. The
/// wait is bounded by the database, and the connection goes back to the pool unharmed.
#[sqlx::test]
async fn a_lock_held_elsewhere_times_out_instead_of_waiting_forever(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let (holder, _) = small_db(opts.clone(), conn.clone(), 3).await;
    let (waiter, waiter_pool) = small_db(opts, conn, 3).await;
    let waiter = waiter.with_lock_timeout(Duration::from_millis(300));

    let held = holder.shop_lock(SHOP).await.unwrap();
    let started = Instant::now();
    let error = waiter.shop_lock(SHOP).await.unwrap_err();
    assert!(matches!(error, DbError::LockTimeout), "{error:?}");
    assert!(started.elapsed() < Duration::from_secs(5));
    // A returned connection reaches the idle list a moment later.
    for _ in 0..40 {
        if in_use(&waiter_pool) == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(in_use(&waiter_pool), 0, "the connection was returned");
    waiter.ping().await.unwrap();

    // Once the holder is done, the same waiter gets the lock.
    held.release().await.unwrap();
    waiter
        .shop_lock(SHOP)
        .await
        .unwrap()
        .release()
        .await
        .unwrap();
}

/// The re-check and the store happen on the lock's own connection: one holder, one connection.
#[sqlx::test]
async fn the_lock_converts_into_a_tenant_transaction_on_the_same_connection(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let (db, pool) = small_db(opts, conn, 2).await;
    let mut lock = db.shop_lock(SHOP).await.unwrap();
    assert!(lock.shop_by_domain(SHOP).await.unwrap().is_none());

    let tenant = TenantId::new();
    let mut tx = lock.into_tenant(tenant).await.unwrap();
    assert_eq!(tx.tenant_id(), tenant);
    tenants::create(&mut tx, TenantKind::ShopifyStore)
        .await
        .unwrap();
    assert_eq!(
        in_use(&pool),
        1,
        "lock and tenant work share one connection"
    );

    // Still locked: another process cannot take the lock until this transaction ends.
    let other = Db::from_pool(pool.clone());
    let blocked = other
        .with_lock_timeout(Duration::from_millis(200))
        .shop_lock(SHOP)
        .await;
    assert!(matches!(blocked, Err(DbError::LockTimeout)));

    tx.commit().await.unwrap();
    db.shop_lock(SHOP).await.unwrap().release().await.unwrap();
    let mut check = db.tenant(tenant).await.unwrap();
    assert!(tenants::get(&mut check).await.unwrap().is_some());
}
