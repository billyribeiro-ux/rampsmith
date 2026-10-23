//! The runtime role guard (audit M4, ADR-040), against real PostgreSQL roles.
//!
//! Every test connects as a role it created, because the guard looks at who the database
//! says the session is, not at what the test says it is.

// Integration tests are test code: PLAN §8 denies these lints outside tests only.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod support;

use db::{Db, RoleError, RoleViolation, RuntimeRole};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::{Executor, PgPool};
use support::{create_login_role, drop_role, owner_pool, pool_as};

async fn verify(pool: PgPool, role: RuntimeRole) -> Result<(), RoleError> {
    Db::from_pool(pool).verify_runtime_role(role).await
}

fn violations(result: Result<(), RoleError>) -> Vec<RoleViolation> {
    match result {
        Err(RoleError::Refused { violations, .. }) => violations,
        other => panic!("expected a refusal, got {other:?}"),
    }
}

#[sqlx::test(migrations = "./migrations")]
async fn a_login_member_of_rampsmith_app_may_run_the_api(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let owner = owner_pool(opts.clone(), conn.clone()).await;
    create_login_role(&owner, "rs_guard_app_ok", "in role rampsmith_app").await;
    let pool = pool_as(&opts, &conn, "rs_guard_app_ok").await;
    verify(pool.clone(), RuntimeRole::App).await.unwrap();
    // And it can really work as the application: the group's privileges are inherited.
    let version: Option<i64> = sqlx::query_scalar("select app_schema_version()")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(version, Some(db::expected_schema_version()));
    drop_role(&owner, "rs_guard_app_ok").await;
}

#[sqlx::test(migrations = "./migrations")]
async fn a_login_member_of_rampsmith_worker_may_run_ctl(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let owner = owner_pool(opts.clone(), conn.clone()).await;
    create_login_role(&owner, "rs_guard_worker_ok", "in role rampsmith_worker").await;
    let pool = pool_as(&opts, &conn, "rs_guard_worker_ok").await;
    verify(pool, RuntimeRole::Worker).await.unwrap();
    drop_role(&owner, "rs_guard_worker_ok").await;
}

/// `ctl` redacts through `redact_ai_calls()`, by membership of `rampsmith_redactor`; nobody
/// else may (ADR-089). In production ctl's login is `rampsmith_ctl`, a member of both groups.
#[sqlx::test(migrations = "./migrations")]
async fn only_ctls_login_may_execute_the_redaction_function(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let owner = owner_pool(opts.clone(), conn.clone()).await;
    create_login_role(
        &owner,
        "rs_guard_ctl_ok",
        "in role rampsmith_worker, rampsmith_redactor",
    )
    .await;
    create_login_role(&owner, "rs_guard_ctl_plain", "in role rampsmith_worker").await;
    create_login_role(
        &owner,
        "rs_guard_app_redacts",
        "in role rampsmith_app, rampsmith_redactor",
    )
    .await;
    let ctl = pool_as(&opts, &conn, "rs_guard_ctl_ok").await;
    let plain = pool_as(&opts, &conn, "rs_guard_ctl_plain").await;
    let app = pool_as(&opts, &conn, "rs_guard_app_redacts").await;

    verify(ctl.clone(), RuntimeRole::Ctl).await.unwrap();
    // The engine's profile: a worker that can also redact is refused.
    assert_eq!(
        violations(verify(ctl, RuntimeRole::Worker).await),
        [RoleViolation::CanRedact]
    );
    // A plain worker login is fine for the engine and unfit for ctl, which could never redact.
    verify(plain.clone(), RuntimeRole::Worker).await.unwrap();
    assert_eq!(
        violations(verify(plain, RuntimeRole::Ctl).await),
        [RoleViolation::CannotRedact]
    );
    // The api never redacts.
    assert!(violations(verify(app, RuntimeRole::App).await).contains(&RoleViolation::CanRedact));
    for name in [
        "rs_guard_ctl_ok",
        "rs_guard_ctl_plain",
        "rs_guard_app_redacts",
    ] {
        drop_role(&owner, name).await;
    }
}

