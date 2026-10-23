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
use db::repo::webhooks::{self, NewWebhook, Recorded};
use db::repo::{
    app_views, audit, data_fixes, email, findings, fixes, jobs, occurrences, redact, retention,
    scan_inputs, scan_secrets, scans, shop_billing, shopify, sites, tenants,
};
use domain::{FindingStatus, TenantId, UserId};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::{PgPool, Row};
use support::{
    Graph, app_pool, assert_empty, ctl_pool, owner_pool, sealed_tokens, seed, worker_pool,
};

/// One job for each tenant, enqueued through the repository, and one system job with no tenant,
/// which only workers may see (`jobs` is a tenant table with per-role policies, ADR-003).
async fn seed_jobs(db: &Db, owner: &PgPool, tenants: [Graph; 2]) {
    for graph in tenants {
        let mut tx = db.tenant(graph.tenant).await.unwrap();
        jobs::enqueue(
            &mut tx,
            queue::NewJob::new(
                "scan.plan",
                "scan.plan@1",
                serde_json::json!({ "scan": graph.scan.to_string() }),
            ),
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
    }
    let system = queue::NewJob::new(
        "system.retention",
        "system.retention@1",
        serde_json::json!({}),
    );
    let mut conn = owner.acquire().await.unwrap();
    queue::enqueue(&mut conn, &system).await.unwrap();
}

/// One row of every table the R1 pipeline added (ADR-037), written as the application role
/// scoped to the tenant, so the visibility checks below are not satisfied by empty tables.
async fn seed_r1(pool: &PgPool, graph: Graph) {
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("select set_config('app.tenant_id', $1, true)")
        .bind(graph.tenant.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    let evidence = uuid::Uuid::now_v7();
    sqlx::query(
        "insert into scan_inputs (id, tenant_id, scan_id, site_id, kind, seq, payload)
         values (gen_random_uuid(), $1, $2, $3, 'products', 0, '{}')",
    )
    .bind(graph.tenant.as_uuid())
    .bind(graph.scan.as_uuid())
    .bind(graph.site.as_uuid())
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query(
        "insert into evidence (id, tenant_id, scan_id, finding_id, content_type, bytes)
         values ($1, $2, $3, $4, 'image/png', '\\x89504e47')",
    )
    .bind(evidence)
    .bind(graph.tenant.as_uuid())
    .bind(graph.scan.as_uuid())
    .bind(graph.finding.as_uuid())
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query("update fixes set before_evidence_id = $1 where id = $2")
        .bind(evidence)
        .bind(graph.fix.as_uuid())
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query(
        "insert into data_fix_snapshots (fix_id, tenant_id, resource_gid, field, before_value, after_value)
         values ($1, $2, 'gid://shopify/MediaImage/1', 'alt', '\"\"', '\"A red shoe\"')",
    )
    .bind(graph.fix.as_uuid())
    .bind(graph.tenant.as_uuid())
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query(
        "insert into statements (id, tenant_id, site_id, version, status, content)
         values (gen_random_uuid(), $1, $2, 1, 'draft', '{}')",
    )
    .bind(graph.tenant.as_uuid())
    .bind(graph.site.as_uuid())
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query(
        "insert into ai_calls (id, tenant_id, task, model, mode, prompt_version, input_tokens,
                               output_tokens, cost_micro_usd, cost_is_estimate, outcome, attempts,
                               duration_ms, started_at)
         values (gen_random_uuid(), $1, 'alt_text', 'claude-haiku-5-5', 'sync', 'v1', 10, 5, 100,
                 false, 'ok', 1, 20, now())",
    )
    .bind(graph.tenant.as_uuid())
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query("insert into ai_budgets (tenant_id, period) values ($1, '2026-11')")
        .bind(graph.tenant.as_uuid())
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query(
        "insert into ai_reservations (id, tenant_id, period, amount_micro_usd, state)
         values (gen_random_uuid(), $1, '2026-11', 100, 'reserved')",
    )
    .bind(graph.tenant.as_uuid())
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query(
        "insert into webhook_events (id, tenant_id, shop_id, external_id, topic, body, body_sha256)
         values (gen_random_uuid(), $1, $2, $3, 'app/uninstalled', '{}', decode(repeat('ab', 32), 'hex'))",
    )
    .bind(graph.tenant.as_uuid())
    .bind(graph.shop.as_uuid())
    .bind(format!("event-{}", graph.tenant))
    .execute(&mut *tx)
    .await
    .unwrap();
    seed_r1_billing_and_digests(&mut tx, &graph).await;
    seed_github(&mut tx, &graph).await;
    tx.commit().await.unwrap();
}

/// One regression record (ADR-310). The engine writes them, as a worker; the app role only reads
/// and dismisses, so the fixture is written as the owner.
async fn seed_regressions(owner: &PgPool, graph: Graph) {
    sqlx::query(
        "insert into regressions (id, tenant_id, site_id, scan_id, new_count, reappeared_count,
                                  findings_seen, alert_state)
         values (gen_random_uuid(), $1, $2, $3, 1, 0, 1, 'queued')",
    )
    .bind(graph.tenant.as_uuid())
    .bind(graph.site.as_uuid())
    .bind(graph.scan.as_uuid())
    .execute(owner)
    .await
    .unwrap();
}

/// One live agency link on the graph's shop (ADR-313), with its own organization and member. The
/// organization tables hold no tenant column, so the owner writes them.
async fn seed_store_links(owner: &PgPool, graph: Graph) {
    let user = uuid::Uuid::now_v7();
    let org = uuid::Uuid::now_v7();
    let email = format!("agency-{user}@example.com");
    sqlx::query("insert into users (id, email, display_name) values ($1, $2, 'Agency')")
        .bind(user)
        .bind(email)
        .execute(owner)
        .await
        .unwrap();
    sqlx::query("insert into organizations (id, name, created_by) values ($1, 'Agency', $2)")
        .bind(org)
        .bind(user)
        .execute(owner)
        .await
        .unwrap();
    sqlx::query(
        "insert into store_links (id, tenant_id, shop_id, organization_id)
         values (gen_random_uuid(), $1, $2, $3)",
    )
    .bind(graph.tenant.as_uuid())
    .bind(graph.shop.as_uuid())
    .bind(org)
    .execute(owner)
    .await
    .unwrap();
}

/// One row of each GitHub channel table (ADR-290 to ADR-294).
async fn seed_github(tx: &mut sqlx::PgConnection, graph: &Graph) {
    let install = uuid::Uuid::now_v7();
    let repo = uuid::Uuid::now_v7();
    let pr = uuid::Uuid::now_v7();
    let suffix = graph.tenant.to_string();
    let installation_id =
        i64::from(u32::try_from(graph.tenant.as_uuid().as_u128() & 0x7fff_ffff).unwrap()) + 1;
    sqlx::query(
        "insert into github_install_states (state_sha256, tenant_id, site_id, expires_at)
         values (sha256(convert_to($1, 'UTF8')), $2, $3, now() + interval '10 minutes')",
    )
    .bind(suffix.clone())
    .bind(graph.tenant.as_uuid())
    .bind(graph.site.as_uuid())
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query(
        "insert into github_installations (id, tenant_id, site_id, installation_id, account_login,
                                           account_type, repository_selection, status)
         values ($1, $2, $3, $4, 'octo', 'User', 'selected', 'active')",
    )
    .bind(install)
    .bind(graph.tenant.as_uuid())
    .bind(graph.site.as_uuid())
    .bind(installation_id)
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query(
        "insert into github_repos (id, tenant_id, installation_row, repo_id, full_name,
                                   default_branch, user_can_push, selected, connected_branch)
         values ($1, $2, $3, $4, 'octo/theme', 'main', true, true, 'main')",
    )
    .bind(repo)
    .bind(graph.tenant.as_uuid())
    .bind(install)
    .bind(installation_id * 10)
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query(
        "insert into github_pull_requests (id, tenant_id, repo_row, repo_id, number, batch_id,
                head_branch, base_branch, head_sha, pushed_sha, state, html_url, fix_count, files,
                changed_lines)
         values ($1, $2, $3, $4, 7, 'batch-1', 'rampsmith/fix-batch-1', 'main',
                 repeat('a', 40), repeat('a', 40), 'open', 'https://github.com/octo/theme/pull/7',
                 1, 1, 2)",
    )
    .bind(pr)
    .bind(graph.tenant.as_uuid())
    .bind(repo)
    .bind(installation_id * 10)
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query(
        "insert into github_pr_fixes (pull_request_id, fix_id, tenant_id) values ($1, $2, $3)",
    )
    .bind(pr)
    .bind(graph.fix.as_uuid())
    .bind(graph.tenant.as_uuid())
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query(
        "insert into github_events (id, tenant_id, delivery_id, event, installation_id, body,
                                    body_sha256)
         values (gen_random_uuid(), $1, 'delivery-1', 'pull_request', $2, '{}',
                 sha256(convert_to($3, 'UTF8')))",
    )
    .bind(graph.tenant.as_uuid())
    .bind(installation_id)
    .bind(suffix)
    .execute(&mut *tx)
    .await
    .unwrap();
}

