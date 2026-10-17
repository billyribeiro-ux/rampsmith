//! The cross-tenant isolation suite (PLAN §9, §23; ADR-006, ADR-017).
//!
//! Two tenants, each with a full graph of rows. Every assertion checks that tenant A can
//! neither read nor write tenant B's rows, through three independent layers: repository
//! scoping, row-level security, and composite tenant foreign keys.

// Integration tests are test code: PLAN §8 denies these lints outside tests only.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod support;

use db::Db;
use db::repo::{audit, findings, fixes, occurrences, scans, sites, tenants};
use domain::{FindingStatus, TenantId, UserId};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::{PgPool, Row};
use support::{Graph, app_pool, assert_empty, owner_pool, seed};

async fn two_tenants(opts: PgPoolOptions, conn: PgConnectOptions) -> (Db, PgPool, Graph, Graph) {
    let pool = app_pool(opts, conn).await;
    let db = Db::from_pool(pool.clone());
    let a = seed(&db, 1).await;
    let b = seed(&db, 2).await;
    (db, pool, a, b)
}

// --- Layer 0: the schema itself -------------------------------------------------------

#[sqlx::test]
async fn every_table_with_a_tenant_column_has_row_level_security_and_a_policy(pool: PgPool) {
    let unprotected: Vec<String> = sqlx::query_scalar(
        "select c.relname::text
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public'
            and c.relkind in ('r', 'p')
            and (exists (select 1 from pg_attribute a
                          where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped)
                 or c.relname = 'tenants')
            and (not c.relrowsecurity
                 or not exists (select 1 from pg_policy p where p.polrelid = c.oid))
          order by 1",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert!(
        unprotected.is_empty(),
        "tables without row-level security: {unprotected:?}"
    );
}