#[sqlx::test(migrations = "./migrations")]
async fn the_two_application_roles_are_not_interchangeable(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let owner = owner_pool(opts.clone(), conn.clone()).await;
    create_login_role(&owner, "rs_guard_swap_app", "in role rampsmith_app").await;
    create_login_role(&owner, "rs_guard_swap_worker", "in role rampsmith_worker").await;
    let app = pool_as(&opts, &conn, "rs_guard_swap_app").await;
    let worker = pool_as(&opts, &conn, "rs_guard_swap_worker").await;
    assert_eq!(
        violations(verify(app, RuntimeRole::Worker).await),
        [RoleViolation::NotMember("rampsmith_worker")]
    );
    assert_eq!(
        violations(verify(worker, RuntimeRole::App).await),
        [
            RoleViolation::NotMember("rampsmith_app"),
            RoleViolation::AlsoMember("rampsmith_worker")
        ]
    );
    drop_role(&owner, "rs_guard_swap_app").await;
    drop_role(&owner, "rs_guard_swap_worker").await;
}

#[sqlx::test(migrations = "./migrations")]
async fn a_superuser_is_refused(opts: PgPoolOptions, conn: PgConnectOptions) {
    let owner = owner_pool(opts, conn).await;
    for role in [RuntimeRole::App, RuntimeRole::Worker] {
        let found = violations(verify(owner.clone(), role).await);
        assert!(found.contains(&RoleViolation::Superuser), "{found:?}");
        assert!(found.contains(&RoleViolation::BypassRls), "{found:?}");
    }
}

/// `SET ROLE rampsmith_app` from a superuser login looks right to `current_user`, but the
/// session can undo it with `RESET ROLE`, so it is no isolation at all.
#[sqlx::test(migrations = "./migrations")]
async fn a_superuser_session_that_switched_role_is_refused(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let pool = opts
        .after_connect(|c, _| {
            Box::pin(async move {
                c.execute("set role rampsmith_app").await?;
                Ok(())
            })
        })
        .connect_with(conn)
        .await
        .unwrap();
    let found = violations(verify(pool, RuntimeRole::App).await);
    assert!(
        found.contains(&RoleViolation::SessionSuperuser),
        "{found:?}"
    );
    assert!(
        found.contains(&RoleViolation::SessionBypassRls),
        "{found:?}"
    );
}

#[sqlx::test(migrations = "./migrations")]
async fn a_role_with_bypassrls_is_refused(opts: PgPoolOptions, conn: PgConnectOptions) {
    let owner = owner_pool(opts.clone(), conn.clone()).await;
    create_login_role(&owner, "rs_guard_bypass", "bypassrls in role rampsmith_app").await;
    let pool = pool_as(&opts, &conn, "rs_guard_bypass").await;
    assert_eq!(
        violations(verify(pool, RuntimeRole::App).await),
        [RoleViolation::BypassRls]
    );
    drop_role(&owner, "rs_guard_bypass").await;
}

#[sqlx::test(migrations = "./migrations")]
async fn a_table_owner_is_refused(opts: PgPoolOptions, conn: PgConnectOptions) {
    let owner = owner_pool(opts.clone(), conn.clone()).await;
    create_login_role(&owner, "rs_guard_owner", "in role rampsmith_app").await;
    owner
        .execute("alter table sites owner to rs_guard_owner")
        .await
        .unwrap();
    let pool = pool_as(&opts, &conn, "rs_guard_owner").await;
    let found = violations(verify(pool, RuntimeRole::App).await);
    // Owning `sites` brings its indexes and sequences along; the count is not the point.
    assert!(
        matches!(found.as_slice(), [RoleViolation::OwnsRelations(n)] if *n >= 1),
        "{found:?}"
    );
    drop_role(&owner, "rs_guard_owner").await;
}