/// The rows of `shop_billing`, `webhook_digests` and `ai_draft_holds` (ADR-084, ADR-085).
async fn seed_r1_billing_and_digests(tx: &mut sqlx::PgConnection, graph: &Graph) {
    sqlx::query(
        "insert into ai_draft_holds (id, tenant_id, units, expires_at)
         values (gen_random_uuid(), $1, 1, now() + interval '1 hour')",
    )
    .bind(graph.tenant.as_uuid())
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query(
        "insert into shop_billing (shop_id, tenant_id, standing) values ($1, $2, 'unknown')",
    )
    .bind(graph.shop.as_uuid())
    .bind(graph.tenant.as_uuid())
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query(
        "insert into webhook_digests (tenant_id, body_sha256, topic, expires_at)
         values ($1, decode(repeat('ab', 32), 'hex'), 'app/uninstalled', now() + interval '1 day')",
    )
    .bind(graph.tenant.as_uuid())
    .execute(&mut *tx)
    .await
    .unwrap();
}

async fn two_tenants(opts: PgPoolOptions, conn: PgConnectOptions) -> (Db, PgPool, Graph, Graph) {
    let owner = owner_pool(opts.clone(), conn.clone()).await;
    let pool = app_pool(opts, conn).await;
    let db = Db::from_pool(pool.clone());
    let a = seed(&db, 1).await;
    let b = seed(&db, 2).await;
    seed_jobs(&db, &owner, [a, b]).await;
    seed_r1(&pool, a).await;
    seed_r1(&pool, b).await;
    seed_regressions(&owner, a).await;
    seed_regressions(&owner, b).await;
    seed_store_links(&owner, a).await;
    seed_store_links(&owner, b).await;
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
    assert_webhooks_and_shop_info_isolate(db, a, b).await;
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

    assert_shopify_isolates(db, a, b).await;

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
    let tokens = shopify::get_tokens(&mut tx, b.shop).await.unwrap().unwrap();
    assert_eq!(tokens.version, 0);
    assert_eq!(tokens.tokens.access_ct, sealed_tokens(2).access_ct);
    assert!(
        sites::get(&mut tx, b.site)
            .await
            .unwrap()
            .unwrap()
            .verified_at
            .is_none()
    );
}