#[sqlx::test]
async fn tenant_columns_are_never_nullable(pool: PgPool) {
    let nullable: Vec<String> = sqlx::query_scalar(
        "select table_name::text from information_schema.columns
          where table_schema = 'public' and column_name = 'tenant_id'
            and is_nullable = 'YES' and table_name <> 'jobs'
          order by 1",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert!(nullable.is_empty(), "nullable tenant_id in {nullable:?}");
}

#[sqlx::test]
async fn application_roles_cannot_bypass_row_level_security(pool: PgPool) {
    for role in ["rampsmith_app", "rampsmith_worker"] {
        let row = sqlx::query(
            "select rolsuper, rolbypassrls, rolcanlogin from pg_roles where rolname = $1",
        )
        .bind(role)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(!row.get::<bool, _>("rolsuper"), "{role} is a superuser");
        assert!(!row.get::<bool, _>("rolbypassrls"), "{role} has BYPASSRLS");
        assert!(
            !row.get::<bool, _>("rolcanlogin"),
            "{role} must be a group role"
        );
        let owned: i64 = sqlx::query_scalar(
            "select count(*) from pg_class where relowner = (select oid from pg_roles where rolname = $1)",
        )
        .bind(role)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(owned, 0, "{role} owns relations");
    }
}

// --- Layer 1: repository scoping --------------------------------------------------------

async fn assert_repositories_isolate(db: &Db, a: Graph, b: Graph) {
    let mut tx = db.tenant(a.tenant).await.unwrap();

    assert_eq!(
        tenants::get(&mut tx).await.unwrap().map(|t| t.id),
        Some(a.tenant)
    );

    assert!(sites::get(&mut tx, b.site).await.unwrap().is_none());
    assert_eq!(
        sites::list(&mut tx)
            .await
            .unwrap()
            .iter()
            .map(|s| s.id)
            .collect::<Vec<_>>(),
        vec![a.site]
    );

    assert!(scans::get(&mut tx, b.scan).await.unwrap().is_none());
    assert_empty(&scans::list_for_site(&mut tx, b.site, 10).await.unwrap());
    assert!(
        scans::mark_started(&mut tx, b.scan, 5)
            .await
            .unwrap()
            .is_none()
    );

    assert!(findings::get(&mut tx, b.finding).await.unwrap().is_none());
    assert_empty(
        &findings::list_for_site(&mut tx, b.site, None)
            .await
            .unwrap(),
    );
    assert!(
        findings::set_status(&mut tx, b.finding, FindingStatus::FalsePositive)
            .await
            .unwrap()
            .is_none()
    );

    assert_empty(
        &occurrences::list_for_finding(&mut tx, b.finding, 10)
            .await
            .unwrap(),
    );

    assert!(fixes::get(&mut tx, b.fix).await.unwrap().is_none());
    assert_empty(&fixes::list_for_finding(&mut tx, b.finding).await.unwrap());
    assert!(
        fixes::approve(&mut tx, b.fix, UserId::new())
            .await
            .unwrap()
            .is_none()
    );

    let entries = audit::list(&mut tx, 100).await.unwrap();
    assert!(entries.iter().all(|e| e.subject_id != b.fix.as_uuid()));
    assert_eq!(entries.len(), 1);
    tx.rollback().await.unwrap();

    // Tenant B's rows are untouched by tenant A's attempted writes.
    let mut tx = db.tenant(b.tenant).await.unwrap();
    assert_eq!(
        scans::get(&mut tx, b.scan).await.unwrap().unwrap().status,
        domain::ScanStatus::Queued
    );
    assert_eq!(
        findings::get(&mut tx, b.finding)
            .await
            .unwrap()
            .unwrap()
            .status,
        FindingStatus::Open
    );
    assert_eq!(
        fixes::get(&mut tx, b.fix).await.unwrap().unwrap().status,
        domain::FixStatus::Proposed
    );
}

#[sqlx::test]
async fn repositories_return_nothing_across_the_boundary(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let (db, _, a, b) = two_tenants(opts, conn).await;
    assert_repositories_isolate(&db, a, b).await;
}

/// The superuser bypasses row-level security, so this proves the repositories' own tenant
/// filters hold on their own, independently of layer 2.
#[sqlx::test]
async fn repository_scoping_holds_even_without_row_level_security(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let db = Db::from_pool(owner_pool(opts, conn).await);
    let a = seed(&db, 1).await;
    let b = seed(&db, 2).await;
    assert_repositories_isolate(&db, a, b).await;
}

#[sqlx::test]
async fn writes_cannot_point_at_another_tenants_rows(opts: PgPoolOptions, conn: PgConnectOptions) {
    let (db, _, a, b) = two_tenants(opts, conn).await;
    let mut tx = db.tenant(a.tenant).await.unwrap();
    let err = scans::create(
        &mut tx,
        &scans::NewScan {
            site_id: b.site,
            trigger: domain::ScanTrigger::Manual,
            ruleset_version: "x".to_owned(),
            theme_ref: None,
        },
    )
    .await;
    assert!(err.is_err(), "a scan for another tenant's site was created");
}

// --- Layer 2: row-level security, bypassing the repositories -----------------------------

const TENANT_TABLES: [&str; 10] = [
    "tenants",
    "sites",
    "shopify_shops",
    "shopify_tokens",
    "scans",
    "findings",
    "finding_occurrences",
    "fixes",
    "fix_findings",
    "audit_log",
];

#[sqlx::test]
async fn row_level_security_hides_other_tenants_rows_from_raw_sql(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let (_, pool, a, b) = two_tenants(opts, conn).await;
    for (me, other) in [(a, b), (b, a)] {
        let mut tx = pool.begin().await.unwrap();
        sqlx::query("select set_config('app.tenant_id', $1, true)")
            .bind(me.tenant.to_string())
            .execute(&mut *tx)
            .await
            .unwrap();
        for table in TENANT_TABLES {
            let column = if table == "tenants" {
                "id"
            } else {
                "tenant_id"
            };
            let foreign: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
                "select count(*) from {table} where {column} <> $1"
            )))
            .bind(me.tenant.as_uuid())
            .fetch_one(&mut *tx)
            .await
            .unwrap();
            assert_eq!(
                foreign, 0,
                "{table}: saw {foreign} rows of tenant {}",
                other.tenant
            );
        }
        tx.rollback().await.unwrap();
    }
}

