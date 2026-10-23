//! `rsctl shops redact` (re-audit M-2, ADR-269), against PostgreSQL with the real roles.

// Test code: PLAN §8 denies these lints outside tests only.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    unreachable_pub
)]

use std::io::Cursor;
use std::sync::Arc;
use std::time::Duration;

use clap::Parser as _;
use db::Db;
use db::repo::{shopify, sites, tenants};
use domain::{Platform, TenantId, TenantKind};
use rsctl::app::{self, EXIT_FAILED, EXIT_OK, EXIT_UNUSABLE, Io, Runtime};
use rsctl::cli::{Cli, Command, ShopRedactArgs, ShopsCommand};
use rsctl::doctor::Endpoints;
use rsctl::secret::Redactor;
use rsctl::vars::MapEnv;
use sqlx::PgPool;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};

const PASSWORD: &str = "rampsmith-test-only";

fn args(extra: &[&str]) -> ShopRedactArgs {
    let mut line = vec![
        "rsctl",
        "shops",
        "redact",
        "--shop",
        "store-1.myshopify.com",
        "--confirmed-by",
        "ops-1",
        "--evidence",
        "Partner Dashboard shows the app uninstalled",
    ];
    line.extend_from_slice(extra);
    match Cli::try_parse_from(line).unwrap().command {
        Command::Shops {
            action: ShopsCommand::Redact(args),
        } => args,
        other => panic!("{other:?}"),
    }
}

struct Run {
    code: u8,
    out: String,
    err: String,
}

async fn run(args: &ShopRedactArgs, db: &Db) -> Run {
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let mut stdin = Cursor::new(Vec::new());
    let code = rsctl::shops::run(
        args,
        db,
        &Redactor::new(),
        &mut Io {
            stdin: &mut stdin,
            stdout: &mut out,
            stderr: &mut err,
        },
    )
    .await;
    Run {
        code,
        out: String::from_utf8(out).unwrap(),
        err: String::from_utf8(err).unwrap(),
    }
}

async fn login(
    owner: &PgPool,
    opts: &PgPoolOptions,
    conn: &PgConnectOptions,
    name: &str,
    groups: &str,
) -> Db {
    for attempt in 0..20_u64 {
        let _ = sqlx::query(sqlx::AssertSqlSafe(format!(
            "do $$ begin
               create role {name} login password '{PASSWORD}' in role {groups};
             exception when duplicate_object or unique_violation then null;
             end $$"
        )))
        .execute(owner)
        .await;
        let ready: bool = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
            "select exists (select 1 from pg_roles where rolname = '{name}')"
        )))
        .fetch_one(owner)
        .await
        .unwrap_or(false);
        if ready {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50 * (attempt + 1))).await;
    }
    let pool = opts
        .clone()
        .max_connections(2)
        .connect_with(conn.clone().username(name).password(PASSWORD))
        .await
        .unwrap();
    Db::from_pool(pool)
}