async fn assert_shopify_isolates(db: &Db, a: Graph, b: Graph) {
    let mut tx = db.tenant(a.tenant).await.unwrap();
    assert!(
        sites::mark_verified(&mut tx, b.site, "dns_txt")
            .await
            .unwrap()
            .is_none()
    );

    assert!(shopify::get(&mut tx, b.shop).await.unwrap().is_none());
    assert!(
        shopify::reinstall(&mut tx, b.shop, &[], "2026-10")
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        shopify::get_tokens(&mut tx, b.shop)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        shopify::rotate(&mut tx, b.shop, 0, &sealed_tokens(9))
            .await
            .unwrap()
            .is_none()
    );
    assert!(!shopify::delete_tokens(&mut tx, b.shop).await.unwrap());
    tx.rollback().await.unwrap();

    // Storing tokens for another tenant's shop never overwrites them, whichever row state the
    // caller claims to have read: "no row yet" and "the row at version 0" both lose.
    for claim in [None, Some(0)] {
        let mut tx = db.tenant(a.tenant).await.unwrap();
        let stored = shopify::put_tokens(&mut tx, b.shop, claim, &sealed_tokens(9)).await;
        assert!(!matches!(stored, Ok(Some(_))), "{claim:?}: {stored:?}");
        tx.rollback().await.unwrap();
    }
    let mut tx = db.tenant(b.tenant).await.unwrap();
    let kept = shopify::get_tokens(&mut tx, b.shop).await.unwrap().unwrap();
    assert_eq!(kept.version, 0);
    assert_eq!(kept.tokens.access_ct, sealed_tokens(2).access_ct);
    tx.rollback().await.unwrap();
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

const TENANT_TABLES: [&str; 31] = [
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
    "scan_pages",
    "jobs",
    // The R1 pipeline (ADR-037).
    "scan_inputs",
    "evidence",
    "data_fix_snapshots",
    "statements",
    "ai_calls",
    "ai_budgets",
    "ai_reservations",
    "webhook_events",
    // The fix loop's plan state (ADR-084).
    "shop_billing",
    "webhook_digests",
    // The alt-text job's allowance holds (lane C audit M3); `shop/redact` deletes them.
    "ai_draft_holds",
    // The GitHub pull-request channel (ADR-290 to ADR-294).
    "github_install_states",
    "github_installations",
    "github_repos",
    "github_pull_requests",
    "github_pr_fixes",
    "github_events",
    // Regression records of scheduled scans (ADR-310).
    "regressions",
    // An agency's access granted by a merchant (ADR-313).
    "store_links",
];

/// The tables ADR-037 and ADR-084 added, which `seed_r1` fills with one row per tenant.
const R1_TABLES: [&str; 19] = [
    "scan_inputs",
    "evidence",
    "data_fix_snapshots",
    "statements",
    "ai_calls",
    "ai_budgets",
    "ai_reservations",
    "webhook_events",
    "shop_billing",
    "webhook_digests",
    "ai_draft_holds",
    "github_install_states",
    "github_installations",
    "github_repos",
    "github_pull_requests",
    "github_pr_fixes",
    "github_events",
    "regressions",
    "store_links",
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
            // `is distinct from`, not `<>`: a row with no tenant (a system job) counts as foreign
            // too, and `<>` would not count it.
            let foreign: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
                "select count(*) from {table} where {column} is distinct from $1"
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

/// Runs `sql` as the application role scoped to `tenant`, in a transaction of its own that is
/// rolled back, and returns the number of rows it affected.
async fn as_tenant(
    pool: &PgPool,
    tenant: TenantId,
    sql: impl sqlx::SqlSafeStr,
) -> Result<u64, sqlx::Error> {
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("select set_config('app.tenant_id', $1, true)")
        .bind(tenant.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    let done = sqlx::query(sql).execute(&mut *tx).await?;
    tx.rollback().await.unwrap();
    Ok(done.rows_affected())
}

/// The generic check above proves nothing foreign leaks, which an empty table would also
/// satisfy. This one proves `jobs` holds a job for each tenant and one for the system, and
/// that the application role sees only its tenant's while workers see all three.
#[sqlx::test]
async fn jobs_are_seen_by_their_tenant_and_by_workers_only(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let (_, pool, a, b) = two_tenants(opts.clone(), conn.clone()).await;
    for me in [a, b] {
        let mut tx = pool.begin().await.unwrap();
        sqlx::query("select set_config('app.tenant_id', $1, true)")
            .bind(me.tenant.to_string())
            .execute(&mut *tx)
            .await
            .unwrap();
        let seen: Vec<Option<uuid::Uuid>> = sqlx::query_scalar("select tenant_id from jobs")
            .fetch_all(&mut *tx)
            .await
            .unwrap();
        assert_eq!(seen, vec![Some(me.tenant.as_uuid())]);
        tx.rollback().await.unwrap();
    }

    let workers = worker_pool(opts, conn).await;
    let (all, system): (i64, i64) =
        sqlx::query_as("select count(*), count(*) filter (where tenant_id is null) from jobs")
            .fetch_one(&workers)
            .await
            .unwrap();
    assert_eq!(
        (all, system),
        (3, 1),
        "workers see every job, system ones too"
    );
}

const ENQUEUE_FOR_THE_SCOPED_TENANT: &str =
    "insert into jobs (id, queue, payload_schema, payload, tenant_id, state)
     values (gen_random_uuid(), 'scan.plan', 'scan.plan@1', '{}', app_current_tenant(), 'ready')";
const ENQUEUE_WITHOUT_A_TENANT: &str =
    "insert into jobs (id, queue, payload_schema, payload, tenant_id, state)
     values (gen_random_uuid(), 'scan.plan', 'scan.plan@1', '{}', null, 'ready')";

#[sqlx::test]
async fn the_app_role_enqueues_only_for_its_own_tenant_and_never_edits_jobs(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let (_, pool, a, b) = two_tenants(opts.clone(), conn.clone()).await;

    // A control: a job for its own tenant is accepted.
    let own = as_tenant(&pool, a.tenant, ENQUEUE_FOR_THE_SCOPED_TENANT).await;
    assert_eq!(own.unwrap(), 1);

    // A job with no tenant is a system job, which the application role may not create.
    let err = as_tenant(&pool, a.tenant, ENQUEUE_WITHOUT_A_TENANT)
        .await
        .expect_err("the application role enqueued a system job");
    assert!(err.to_string().contains("row-level security"), "{err}");

    // A job for the other tenant is refused.
    let for_b = format!(
        "insert into jobs (id, queue, payload_schema, payload, tenant_id, state)
         values (gen_random_uuid(), 'scan.plan', 'scan.plan@1', '{{}}', '{}', 'ready')",
        b.tenant.as_uuid()
    );
    let err = as_tenant(&pool, a.tenant, sqlx::AssertSqlSafe(for_b))
        .await
        .expect_err("the application role enqueued for another tenant");
    assert!(err.to_string().contains("row-level security"), "{err}");

    // Jobs are never edited or removed by the application role, even its own.
    for statement in [
        "update jobs set state = 'cancelled', finished_at = now()",
        "delete from jobs",
    ] {
        let err = as_tenant(&pool, a.tenant, statement)
            .await
            .expect_err("the application role changed jobs");
        assert!(err.to_string().contains("permission denied"), "{err}");
    }

    // Workers claim and finish jobs of every tenant, so they may change all of them.
    let workers = worker_pool(opts, conn).await;
    let touched = sqlx::query("update jobs set priority = 1")
        .execute(&workers)
        .await
        .unwrap();
    assert_eq!(touched.rows_affected(), 3);
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

/// Only `ctl`'s group may delete call records, and only for the tenant the transaction is
/// scoped to (audit L7): the engine's login is a plain worker member.
#[sqlx::test]
async fn only_the_ctl_role_can_delete_ai_calls_and_only_for_its_own_tenant(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let (_, _, a, b) = two_tenants(opts.clone(), conn.clone()).await;
    let owner = owner_pool(opts.clone(), conn.clone()).await;
    let workers = worker_pool(opts.clone(), conn.clone()).await;
    // Only the redaction group may run the function: not PUBLIC, not the worker, not the
    // group that migration 20261105000004 created under ctl's login name (ADR-089). The login
    // reaches the function through membership of the redaction group, never by a grant.
    let (public, worker, old_ctl, redactor): (bool, bool, bool, bool) = sqlx::query_as(
        "select has_function_privilege('public', 'redact_ai_calls()', 'execute'),
                has_function_privilege('rampsmith_worker', 'redact_ai_calls()', 'execute'),
                exists (select 1 from pg_proc p, aclexplode(p.proacl) a, pg_roles r
                         where p.proname = 'redact_ai_calls' and r.rolname = 'rampsmith_ctl'
                           and a.grantee = r.oid and a.privilege_type = 'EXECUTE'),
                has_function_privilege('rampsmith_redactor', 'redact_ai_calls()', 'execute')",
    )
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(
        (public, worker, old_ctl, redactor),
        (false, false, false, true)
    );
    for statement in ["delete from ai_calls", "select redact_ai_calls()"] {
        let mut tx = workers.begin().await.unwrap();
        sqlx::query("select set_config('app.tenant_id', $1, true)")
            .bind(a.tenant.to_string())
            .execute(&mut *tx)
            .await
            .unwrap();
        let err = sqlx::query(statement)
            .execute(&mut *tx)
            .await
            .expect_err("the worker role deleted call records");
        assert!(err.to_string().contains("permission denied"), "{err}");
    }
    let ctl = ctl_pool(opts, conn).await;
    let mut tx = ctl.begin().await.unwrap();
    assert!(
        sqlx::query("select redact_ai_calls()")
            .execute(&mut *tx)
            .await
            .is_err(),
        "no tenant scope must be refused"
    );
    drop(tx);
    let mut tx = ctl.begin().await.unwrap();
    sqlx::query("select set_config('app.tenant_id', $1, true)")
        .bind(a.tenant.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    let removed: i64 = sqlx::query_scalar("select redact_ai_calls()")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(removed, 1);
    let left = |tenant: TenantId| {
        let owner = owner.clone();
        async move {
            sqlx::query_scalar::<_, i64>("select count(*) from ai_calls where tenant_id = $1")
                .bind(tenant.as_uuid())
                .fetch_one(&owner)
                .await
                .unwrap()
        }
    };
    assert_eq!(left(a.tenant).await, 0);
    assert_eq!(left(b.tenant).await, 1);
}

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

/// The suite above lists its tables by hand, so a migration that adds a tenant table and forgets
/// the list would leave that table unchecked. This reads the catalog: every table of the public
/// schema that has a `tenant_id` column or row-level security must be in `TENANT_TABLES`, and
/// every one of those must have row-level security switched on and a policy for the application
/// role. A partition is checked through its parent.
#[sqlx::test]
async fn every_tenant_table_in_the_schema_is_in_the_isolation_suite(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let owner = owner_pool(opts, conn).await;
    let rows: Vec<(String, bool, bool)> = sqlx::query_as(
        "select c.relname::text, c.relrowsecurity,
                exists (select 1 from pg_policy p where p.polrelid = c.oid)
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
            and (c.relrowsecurity or exists (
                  select 1 from pg_attribute a
                   where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped))
          order by 1",
    )
    .fetch_all(&owner)
    .await
    .unwrap();
    let mut in_schema: Vec<&str> = rows.iter().map(|(name, _, _)| name.as_str()).collect();
    // The email tables are read by the worker and ctl roles, not the app role the loops over
    // `TENANT_TABLES` run as, so their rows are in the email section (`EMAIL_TABLES`).
    let mut listed = TENANT_TABLES.to_vec();
    listed.extend(EMAIL_TABLES);
    in_schema.sort_unstable();
    listed.sort_unstable();
    assert_eq!(
        in_schema, listed,
        "a tenant table is missing from TENANT_TABLES (or the list names a table that is gone)"
    );
    for (name, secured, has_policy) in rows {
        assert!(secured, "{name}: row-level security is not enabled");
        assert!(has_policy, "{name}: no row-level security policy");
    }
}

// --- The R1 pipeline's tables (ADR-037) ----------------------------------------------------

/// The generic check proves nothing foreign leaks, which an empty table would also satisfy.
/// This one proves each new table holds exactly its own tenant's row for each tenant.
#[sqlx::test]
async fn each_tenant_sees_exactly_its_own_row_of_every_r1_table(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let (_, pool, a, b) = two_tenants(opts, conn).await;
    for me in [a, b] {
        let mut tx = pool.begin().await.unwrap();
        sqlx::query("select set_config('app.tenant_id', $1, true)")
            .bind(me.tenant.to_string())
            .execute(&mut *tx)
            .await
            .unwrap();
        for table in R1_TABLES {
            let seen: i64 =
                sqlx::query_scalar(sqlx::AssertSqlSafe(format!("select count(*) from {table}")))
                    .fetch_one(&mut *tx)
                    .await
                    .unwrap();
            assert_eq!(seen, 1, "{table}: tenant {} saw {seen} rows", me.tenant);
        }
        tx.rollback().await.unwrap();
    }
}

#[sqlx::test]
async fn r1_tables_reject_rows_for_another_tenant_and_ignore_edits_of_theirs(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let (_, pool, a, b) = two_tenants(opts, conn).await;
    let for_b = |sql: String| sqlx::AssertSqlSafe(sql);
    let inserts = [
        format!(
            "insert into scan_inputs (id, tenant_id, scan_id, site_id, kind, seq, payload)
             values (gen_random_uuid(), '{}', '{}', '{}', 'shop', 0, '{{}}')",
            b.tenant.as_uuid(),
            b.scan.as_uuid(),
            b.site.as_uuid()
        ),
        format!(
            "insert into statements (id, tenant_id, site_id, version, status, content)
             values (gen_random_uuid(), '{}', '{}', 2, 'draft', '{{}}')",
            b.tenant.as_uuid(),
            b.site.as_uuid()
        ),
        format!(
            "insert into ai_budgets (tenant_id, period) values ('{}', '2026-12')",
            b.tenant.as_uuid()
        ),
    ];
    for sql in inserts {
        let err = as_tenant(&pool, a.tenant, for_b(sql.clone()))
            .await
            .expect_err("tenant A wrote a row for tenant B");
        assert!(
            err.to_string().contains("row-level security"),
            "{sql}: {err}"
        );
    }
    // Updates and deletes of the other tenant's rows touch nothing.
    for table in [
        "scan_inputs",
        "evidence",
        "statements",
        "webhook_events",
        "webhook_digests",
    ] {
        let deleted = as_tenant(
            &pool,
            a.tenant,
            for_b(format!(
                "delete from {table} where tenant_id = '{}'",
                b.tenant.as_uuid()
            )),
        )
        .await
        .unwrap();
        assert_eq!(deleted, 0, "{table}");
    }
}

/// Call metadata only grows, like the audit log (ADR-037).
#[sqlx::test]
async fn ai_calls_are_insert_and_read_only(opts: PgPoolOptions, conn: PgConnectOptions) {
    let (_, pool, a, _) = two_tenants(opts, conn).await;
    for statement in ["update ai_calls set attempts = 2", "delete from ai_calls"] {
        let err = as_tenant(&pool, a.tenant, statement)
            .await
            .expect_err("ai_calls was changed");
        assert!(err.to_string().contains("permission denied"), "{err}");
    }
}

#[sqlx::test]
async fn composite_foreign_keys_reject_cross_tenant_references_in_r1_tables(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let db = Db::from_pool(app_pool(opts.clone(), conn.clone()).await);
    let a = seed(&db, 1).await;
    let b = seed(&db, 2).await;
    let owner = owner_pool(opts, conn).await;

    // Each statement is tenant A's row pointing at tenant B's parent.
    let cases = [
        (
            "scan_inputs",
            "insert into scan_inputs (id, tenant_id, scan_id, site_id, kind, seq, payload)
             values (gen_random_uuid(), $1, $2, (select id from sites where tenant_id = $1), 'shop', 0, '{}')",
            b.scan.as_uuid(),
        ),
        (
            "scan_inputs site",
            "insert into scan_inputs (id, tenant_id, scan_id, site_id, kind, seq, payload)
             values (gen_random_uuid(), $1, (select id from scans where tenant_id = $1), $2, 'shop', 0, '{}')",
            b.site.as_uuid(),
        ),
        (
            "evidence",
            "insert into evidence (id, tenant_id, scan_id, content_type, bytes)
             values (gen_random_uuid(), $1, $2, 'image/png', '\\x89504e47')",
            b.scan.as_uuid(),
        ),
        (
            "evidence finding",
            "insert into evidence (id, tenant_id, scan_id, finding_id, content_type, bytes)
             values (gen_random_uuid(), $1, (select id from scans where tenant_id = $1), $2, 'image/png', '\\x89504e47')",
            b.finding.as_uuid(),
        ),
        (
            "data_fix_snapshots",
            "insert into data_fix_snapshots (fix_id, tenant_id, resource_gid, field, before_value, after_value)
             values ($2, $1, 'gid://shopify/MediaImage/1', 'alt', '\"\"', '\"x\"')",
            b.fix.as_uuid(),
        ),
        (
            "statements",
            "insert into statements (id, tenant_id, site_id, version, status, content)
             values (gen_random_uuid(), $1, $2, 1, 'draft', '{}')",
            b.site.as_uuid(),
        ),
        (
            "webhook_events",
            "insert into webhook_events (id, tenant_id, shop_id, external_id, topic, body, body_sha256)
             values (gen_random_uuid(), $1, $2, 'cross-tenant', 'app/uninstalled', '{}', decode(repeat('ab', 32), 'hex'))",
            b.shop.as_uuid(),
        ),
    ];
    for (name, sql, foreign_id) in cases {
        let result = sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind(a.tenant.as_uuid())
            .bind(foreign_id)
            .execute(&owner)
            .await;
        let err = result.expect_err(name);
        assert!(err.to_string().contains("foreign key"), "{name}: {err}");
    }
}

/// `scan_inputs_sweep` deletes store data older than 30 days for every tenant. Workers run it;
/// the application role may not, and the age is not a parameter (ADR-037).
#[sqlx::test]
async fn the_scan_inputs_sweep_removes_only_old_rows_and_only_workers_run_it(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let (_, pool, a, b) = two_tenants(opts.clone(), conn.clone()).await;
    let owner = owner_pool(opts.clone(), conn.clone()).await;
    sqlx::query(
        "update scan_inputs set created_at = now() - interval '31 days' where tenant_id = $1",
    )
    .bind(a.tenant.as_uuid())
    .execute(&owner)
    .await
    .unwrap();

    let err = sqlx::query("select scan_inputs_sweep()")
        .execute(&pool)
        .await
        .expect_err("the application role ran the sweep");
    assert!(err.to_string().contains("permission denied"), "{err}");

    let workers = worker_pool(opts, conn).await;
    let swept: i64 = sqlx::query_scalar("select scan_inputs_sweep()")
        .fetch_one(&workers)
        .await
        .unwrap();
    assert_eq!(swept, 1);
    let left: Vec<uuid::Uuid> = sqlx::query_scalar("select tenant_id from scan_inputs")
        .fetch_all(&owner)
        .await
        .unwrap();
    assert_eq!(left, vec![b.tenant.as_uuid()]);
}

#[sqlx::test]
async fn a_sealed_storefront_password_is_both_columns_or_neither(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let db = Db::from_pool(app_pool(opts.clone(), conn.clone()).await);
    let a = seed(&db, 1).await;
    let owner = owner_pool(opts, conn).await;
    let err = sqlx::query("update sites set storefront_password_ct = '\\x01' where id = $1")
        .bind(a.site.as_uuid())
        .execute(&owner)
        .await
        .expect_err("a password without its key id was accepted");
    assert!(
        err.to_string().contains("storefront_password_sealed"),
        "{err}"
    );
    sqlx::query(
        "update sites set storefront_password_ct = '\\x01', storefront_password_key_id = 'k1' where id = $1",
    )
    .bind(a.site.as_uuid())
    .execute(&owner)
    .await
    .unwrap();
}

fn webhook(shop: Graph, id: &str, label: u8) -> NewWebhook {
    NewWebhook {
        shop_id: shop.shop,
        external_id: id.to_owned(),
        topic: "app/uninstalled".to_owned(),
        body: serde_json::json!({"myshopify_domain": "x.myshopify.com", "label": label}),
        body_sha256: [label; 32],
    }
}

/// Webhook events and the shop-info columns the R1 listener and worker read and write (ADR-080):
/// a tenant never reaches another tenant's rows, and a dedup never matches across tenants.
async fn assert_webhooks_and_shop_info_isolate(db: &Db, a: Graph, b: Graph) {
    // Both tenants may receive the very same delivery id and body: dedup is per tenant.
    let mut ids = Vec::new();
    for me in [a, b] {
        let mut tx = db.tenant(me.tenant).await.unwrap();
        let Recorded::Stored(id) = webhooks::record(&mut tx, &webhook(me, "same-id", 5))
            .await
            .unwrap()
        else {
            panic!("a delivery another tenant also received was treated as a duplicate");
        };
        ids.push(id);
        tx.commit().await.unwrap();
    }
    // A cannot read, mark or duplicate-match B's event.
    let mut tx = db.tenant(a.tenant).await.unwrap();
    assert!(webhooks::get(&mut tx, ids[1]).await.unwrap().is_none());
    assert!(!webhooks::mark_processed(&mut tx, ids[1]).await.unwrap());
    // Recording an event for B's shop as A is rejected by the composite key or by RLS.
    let forged = webhooks::record(&mut tx, &webhook(b, "forged", 6)).await;
    assert!(forged.is_err(), "{forged:?}");
    tx.rollback().await.unwrap();

    let mut tx = db.tenant(b.tenant).await.unwrap();
    let event = webhooks::get(&mut tx, ids[1]).await.unwrap().unwrap();
    assert!(
        event.processed_at.is_none(),
        "A's attempt changed B's event"
    );
    assert!(webhooks::mark_processed(&mut tx, ids[1]).await.unwrap());
    tx.commit().await.unwrap();

    // Store batches and scan failure.
    let mut tx = db.tenant(a.tenant).await.unwrap();
    let batch = serde_json::json!({"items": []});
    assert!(
        scan_inputs::put(&mut tx, b.scan, b.site, "pages", 7, &batch)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        scan_inputs::put(&mut tx, a.scan, b.site, "pages", 7, &batch)
            .await
            .unwrap()
            .is_none(),
        "a scan with another tenant's site"
    );
    assert_eq!(
        scan_inputs::count(&mut tx, b.scan, "products")
            .await
            .unwrap(),
        0
    );
    assert!(scans::fail(&mut tx, b.scan, "x").await.unwrap().is_none());
    assert!(!scans::set_planned(&mut tx, b.scan, 3).await.unwrap());
    tx.rollback().await.unwrap();
    let mut tx = db.tenant(b.tenant).await.unwrap();
    assert_eq!(
        scan_inputs::count(&mut tx, b.scan, "pages").await.unwrap(),
        0
    );
    let id = scan_inputs::put(&mut tx, b.scan, b.site, "pages", 7, &batch)
        .await
        .unwrap()
        .unwrap();
    let again = scan_inputs::put(&mut tx, b.scan, b.site, "pages", 7, &batch)
        .await
        .unwrap();
    assert_eq!(again, Some(id), "the same batch keeps its id");
    tx.rollback().await.unwrap();

    assert_data_fixes_isolate(db, a, b).await;
    assert_shop_info_isolates(db, a, b).await;
    assert_scan_secrets_isolate(db, a, b).await;
}

/// The data-fix lifecycle `ctl` drives.
async fn assert_data_fixes_isolate(db: &Db, a: Graph, b: Graph) {
    let mut tx = db.tenant(a.tenant).await.unwrap();
    assert!(data_fixes::get(&mut tx, b.fix).await.unwrap().is_none());
    assert!(
        data_fixes::snapshot(&mut tx, b.fix)
            .await
            .unwrap()
            .is_none()
    );
    let snapshot = data_fixes::Snapshot {
        resource_gid: "gid://shopify/MediaImage/1".to_owned(),
        field: "alt".to_owned(),
        before_value: serde_json::Value::Null,
        after_value: serde_json::json!("x"),
    };
    assert!(
        !data_fixes::put_snapshot(&mut tx, b.fix, &snapshot)
            .await
            .unwrap()
    );
    assert!(!data_fixes::begin_apply(&mut tx, b.fix).await.unwrap());
    assert!(!data_fixes::finish_apply(&mut tx, b.fix).await.unwrap());
    assert!(!data_fixes::fail(&mut tx, b.fix, "x").await.unwrap());
    assert!(!data_fixes::finish_revert(&mut tx, b.fix).await.unwrap());
    assert_eq!(
        data_fixes::reopen_findings(&mut tx, b.fix).await.unwrap(),
        0
    );
    assert!(
        data_fixes::approve_by_ref(&mut tx, b.fix, "1")
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        data_fixes::latest_ruleset(&mut tx, b.site)
            .await
            .unwrap()
            .is_none()
    );
    tx.rollback().await.unwrap();
}

/// The storefront password of a site and the sealed copy on a scan (ADR-266).
async fn assert_scan_secrets_isolate(db: &Db, a: Graph, b: Graph) {
    let secret = scan_secrets::SealedSecret {
        key_id: "scan1".to_owned(),
        bytes: vec![1, 2, 3],
    };
    // Tenant B has a saved password and a sealed copy.
    let mut tx = db.tenant(b.tenant).await.unwrap();
    assert!(
        app_views::set_storefront_password(&mut tx, b.site, Some((&[9, 9, 9], "k1")))
            .await
            .unwrap()
    );
    assert!(
        scan_secrets::set_scan_password(&mut tx, b.scan, Some(&secret))
            .await
            .unwrap()
    );
    tx.commit().await.unwrap();
    // Tenant A reads, writes and clears none of it.
    let mut tx = db.tenant(a.tenant).await.unwrap();
    assert!(
        scan_secrets::site_password(&mut tx, b.site)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        scan_secrets::scan_password(&mut tx, b.scan)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        !scan_secrets::set_scan_password(&mut tx, b.scan, Some(&secret))
            .await
            .unwrap()
    );
    assert!(
        !scan_secrets::set_scan_password(&mut tx, b.scan, None)
            .await
            .unwrap()
    );
    tx.rollback().await.unwrap();
    let mut tx = db.tenant(b.tenant).await.unwrap();
    assert_eq!(
        scan_secrets::scan_password(&mut tx, b.scan).await.unwrap(),
        Some(secret.clone())
    );
    // A scan that has ended takes no new copy, and a failed scan drops the one it had.
    assert!(scans::fail(&mut tx, b.scan, "x").await.unwrap().is_some());
    assert!(
        scan_secrets::scan_password(&mut tx, b.scan)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        !scan_secrets::set_scan_password(&mut tx, b.scan, Some(&secret))
            .await
            .unwrap()
    );
    tx.rollback().await.unwrap();
}

/// Shop info and uninstall.
async fn assert_shop_info_isolates(db: &Db, a: Graph, b: Graph) {
    let mut tx = db.tenant(a.tenant).await.unwrap();
    assert!(!shopify::mark_uninstalled(&mut tx, b.shop).await.unwrap());
    assert!(
        !shopify::set_info(
            &mut tx,
            b.shop,
            "Evil",
            Some("evil.example"),
            &["xx".to_owned()]
        )
        .await
        .unwrap()
    );
    assert!(shopify::get_info(&mut tx, b.shop).await.unwrap().is_none());
    tx.rollback().await.unwrap();
    let mut tx = db.tenant(b.tenant).await.unwrap();
    let info = shopify::get_info(&mut tx, b.shop).await.unwrap().unwrap();
    assert_ne!(info.primary_domain.as_deref(), Some("evil.example"));
    assert_ne!(info.name.as_deref(), Some("Evil"));
    assert!(
        shopify::get(&mut tx, b.shop)
            .await
            .unwrap()
            .unwrap()
            .uninstalled_at
            .is_none()
    );
    tx.rollback().await.unwrap();
}

/// `shop/redact` and the job cancellation on uninstall act on the caller's tenant only.
#[sqlx::test]
async fn redaction_and_job_cancellation_never_touch_another_tenant(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let (_, _, a, b) = two_tenants(opts.clone(), conn.clone()).await;
    let workers = ctl_pool(opts.clone(), conn.clone()).await;
    let db = Db::from_pool(workers.clone());
    let owner = owner_pool(opts, conn).await;
    let count = |sql: &'static str, tenant: TenantId| {
        let owner = owner.clone();
        async move {
            sqlx::query_scalar::<_, i64>(sql)
                .bind(tenant.as_uuid())
                .fetch_one(&owner)
                .await
                .unwrap()
        }
    };

    // Cancelling A's pending work leaves B's.
    let mut tx = db.tenant(a.tenant).await.unwrap();
    assert_eq!(
        jobs::cancel_pending(&mut tx, "webhook.process")
            .await
            .unwrap(),
        1
    );
    tx.commit().await.unwrap();
    assert_eq!(
        count(
            "select count(*) from jobs where tenant_id = $1 and state = 'ready'",
            b.tenant
        )
        .await,
        1
    );

    // Redacting B's shop as A finds nothing and changes nothing.
    let mut tx = db.tenant(a.tenant).await.unwrap();
    assert!(redact::shop(&mut tx, b.shop).await.unwrap().is_none());
    tx.rollback().await.unwrap();
    assert_eq!(
        count("select count(*) from scans where tenant_id = $1", b.tenant).await,
        1
    );

    // Redacting A's own shop empties A and leaves B whole.
    sqlx::query("update shopify_shops set shop_gid = 'gid://shopify/Shop/1' where tenant_id = $1")
        .bind(a.tenant.as_uuid())
        .execute(&owner)
        .await
        .unwrap();
    sqlx::query("update jobs set payload = '{\"note\": \"store content\"}' where tenant_id = $1")
        .bind(a.tenant.as_uuid())
        .execute(&owner)
        .await
        .unwrap();
    let mut tx = db.tenant(a.tenant).await.unwrap();
    let removed = redact::shop(&mut tx, a.shop).await.unwrap().unwrap();
    tx.commit().await.unwrap();
    assert!(removed.scans >= 1 && removed.findings >= 1);
    for table in [
        "scans",
        "findings",
        "fixes",
        "scan_inputs",
        "evidence",
        "shopify_tokens",
    ] {
        let sql: &'static str = Box::leak(
            format!("select count(*) from {table} where tenant_id = $1").into_boxed_str(),
        );
        assert_eq!(count(sql, a.tenant).await, 0, "{table} kept A's rows");
        assert!(count(sql, b.tenant).await >= 1, "{table} lost B's rows");
    }
    // Job payloads and the shop's global id go too (audit L7).
    assert_eq!(
        count(
            "select count(*) from jobs where tenant_id = $1 and payload <> '{}'::jsonb",
            a.tenant
        )
        .await,
        0
    );
    assert_eq!(
        count(
            "select count(*) from shopify_shops where tenant_id = $1 and shop_gid is not null",
            a.tenant
        )
        .await,
        0
    );
    // The second run removes nothing.
    let mut tx = db.tenant(a.tenant).await.unwrap();
    let again = redact::shop(&mut tx, a.shop).await.unwrap().unwrap();
    tx.commit().await.unwrap();
    assert_eq!(again, redact::Redacted::default());
}

/// Everything the embedded app's pages read or change (ADR-083), asked as tenant A about
/// tenant B's site and rows: nothing is found and nothing changes. `b_evidence` is B's evidence
/// row when the graph has one.
async fn assert_app_views_isolate(db: &Db, a: Graph, b: Graph, b_evidence: Option<uuid::Uuid>) {
    let mut tx = db.tenant(a.tenant).await.unwrap();
    assert!(
        app_views::latest_scan(&mut tx, b.site)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        app_views::scan(&mut tx, b.site, b.scan.as_uuid())
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        !app_views::has_live_scan(&mut tx, b.site, 3600)
            .await
            .unwrap()
    );
    let (counts, first_fix) = app_views::counts(&mut tx, b.site).await.unwrap();
    assert_eq!(counts, app_views::Counts::default());
    assert!(first_fix.is_none());
    let filter = app_views::FindingFilter {
        offset: 0,
        limit: 50,
        ..Default::default()
    };
    assert_empty(&app_views::findings(&mut tx, b.site, &filter).await.unwrap());
    assert!(
        app_views::finding(&mut tx, b.site, b.finding.as_uuid())
            .await
            .unwrap()
            .is_none()
    );
    let (occurrences, templates) = app_views::occurrences(&mut tx, b.finding.as_uuid(), 50)
        .await
        .unwrap();
    assert!(occurrences.is_empty() && templates.is_empty());
    let all = [
        "proposed", "approved", "applying", "applied", "verified", "failed", "reverted", "rejected",
    ]
    .map(str::to_owned);
    assert_empty(
        &app_views::fixes(&mut tx, b.site, &all, 0, 50)
            .await
            .unwrap(),
    );
    assert!(
        app_views::fix(&mut tx, b.site, b.fix.as_uuid())
            .await
            .unwrap()
            .is_none()
    );
    assert_empty(
        &app_views::fixes_of_finding(&mut tx, b.site, b.finding.as_uuid())
            .await
            .unwrap(),
    );
    assert_empty(
        &app_views::findings_of_fixes(&mut tx, &[b.fix.as_uuid()])
            .await
            .unwrap(),
    );
    assert_empty(
        &app_views::evidence_of_fixes(&mut tx, &[b.fix.as_uuid()])
            .await
            .unwrap(),
    );
    assert_empty(
        &app_views::products(&mut tx, b.site, &["gid://shopify/Product/1".to_owned()])
            .await
            .unwrap(),
    );
    tx.rollback().await.unwrap();
    assert_app_writes_isolate(db, a, b, b_evidence).await;
    assert_app_controls_and_keys(db, a, b).await;
}

/// The writes and settings half of [`assert_app_views_isolate`].
async fn assert_app_writes_isolate(db: &Db, a: Graph, b: Graph, b_evidence: Option<uuid::Uuid>) {
    let mut tx = db.tenant(a.tenant).await.unwrap();
    assert!(
        !app_views::edit_alt(&mut tx, b.site, b.fix.as_uuid(), "Changed")
            .await
            .unwrap()
    );
    assert!(
        !app_views::reject(&mut tx, b.site, b.fix.as_uuid())
            .await
            .unwrap()
    );
    assert!(
        !app_views::revert_pending(&mut tx, b.fix.as_uuid())
            .await
            .unwrap()
    );
    if let Some(evidence) = b_evidence {
        assert!(
            app_views::evidence(&mut tx, evidence)
                .await
                .unwrap()
                .is_none()
        );
    }
    assert!(
        app_views::settings(&mut tx, b.site)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        !app_views::merge_settings(&mut tx, b.site, &serde_json::json!({"weekly_rescan": true}))
            .await
            .unwrap()
    );
    assert!(
        !app_views::set_storefront_password(&mut tx, b.site, Some((b"x", "k1")))
            .await
            .unwrap()
    );
    assert!(!app_views::lock_site(&mut tx, b.site).await.unwrap());
    assert_eq!(app_views::images_fixed(&mut tx, b.site).await.unwrap(), 0);
    assert_empty(&app_views::statements(&mut tx, b.site).await.unwrap());
    assert!(
        app_views::site_of_shop(&mut tx, b.shop)
            .await
            .unwrap()
            .is_none()
    );
    assert!(shop_billing::get(&mut tx, b.shop).await.unwrap().is_none());
    assert!(
        !shopify::set_shop_gid(&mut tx, b.shop, "gid://shopify/Shop/1")
            .await
            .unwrap()
    );
    assert!(shopify::shop_gid(&mut tx, b.shop).await.unwrap().is_none());
    tx.rollback().await.unwrap();
}

/// The tenant's own rows are visible, and writes that name another tenant's site or shop are
/// refused by the composite keys, not silently accepted.
async fn assert_app_controls_and_keys(db: &Db, a: Graph, b: Graph) {
    let mut tx = db.tenant(a.tenant).await.unwrap();
    // The tenant's own site is visible, as a control.
    assert!(
        app_views::latest_scan(&mut tx, a.site)
            .await
            .unwrap()
            .is_some()
    );
    assert!(
        app_views::finding(&mut tx, a.site, a.finding.as_uuid())
            .await
            .unwrap()
            .is_some()
    );
    assert!(
        app_views::fix(&mut tx, a.site, a.fix.as_uuid())
            .await
            .unwrap()
            .is_some()
    );
    tx.rollback().await.unwrap();

    // Writes that name another tenant's site or shop are refused by the composite keys, not
    // silently accepted.
    let mut tx = db.tenant(a.tenant).await.unwrap();
    assert!(
        app_views::save_draft(&mut tx, b.site, &serde_json::json!({}))
            .await
            .is_err()
    );
    tx.rollback().await.unwrap();
    let mut tx = db.tenant(a.tenant).await.unwrap();
    let state = billing::stored::stored_of(&billing::BillingState::new());
    assert!(shop_billing::put(&mut tx, b.shop, &state).await.is_err());
    tx.rollback().await.unwrap();
}

#[sqlx::test]
async fn the_embedded_apps_queries_return_nothing_across_the_boundary(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let (db, _, a, b) = two_tenants(opts.clone(), conn.clone()).await;
    let owner = owner_pool(opts, conn).await;
    let evidence: uuid::Uuid = sqlx::query_scalar("select id from evidence where tenant_id = $1")
        .bind(b.tenant.as_uuid())
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_app_views_isolate(&db, a, b, Some(evidence)).await;
}

/// The superuser bypasses row-level security, so this proves the queries' own filters.
#[sqlx::test]
async fn the_embedded_apps_queries_scope_themselves_without_row_level_security(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let db = Db::from_pool(owner_pool(opts, conn).await);
    let a = seed(&db, 1).await;
    let b = seed(&db, 2).await;
    assert_app_views_isolate(&db, a, b, None).await;
}

// --- Email: contacts, suppressions and the sender's ledger (ADR-270 to ADR-272) ----------------

const EMAIL_TABLES: [&str; 4] = [
    "shop_contacts",
    "email_suppressions",
    "email_deliveries",
    "email_opt_outs",
];

/// One row of each email table for the graph's tenant, written through the role that owns the
/// write in production: `ctl` for the contact, the application for the suppression, a worker for
/// the delivery record.
async fn seed_email(opts: &PgPoolOptions, conn: &PgConnectOptions, graph: Graph) {
    let ctl = Db::from_pool(ctl_pool(opts.clone(), conn.clone()).await);
    let mut tx = ctl.tenant(graph.tenant).await.unwrap();
    assert!(
        email::put_shop_contact(
            &mut tx,
            graph.shop,
            "Owner@Shop.example",
            "Fixture Store",
            Some("en")
        )
        .await
        .unwrap()
    );
    tx.commit().await.unwrap();

    let app = Db::from_pool(app_pool(opts.clone(), conn.clone()).await);
    let mut tx = app.tenant(graph.tenant).await.unwrap();
    email::suppress(
        &mut tx,
        "gone@shop.example",
        email::SuppressionReason::Unsubscribed,
    )
    .await
    .unwrap();
    email::opt_out(&mut tx, &[7u8; 32], email::OptOutCategory::Notification)
        .await
        .unwrap();
    tx.commit().await.unwrap();

    let worker = worker_pool(opts.clone(), conn.clone()).await;
    let mut tx = worker.begin().await.unwrap();
    sqlx::query("select set_config('app.tenant_id', $1, true)")
        .bind(graph.tenant.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query(
        "insert into email_deliveries (tenant_id, message_key, template, state)
         values ($1, 'uninstall-export:fixture-1', 'uninstall_export', 'sending')",
    )
    .bind(graph.tenant.as_uuid())
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
}

async fn two_tenants_with_email(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) -> (PgPool, Graph, Graph) {
    let (_, pool, a, b) = two_tenants(opts.clone(), conn.clone()).await;
    seed_email(&opts, &conn, a).await;
    seed_email(&opts, &conn, b).await;
    (pool, a, b)
}

#[sqlx::test]
async fn each_tenant_sees_exactly_its_own_row_of_every_email_table(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let (_pool, a, b) = two_tenants_with_email(opts.clone(), conn.clone()).await;
    // Workers read all three; the application reads suppressions and deliveries.
    let worker = worker_pool(opts.clone(), conn.clone()).await;
    let app = app_pool(opts, conn).await;
    for (pool, tables) in [
        (&worker, EMAIL_TABLES.as_slice()),
        (
            &app,
            &["email_suppressions", "email_deliveries", "email_opt_outs"][..],
        ),
    ] {
        for me in [a, b] {
            let mut tx = pool.begin().await.unwrap();
            sqlx::query("select set_config('app.tenant_id', $1, true)")
                .bind(me.tenant.to_string())
                .execute(&mut *tx)
                .await
                .unwrap();
            for table in tables {
                let seen: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
                    "select count(*) from {table}"
                )))
                .fetch_one(&mut *tx)
                .await
                .unwrap();
                assert_eq!(seen, 1, "{table}: tenant {} saw {seen} rows", me.tenant);
            }
            tx.rollback().await.unwrap();
        }
    }
}

#[sqlx::test]
async fn email_tables_reject_rows_for_another_tenant_and_ignore_edits_of_theirs(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let (_, a, b) = two_tenants_with_email(opts.clone(), conn.clone()).await;
    let ctl = ctl_pool(opts.clone(), conn.clone()).await;
    let worker = worker_pool(opts.clone(), conn.clone()).await;
    let app = app_pool(opts, conn).await;
    let b_tenant = b.tenant.as_uuid();
    // A write for tenant B inside tenant A's transaction is a row-level-security violation.
    let writes: [(&PgPool, String); 4] = [
        (
            &app,
            format!(
                "insert into email_opt_outs (tenant_id, address_hash, category)
                 values ('{b_tenant}', sha256('x'), 'marketing')"
            ),
        ),
        (
            &ctl,
            format!(
                "insert into shop_contacts (shop_id, tenant_id, email, store_name)
                 values (gen_random_uuid(), '{b_tenant}', 'x@shop.example', 'X')"
            ),
        ),
        (
            &worker,
            format!(
                "insert into email_suppressions (tenant_id, address_hash, reason)
                 values ('{b_tenant}', sha256('x'), 'manual')"
            ),
        ),
        (
            &worker,
            format!(
                "insert into email_deliveries (tenant_id, message_key, template, state)
                 values ('{b_tenant}', 'other-tenant-key-1', 'welcome', 'sending')"
            ),
        ),
    ];
    for (pool, sql) in writes {
        let err = as_tenant(pool, a.tenant, sqlx::AssertSqlSafe(sql.clone()))
            .await
            .expect_err("tenant A wrote a row for tenant B");
        assert!(
            err.to_string().contains("row-level security"),
            "{sql}: {err}"
        );
    }
    // Updates and deletes of the other tenant's rows touch nothing.
    for (pool, sql) in [
        (
            &ctl,
            format!("delete from shop_contacts where tenant_id = '{b_tenant}'"),
        ),
        (
            &ctl,
            format!(
                "update shop_contacts set store_name = 'Hijacked' where tenant_id = '{b_tenant}'"
            ),
        ),
        (
            &worker,
            format!("update email_deliveries set state = 'sent' where tenant_id = '{b_tenant}'"),
        ),
        (
            &worker,
            format!(
                "update email_suppressions set reason = 'manual' where tenant_id = '{b_tenant}'"
            ),
        ),
    ] {
        let changed = as_tenant(pool, a.tenant, sqlx::AssertSqlSafe(sql.clone()))
            .await
            .unwrap();
        assert_eq!(changed, 0, "{sql}");
    }
}

/// Only `ctl`'s group writes a shop's contact; the engine, a plain worker member, reads it. The
/// application login does not (audit L6, ADR-277): nothing it serves needs the owner's address,
/// and the restore drill counts that table as the owner. A deletion of suppressions or deliveries
/// is nobody's job but the application's.
#[sqlx::test]
async fn only_ctl_writes_contacts_and_workers_cannot_delete_deliveries(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let (_, a, _) = two_tenants_with_email(opts.clone(), conn.clone()).await;
    let worker = worker_pool(opts.clone(), conn.clone()).await;
    let app = app_pool(opts, conn).await;
    for (pool, sql) in [
        (&worker, "update shop_contacts set store_name = 'x'"),
        (&worker, "delete from shop_contacts"),
        (&worker, "delete from email_deliveries"),
        (&worker, "delete from email_suppressions"),
        (&worker, "delete from email_opt_outs"),
        (
            &worker,
            "insert into email_opt_outs (tenant_id, address_hash, category) values (gen_random_uuid(), sha256('x'), 'marketing')",
        ),
        (&app, "select count(*) from shop_contacts"),
        (&app, "update shop_contacts set store_name = 'x'"),
        (&app, "delete from shop_contacts"),
        (
            &app,
            "insert into email_deliveries (tenant_id, message_key, template, state) values (gen_random_uuid(), 'k', 't', 'sent')",
        ),
    ] {
        let err = as_tenant(pool, a.tenant, sql)
            .await
            .expect_err("a role changed what it may not");
        assert!(
            err.to_string().contains("permission denied"),
            "{sql}: {err}"
        );
    }
}

/// `shop/redact` deletes the shop's delivery records with the rest (audit L5), and only that
/// tenant's.
#[sqlx::test]
async fn redaction_deletes_the_shops_delivery_records_and_contact_and_no_one_elses(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let (_, a, b) = two_tenants_with_email(opts.clone(), conn.clone()).await;
    let owner = owner_pool(opts.clone(), conn.clone()).await;
    let db = Db::from_pool(ctl_pool(opts, conn).await);
    let mut tx = db.tenant(a.tenant).await.unwrap();
    assert!(redact::shop(&mut tx, a.shop).await.unwrap().is_some());
    tx.commit().await.unwrap();
    for (table, a_rows, b_rows) in [("email_deliveries", 0, 1), ("shop_contacts", 0, 1)] {
        let text = format!("select count(*) from {table} where tenant_id = $1");
        let count = |t: TenantId| {
            let owner = owner.clone();
            let text = text.clone();
            async move {
                sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(text))
                    .bind(t.as_uuid())
                    .fetch_one(&owner)
                    .await
                    .unwrap()
            }
        };
        assert_eq!(
            count(a.tenant).await,
            a_rows,
            "{table}: the redacted shop's rows"
        );
        assert_eq!(
            count(b.tenant).await,
            b_rows,
            "{table}: another tenant's rows"
        );
    }
    // The pseudonymous opt-out and suppression rows stay: an opt-out is honoured on reinstall.
    for table in ["email_suppressions", "email_opt_outs"] {
        let n: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
            "select count(*) from {table} where tenant_id = $1"
        )))
        .bind(a.tenant.as_uuid())
        .fetch_one(&owner)
        .await
        .unwrap();
        assert_eq!(n, 1, "{table}");
    }
}