#[sqlx::test]
async fn queries_without_a_tenant_fail_instead_of_returning_rows(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let (_, pool, _, _) = two_tenants(opts, conn).await;
    for table in TENANT_TABLES {
        let result: Result<i64, _> =
            sqlx::query_scalar(sqlx::AssertSqlSafe(format!("select count(*) from {table}")))
                .fetch_one(&pool)
                .await;
        assert!(result.is_err(), "{table} answered an unscoped query");
    }
}

#[sqlx::test]
async fn row_level_security_rejects_inserts_for_another_tenant(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let (_, pool, a, b) = two_tenants(opts, conn).await;
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("select set_config('app.tenant_id', $1, true)")
        .bind(a.tenant.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    let result = sqlx::query(
        "insert into sites (id, tenant_id, platform, base_url) values ($1, $2, 'generic', 'https://x.example')",
    )
    .bind(domain::SiteId::new().as_uuid())
    .bind(b.tenant.as_uuid())
    .execute(&mut *tx)
    .await;
    let err = result.expect_err("insert for another tenant succeeded");
    assert!(err.to_string().contains("row-level security"), "{err}");
}

#[sqlx::test]
async fn row_level_security_blocks_updates_and_deletes_of_other_tenants_rows(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let (_, pool, a, b) = two_tenants(opts, conn).await;
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("select set_config('app.tenant_id', $1, true)")
        .bind(a.tenant.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    let updated = sqlx::query("update findings set status = 'fixed' where id = $1")
        .bind(b.finding.as_uuid())
        .execute(&mut *tx)
        .await
        .unwrap();
    assert_eq!(updated.rows_affected(), 0);
    let deleted = sqlx::query("delete from fix_findings where fix_id = $1")
        .bind(b.fix.as_uuid())
        .execute(&mut *tx)
        .await
        .unwrap();
    assert_eq!(deleted.rows_affected(), 0);
}

// --- Layer 3: composite tenant foreign keys, checked even for the owner --------------------

#[sqlx::test]
async fn composite_foreign_keys_reject_cross_tenant_references_even_for_the_owner(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let app = app_pool(opts.clone(), conn.clone()).await;
    let db = Db::from_pool(app);
    let a = seed(&db, 1).await;
    let b = seed(&db, 2).await;
    let owner = owner_pool(opts, conn).await;

    let cases = [
        (
            "scans",
            "insert into scans (id, tenant_id, site_id, trigger, status, ruleset_version) values (gen_random_uuid(), $1, $2, 'manual', 'queued', 'x')",
            b.site.as_uuid(),
        ),
        (
            "fix_findings",
            "insert into fix_findings (fix_id, finding_id, tenant_id) values ((select id from fixes where tenant_id = $1), $2, $1)",
            b.finding.as_uuid(),
        ),
        (
            "findings",
            "insert into findings (id, tenant_id, site_id, fingerprint, rule_id, criteria, impact, status, first_seen_scan, last_seen_scan, occurrence_count) values (gen_random_uuid(), $1, (select id from sites where tenant_id = $1), decode(repeat('ab', 32), 'hex'), 'r', '{}', 'minor', 'open', $2, $2, 1)",
            b.scan.as_uuid(),
        ),
    ];
    for (table, sql, foreign_id) in cases {
        let result = sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind(a.tenant.as_uuid())
            .bind(foreign_id)
            .execute(&owner)
            .await;
        let err = result.expect_err(table);
        assert!(err.to_string().contains("foreign key"), "{table}: {err}");
    }
}

#[sqlx::test]
async fn creating_a_tenant_uses_the_transactions_own_id(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let db = Db::from_pool(app_pool(opts, conn).await);
    let mut tx = db.tenant(TenantId::new()).await.unwrap();
    let created = tenants::create(&mut tx, domain::TenantKind::Organization)
        .await
        .unwrap();
    assert_eq!(created.id, tx.tenant_id());
}
