//! Shared fixtures for the ctl tests.
//!
//! `ctl` refuses to run as a superuser, a `BYPASSRLS` role or a table owner (ADR-040), so
//! these tests connect the way a deployment does: as a `LOGIN` role that is a member of
//! `rampsmith_worker`. Roles are cluster-wide and the test binaries run in parallel, so the
//! login is created once, tolerating a concurrent creation, and left in place; it owns
//! nothing and its password is public.

#![allow(dead_code, unreachable_pub, clippy::missing_panics_doc)]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::time::Duration;

use sqlx::PgPool;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};

/// The `LOGIN` member of `rampsmith_ctl` (and through it of `rampsmith_worker`) the tests
/// connect as.
pub const WORKER_LOGIN: &str = "rampsmith_test_ctl_login";
const PASSWORD: &str = "rampsmith-test-only";

/// Makes sure `WORKER_LOGIN` exists and is a member of `rampsmith_worker`.
async fn ensure_worker_login(opts: &PgPoolOptions, conn: &PgConnectOptions) {
    let admin = opts
        .clone()
        .max_connections(1)
        .connect_with(conn.clone())
        .await
        .expect("connect as the test superuser");
    for attempt in 0..20_u64 {
        let _ = sqlx::query(sqlx::AssertSqlSafe(format!(
            "do $$ begin
               create role {WORKER_LOGIN} login password '{PASSWORD}' in role rampsmith_ctl;
             exception when duplicate_object or unique_violation then null;
             end $$"
        )))
        .execute(&admin)
        .await;
        let ready: bool = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
            "select coalesce((select pg_has_role(rolname, 'rampsmith_worker', 'usage')
                                from pg_roles where rolname = '{WORKER_LOGIN}'), false)"
        )))
        .fetch_one(&admin)
        .await
        .unwrap_or(false);
        if ready {
            return;
        }
        // A concurrent creation may still be in flight ("tuple concurrently updated").
        tokio::time::sleep(Duration::from_millis(50 * (attempt + 1))).await;
    }
    panic!("could not create the {WORKER_LOGIN} test role");
}

/// A pool connected as a `LOGIN` member of `rampsmith_worker`, with nothing switched afterwards.
pub async fn worker_login_pool(opts: PgPoolOptions, conn: PgConnectOptions) -> PgPool {
    ensure_worker_login(&opts, &conn).await;
    opts.max_connections(8)
        .connect_with(conn.username(WORKER_LOGIN).password(PASSWORD))
        .await
        .expect("connect as the worker login")
}

pub mod world;