/// The sweep for email data whose purpose has passed, with ages fixed in the migration.
#[sqlx::test]
async fn the_email_sweep_removes_old_deliveries_and_contacts_of_long_gone_shops_only(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let (_, a, b) = two_tenants_with_email(opts.clone(), conn.clone()).await;
    let owner = owner_pool(opts.clone(), conn.clone()).await;
    let db = Db::from_pool(worker_pool(opts, conn).await);
    // A's shop was uninstalled 31 days ago and its delivery record is 91 days old; B's shop was
    // uninstalled 10 days ago, and B's record is current.
    sqlx::query(
        "update shopify_shops set status = 'uninstalled', uninstalled_at = now() - interval '31 days'
          where tenant_id = $1",
    )
    .bind(a.tenant.as_uuid())
    .execute(&owner)
    .await
    .unwrap();
    sqlx::query(
        "update shopify_shops set status = 'uninstalled', uninstalled_at = now() - interval '10 days'
          where tenant_id = $1",
    )
    .bind(b.tenant.as_uuid())
    .execute(&owner)
    .await
    .unwrap();
    sqlx::query(
        "update email_deliveries set state = 'failed', updated_at = now() - interval '91 days'
          where tenant_id = $1",
    )
    .bind(a.tenant.as_uuid())
    .execute(&owner)
    .await
    .unwrap();

    let mut tx = db.public().await.unwrap();
    assert_eq!(retention::email_records(&mut tx).await.unwrap(), 2);
    tx.commit().await.unwrap();
    for (table, tenant, expected) in [
        ("shop_contacts", a.tenant, 0),
        ("email_deliveries", a.tenant, 0),
        ("shop_contacts", b.tenant, 1),
        ("email_deliveries", b.tenant, 1),
        ("email_suppressions", a.tenant, 1),
        ("email_opt_outs", a.tenant, 1),
    ] {
        let n: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
            "select count(*) from {table} where tenant_id = $1"
        )))
        .bind(tenant.as_uuid())
        .fetch_one(&owner)
        .await
        .unwrap();
        assert_eq!(n, expected, "{table} of {tenant}");
    }
    // A record still being sent is never swept, however old.
    sqlx::query(
        "update email_deliveries set state = 'sending', updated_at = now() - interval '200 days'",
    )
    .execute(&owner)
    .await
    .unwrap();
    let mut tx = db.public().await.unwrap();
    assert_eq!(retention::email_records(&mut tx).await.unwrap(), 0);
    tx.commit().await.unwrap();
}