async fn seed(owner: &PgPool) {
    let db = Db::from_pool(owner.clone());
    let mut tx = db.tenant(TenantId::new()).await.unwrap();
    tenants::create(&mut tx, TenantKind::ShopifyStore)
        .await
        .unwrap();
    let site = sites::create(
        &mut tx,
        &sites::NewSite {
            platform: Platform::Shopify,
            base_url: "https://store-1.example".to_owned(),
            primary_locale: "en".to_owned(),
        },
    )
    .await
    .unwrap();
    shopify::install(
        &mut tx,
        &shopify::NewShop {
            site_id: site.id,
            shop_domain: "store-1.myshopify.com".to_owned(),
            scopes: vec!["read_products".to_owned()],
            api_version: "2026-10".to_owned(),
        },
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
}

async fn status(owner: &PgPool) -> String {
    sqlx::query_scalar("select status from shopify_shops")
        .fetch_one(owner)
        .await
        .unwrap()
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn it_shows_what_it_would_do_and_changes_nothing_without_execute(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let owner = opts.clone().connect_with(conn.clone()).await.unwrap();
    seed(&owner).await;
    let ctl = login(
        &owner,
        &opts,
        &conn,
        "rs_rsctl_ctl",
        "rampsmith_worker, rampsmith_redactor",
    )
    .await;
    let ran = run(&args(&[]), &ctl).await;
    assert_eq!(ran.code, EXIT_OK, "{}", ran.err);
    assert!(ran.out.contains("Nothing was changed"), "{}", ran.out);
    assert_eq!(status(&owner).await, "installed");
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn execute_redacts_the_shop_once_and_records_who_confirmed(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let owner = opts.clone().connect_with(conn.clone()).await.unwrap();
    seed(&owner).await;
    let ctl = login(
        &owner,
        &opts,
        &conn,
        "rs_rsctl_ctl",
        "rampsmith_worker, rampsmith_redactor",
    )
    .await;
    let ran = run(&args(&["--execute"]), &ctl).await;
    assert_eq!(ran.code, EXIT_OK, "{}", ran.err);
    assert!(
        ran.out.contains("redacted (was `installed`)"),
        "{}",
        ran.out
    );
    assert_eq!(status(&owner).await, "redacted");
    let entry: serde_json::Value = sqlx::query_scalar(
        "select data from audit_log where action = 'compliance.shop_redacted_by_operator'",
    )
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(entry["confirmed_by"], "ops-1");
    assert_eq!(
        entry["evidence"],
        "Partner Dashboard shows the app uninstalled"
    );

    let again = run(&args(&["--execute"]), &ctl).await;
    assert_eq!(again.code, EXIT_FAILED);
    assert!(again.err.contains("already redacted"), "{}", again.err);
    let mut unknown = args(&["--execute"]);
    unknown.shop = "nobody.myshopify.com".to_owned();
    assert_eq!(run(&unknown, &ctl).await.code, EXIT_FAILED);
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn it_refuses_a_login_that_is_not_ctls_and_bad_arguments(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let owner = opts.clone().connect_with(conn.clone()).await.unwrap();
    seed(&owner).await;
    // The engine's profile cannot delete AI call records, so it cannot redact.
    let engine = login(&owner, &opts, &conn, "rs_rsctl_engine", "rampsmith_worker").await;
    let ran = run(&args(&["--execute"]), &engine).await;
    assert_eq!(ran.code, EXIT_UNUSABLE);
    assert!(ran.err.contains("redact_ai_calls"), "{}", ran.err);
    // The migration owner is refused too.
    let ran = run(&args(&["--execute"]), &Db::from_pool(owner.clone())).await;
    assert_eq!(ran.code, EXIT_UNUSABLE);
    assert!(ran.err.contains("superuser"), "{}", ran.err);
    assert_eq!(status(&owner).await, "installed");

    let ctl = login(
        &owner,
        &opts,
        &conn,
        "rs_rsctl_ctl",
        "rampsmith_worker, rampsmith_redactor",
    )
    .await;
    let mut bad_shop = args(&["--execute"]);
    bad_shop.shop = "example.com".to_owned();
    assert_eq!(run(&bad_shop, &ctl).await.code, EXIT_UNUSABLE);
    let mut no_name = args(&["--execute"]);
    no_name.confirmed_by = "  ".to_owned();
    assert_eq!(run(&no_name, &ctl).await.code, EXIT_UNUSABLE);
    let mut long = args(&["--execute"]);
    long.evidence = "x".repeat(201);
    assert_eq!(run(&long, &ctl).await.code, EXIT_UNUSABLE);
    assert_eq!(status(&owner).await, "installed");
}

#[tokio::test]
async fn without_a_database_url_it_explains_where_to_run_it() {
    let cli = Cli::try_parse_from([
        "rsctl",
        "shops",
        "redact",
        "--shop",
        "store-1.myshopify.com",
        "--confirmed-by",
        "ops-1",
        "--evidence",
        "checked",
        "--execute",
    ])
    .unwrap();
    let runtime = Runtime {
        env: Arc::new(MapEnv::from_pairs(&[])),
        endpoints: Endpoints::default(),
        clock: Arc::new(time::OffsetDateTime::now_utc),
    };
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let mut stdin = Cursor::new(Vec::new());
    let code = app::run(
        cli,
        runtime,
        &mut Io {
            stdin: &mut stdin,
            stdout: &mut out,
            stderr: &mut err,
        },
    )
    .await;
    assert_eq!(code, EXIT_UNUSABLE);
    assert!(String::from_utf8(err).unwrap().contains("railway ssh"));
}