#[sqlx::test(migrations = "./migrations")]
async fn the_owner_of_the_database_is_refused(opts: PgPoolOptions, conn: PgConnectOptions) {
    let owner = owner_pool(opts.clone(), conn.clone()).await;
    create_login_role(&owner, "rs_guard_dbowner", "in role rampsmith_app").await;
    let database: String = sqlx::query_scalar("select current_database()::text")
        .fetch_one(&owner)
        .await
        .unwrap();
    owner
        .execute(sqlx::AssertSqlSafe(format!(
            "alter database \"{database}\" owner to rs_guard_dbowner"
        )))
        .await
        .unwrap();
    let pool = pool_as(&opts, &conn, "rs_guard_dbowner").await;
    let found = violations(verify(pool, RuntimeRole::App).await);
    assert!(found.contains(&RoleViolation::OwnsDatabase), "{found:?}");
    owner
        .execute(sqlx::AssertSqlSafe(format!(
            "alter database \"{database}\" owner to current_user"
        )))
        .await
        .unwrap();
    drop_role(&owner, "rs_guard_dbowner").await;
}

#[sqlx::test(migrations = "./migrations")]
async fn a_role_that_can_create_objects_in_public_is_refused(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let owner = owner_pool(opts.clone(), conn.clone()).await;
    create_login_role(&owner, "rs_guard_create", "in role rampsmith_app").await;
    owner
        .execute("grant create on schema public to rs_guard_create")
        .await
        .unwrap();
    let pool = pool_as(&opts, &conn, "rs_guard_create").await;
    assert_eq!(
        violations(verify(pool, RuntimeRole::App).await),
        [RoleViolation::CanCreateInPublic]
    );
    drop_role(&owner, "rs_guard_create").await;
}

#[sqlx::test(migrations = "./migrations")]
async fn a_member_that_does_not_inherit_the_groups_privileges_is_refused(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let owner = owner_pool(opts.clone(), conn.clone()).await;
    create_login_role(
        &owner,
        "rs_guard_noinherit",
        "noinherit in role rampsmith_app",
    )
    .await;
    let pool = pool_as(&opts, &conn, "rs_guard_noinherit").await;
    assert_eq!(
        violations(verify(pool, RuntimeRole::App).await),
        [RoleViolation::NotMember("rampsmith_app")]
    );
    drop_role(&owner, "rs_guard_noinherit").await;
}

/// Permissive policies combine with OR: an api login that is also a worker would read every
/// tenant's jobs through `workers_see_every_job`.
#[sqlx::test(migrations = "./migrations")]
async fn an_api_login_that_is_also_a_worker_is_refused(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let owner = owner_pool(opts.clone(), conn.clone()).await;
    create_login_role(
        &owner,
        "rs_guard_both",
        "in role rampsmith_app, rampsmith_worker",
    )
    .await;
    let pool = pool_as(&opts, &conn, "rs_guard_both").await;
    assert_eq!(
        violations(verify(pool.clone(), RuntimeRole::App).await),
        [RoleViolation::AlsoMember("rampsmith_worker")]
    );
    verify(pool, RuntimeRole::Worker).await.unwrap();
    drop_role(&owner, "rs_guard_both").await;
}

#[sqlx::test(migrations = "./migrations")]
async fn the_refusal_lists_every_problem_and_names_the_role(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let owner = owner_pool(opts, conn).await;
    let error = verify(owner, RuntimeRole::App).await.unwrap_err();
    let message = error.to_string();
    assert!(message.contains("superuser"), "{message}");
    assert!(message.contains("BYPASSRLS"), "{message}");
    assert!(message.contains("postgres"), "{message}");
}

#[tokio::test]
async fn an_unreachable_database_is_not_a_refusal() {
    let pool = PgPoolOptions::new()
        .acquire_timeout(std::time::Duration::from_millis(300))
        .connect_lazy("postgres://nobody@127.0.0.1:9/none")
        .unwrap();
    let error = verify(pool, RuntimeRole::App).await.unwrap_err();
    assert!(matches!(error, RoleError::Unreachable(_)), "{error:?}");
}