/// A repeated `app/uninstalled` cancels the waiting scans but not the mail still to be sent
/// (audit L1).
#[sqlx::test]
async fn cancelling_pending_jobs_spares_the_email_queue(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let (_, _, a, _) = two_tenants(opts.clone(), conn.clone()).await;
    let owner = owner_pool(opts.clone(), conn.clone()).await;
    sqlx::query(
        "insert into jobs (id, queue, payload_schema, payload, tenant_id, state)
         values (gen_random_uuid(), 'email.send', 'email.send@1', '{}', $1, 'ready')",
    )
    .bind(a.tenant.as_uuid())
    .execute(&owner)
    .await
    .unwrap();
    let db = Db::from_pool(ctl_pool(opts, conn).await);
    let mut tx = db.tenant(a.tenant).await.unwrap();
    let cancelled = jobs::cancel_pending(&mut tx, "webhook.process")
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(cancelled, 1, "the scan job goes, the mail does not");
    let states: Vec<(String, String)> = sqlx::query_as(
        "select queue, state from jobs where tenant_id = $1 and queue in ('email.send', 'scan.plan') order by queue",
    )
    .bind(a.tenant.as_uuid())
    .fetch_all(&owner)
    .await
    .unwrap();
    assert!(
        states.contains(&("email.send".to_owned(), "ready".to_owned())),
        "{states:?}"
    );
}

