//! Shared fixtures for the api tests.
//!
//! The api refuses to serve as a superuser, a `BYPASSRLS` role or a table owner (ADR-040), so
//! these tests connect the way a deployment does: as a `LOGIN` role that is a member of
//! `rampsmith_app`. Roles are cluster-wide and the test binaries run in parallel, so the
//! login is created once, tolerating a concurrent creation, and left in place; it owns
//! nothing and its password is public.

#![allow(dead_code, unreachable_pub, clippy::missing_panics_doc)]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::time::Duration;

use sqlx::PgPool;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};

/// The `LOGIN` member of `rampsmith_app` the tests connect as.
pub const APP_LOGIN: &str = "rampsmith_test_api_login";
const PASSWORD: &str = "rampsmith-test-only";

/// Makes sure `APP_LOGIN` exists and is a member of `rampsmith_app`.
async fn ensure_app_login(opts: &PgPoolOptions, conn: &PgConnectOptions) {
    let admin = opts
        .clone()
        .max_connections(1)
        .connect_with(conn.clone())
        .await
        .expect("connect as the test superuser");
    for attempt in 0..20_u64 {
        let _ = sqlx::query(sqlx::AssertSqlSafe(format!(
            "do $$ begin
               create role {APP_LOGIN} login password '{PASSWORD}' in role rampsmith_app;
             exception when duplicate_object or unique_violation then null;
             end $$"
        )))
        .execute(&admin)
        .await;
        let ready: bool = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
            "select coalesce((select pg_has_role(rolname, 'rampsmith_app', 'usage')
                                from pg_roles where rolname = '{APP_LOGIN}'), false)"
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
    panic!("could not create the {APP_LOGIN} test role");
}

/// A pool connected as a `LOGIN` member of `rampsmith_app`, with nothing switched afterwards.
pub async fn app_login_pool(opts: PgPoolOptions, conn: PgConnectOptions) -> PgPool {
    ensure_app_login(&opts, &conn).await;
    opts.connect_with(conn.username(APP_LOGIN).password(PASSWORD))
        .await
        .expect("connect as the application login")
}
