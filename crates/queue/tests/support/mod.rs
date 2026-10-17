//! Pools for the queue tests (ADR-015): the worker role claims across tenants, the app role
//! only enqueues for its own tenant, and the owner can move time by editing leases.

#![allow(dead_code, unreachable_pub, clippy::missing_panics_doc)]
#![allow(clippy::unwrap_used, clippy::expect_used)]

use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::{Executor, PgPool};

async fn pool_as(role: &'static str, opts: PgPoolOptions, conn: PgConnectOptions) -> PgPool {
    opts.after_connect(move |c, _| {
        Box::pin(async move {
            c.execute(sqlx::AssertSqlSafe(format!("set role {role}")))
                .await?;
            Ok(())
        })
    })
    .connect_with(conn)
    .await
    .expect("connect")
}

pub async fn worker_pool(opts: PgPoolOptions, conn: PgConnectOptions) -> PgPool {
    pool_as("rampsmith_worker", opts, conn).await
}

pub async fn app_pool(opts: PgPoolOptions, conn: PgConnectOptions) -> PgPool {
    pool_as("rampsmith_app", opts, conn).await
}

pub async fn owner_pool(opts: PgPoolOptions, conn: PgConnectOptions) -> PgPool {
    opts.connect_with(conn).await.expect("connect")
}

/// Ends every running lease now, as if its worker died.
pub async fn expire_leases(owner: &PgPool) {
    sqlx::query(
        "update jobs set locked_until = now() - interval '1 second' where state = 'running'",
    )
    .execute(owner)
    .await
    .unwrap();
}

/// Inserts a tenant row as the owner, for jobs that reference one.
pub async fn tenant(owner: &PgPool) -> uuid::Uuid {
    let id = uuid::Uuid::now_v7();
    sqlx::query("insert into tenants (id, kind) values ($1, 'organization')")
        .bind(id)
        .execute(owner)
        .await
        .unwrap();
    id
}

/// Asserts that a listing is empty, printing what it held otherwise.
#[track_caller]
pub fn assert_empty<T: std::fmt::Debug>(items: &[T]) {
    assert!(items.is_empty(), "expected nothing, got {items:?}");
}