#[sqlx::test]
async fn a_contact_cannot_point_at_another_tenants_shop_even_for_the_owner(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let (_, _, a, b) = two_tenants(opts.clone(), conn.clone()).await;
    let owner = owner_pool(opts, conn).await;
    let err = sqlx::query(
        "insert into shop_contacts (shop_id, tenant_id, email, store_name)
         values ($1, $2, 'x@shop.example', 'X')",
    )
    .bind(b.shop.as_uuid())
    .bind(a.tenant.as_uuid())
    .execute(&owner)
    .await
    .expect_err("a cross-tenant contact was stored");
    assert!(err.to_string().contains("foreign key"), "{err}");
}

#[sqlx::test]
async fn the_email_repository_returns_nothing_across_the_boundary(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let (_, a, b) = two_tenants_with_email(opts.clone(), conn.clone()).await;
    let db = Db::from_pool(ctl_pool(opts, conn).await);

    let mut tx = db.tenant(a.tenant).await.unwrap();
    // Tenant A cannot read, replace or delete tenant B's contact.
    assert!(
        email::get_shop_contact(&mut tx, a.shop)
            .await
            .unwrap()
            .is_some()
    );
    assert!(
        email::get_shop_contact(&mut tx, b.shop)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        !email::put_shop_contact(&mut tx, b.shop, "evil@shop.example", "Evil", None)
            .await
            .unwrap()
    );
    assert_eq!(
        email::delete_shop_contact(&mut tx, b.shop).await.unwrap(),
        0
    );
    // A's suppression of an address does not suppress it for B, and B's does not leak to A.
    email::suppress(
        &mut tx,
        "only-a@shop.example",
        email::SuppressionReason::Bounced,
    )
    .await
    .unwrap();
    assert!(
        email::is_suppressed(&mut tx, "only-a@shop.example")
            .await
            .unwrap()
    );
    // The hash ignores case and surrounding white space.
    assert!(
        email::is_suppressed(&mut tx, "  Only-A@Shop.example ")
            .await
            .unwrap()
    );
    tx.commit().await.unwrap();

    let mut tx = db.tenant(b.tenant).await.unwrap();
    assert!(
        !email::is_suppressed(&mut tx, "only-a@shop.example")
            .await
            .unwrap()
    );
    assert!(
        email::is_suppressed(&mut tx, "gone@shop.example")
            .await
            .unwrap()
    );
    assert!(
        email::get_shop_contact(&mut tx, b.shop)
            .await
            .unwrap()
            .is_some()
    );
    tx.rollback().await.unwrap();
}

#[sqlx::test]
async fn the_suppression_list_keeps_a_salted_hash_never_the_address(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let (_, a, b) = two_tenants_with_email(opts.clone(), conn.clone()).await;
    let owner = owner_pool(opts, conn).await;
    let everything: String =
        sqlx::query_scalar("select string_agg(t::text, ' ') from email_suppressions t")
            .fetch_one(&owner)
            .await
            .unwrap();
    assert!(!everything.to_lowercase().contains("gone@shop.example"));
    // The same address hashes differently for two tenants, so the lists cannot be joined.
    let hashes: Vec<Vec<u8>> = sqlx::query_scalar(
        "select address_hash from email_suppressions where tenant_id in ($1, $2) order by tenant_id",
    )
    .bind(a.tenant.as_uuid())
    .bind(b.tenant.as_uuid())
    .fetch_all(&owner)
    .await
    .unwrap();
    assert_eq!(hashes.len(), 2);
    assert_ne!(hashes[0], hashes[1]);
    assert!(hashes.iter().all(|h| h.len() == 32));
}

#[sqlx::test]
async fn the_delivery_record_holds_no_address_subject_or_body(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let owner = owner_pool(opts, conn).await;
    let columns: Vec<String> = sqlx::query_scalar(
        "select column_name::text from information_schema.columns
          where table_name = 'email_deliveries' order by ordinal_position",
    )
    .fetch_all(&owner)
    .await
    .unwrap();
    assert_eq!(
        columns,
        [
            "tenant_id",
            "message_key",
            "template",
            "state",
            "tries",
            "message_id",
            "error_code",
            "created_at",
            "updated_at"
        ]
    );
}

#[sqlx::test]
async fn an_opt_out_is_idempotent_per_category_and_can_be_taken_back(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let (_, a, _) = two_tenants_with_email(opts.clone(), conn.clone()).await;
    let app = Db::from_pool(app_pool(opts, conn).await);
    let hash = [9u8; 32];
    let mut tx = app.tenant(a.tenant).await.unwrap();
    for _ in 0..2 {
        email::opt_out(&mut tx, &hash, email::OptOutCategory::Marketing)
            .await
            .unwrap();
    }
    assert_eq!(
        email::opted_out(&mut tx, &hash).await.unwrap(),
        vec![email::OptOutCategory::Marketing]
    );
    assert!(
        email::opt_in(&mut tx, &hash, email::OptOutCategory::Marketing)
            .await
            .unwrap(),
        "the first opt-in removes the row"
    );
    assert!(
        !email::opt_in(&mut tx, &hash, email::OptOutCategory::Marketing)
            .await
            .unwrap(),
        "the second finds nothing to remove"
    );
    assert!(
        email::opted_out(&mut tx, &hash).await.unwrap().is_empty(),
        "nothing left opted out"
    );
    tx.commit().await.unwrap();
}

// --- The scheduled rescan listing (ADR-279, ADR-312) ---------------------------------

#[sqlx::test]
async fn only_the_worker_may_list_the_shops_due_a_rescan_and_every_tenant_gets_a_turn(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let (_, _, a, b) = two_tenants(opts.clone(), conn.clone()).await;
    let owner = owner_pool(opts.clone(), conn.clone()).await;
    // The seeded tenants' scans are referenced by findings, fixes and evidence; this test
    // needs shops with no scan at all, so it clears them with everything that points at them.
    sqlx::query("truncate table scans cascade")
        .execute(&owner)
        .await
        .unwrap();
    sqlx::query("update sites set settings = '{\"weekly_rescan\": true}'")
        .execute(&owner)
        .await
        .unwrap();

    for function in [
        "due_weekly_rescans(uuid, int)",
        "due_scheduled_rescans(int, int, uuid)",
    ] {
        let (public, worker, app): (bool, bool, bool) =
            sqlx::query_as(sqlx::AssertSqlSafe(format!(
                "select has_function_privilege('public', '{function}', 'execute'),
                    has_function_privilege('rampsmith_worker', '{function}', 'execute'),
                    has_function_privilege('rampsmith_app', '{function}', 'execute')"
            )))
            .fetch_one(&owner)
            .await
            .unwrap();
        assert_eq!((public, worker, app), (false, true, false), "{function}");
    }

    // Both tenants' shops come back, and with room for one each a round names both tenants.
    let db = Db::from_pool(worker_pool(opts.clone(), conn.clone()).await);
    let mut tx = db.public().await.unwrap();
    let found = db::repo::rescans::due(&mut tx, 10, 1).await.unwrap();
    tx.commit().await.unwrap();
    let mut seen: Vec<_> = found.iter().map(|due| (due.tenant, due.shop)).collect();
    seen.sort_by_key(|(_, shop)| shop.as_uuid());
    let mut expected = vec![(a.tenant, a.shop), (b.tenant, b.shop)];
    expected.sort_by_key(|(_, shop)| shop.as_uuid());
    assert_eq!(seen, expected);

    // The app role cannot call either function.
    let app = Db::from_pool(app_pool(opts, conn).await);
    let mut tx = app.public().await.unwrap();
    assert!(
        db::repo::rescans::due(&mut tx, 10, 1).await.is_err(),
        "the app role listed the shops due a rescan"
    );
}
