//! Behaviour of the repositories within one tenant.

// Integration tests are test code: PLAN §8 denies these lints outside tests only.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod support;

use db::Db;
use db::repo::{audit, findings, fixes, occurrences, scans, shopify, sites};
use domain::{
    FindingStatus, FixChannel, FixKind, FixOrigin, FixStatus, Impact, PageState, Platform,
    ScanStatus, ScanTrigger, TenantKind, UserId,
};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use support::{app_pool, assert_empty, owner_pool, seed};

async fn app_db(opts: PgPoolOptions, conn: PgConnectOptions) -> Db {
    Db::from_pool(app_pool(opts, conn).await)
}

#[sqlx::test]
async fn a_tenant_transaction_commits_and_rolls_back(opts: PgPoolOptions, conn: PgConnectOptions) {
    let db = app_db(opts, conn).await;
    let tenant = domain::TenantId::new();

    let mut tx = db.tenant(tenant).await.unwrap();
    db::repo::tenants::create(&mut tx, TenantKind::Organization)
        .await
        .unwrap();
    tx.rollback().await.unwrap();
    let mut tx = db.tenant(tenant).await.unwrap();
    assert!(db::repo::tenants::get(&mut tx).await.unwrap().is_none());

    db::repo::tenants::create(&mut tx, TenantKind::Organization)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let mut tx = db.tenant(tenant).await.unwrap();
    assert_eq!(
        db::repo::tenants::get(&mut tx).await.unwrap().unwrap().kind,
        TenantKind::Organization
    );
}

#[sqlx::test]
async fn recording_a_finding_again_merges_it(opts: PgPoolOptions, conn: PgConnectOptions) {
    let db = app_db(opts, conn).await;
    let g = seed(&db, 7).await;
    let mut tx = db.tenant(g.tenant).await.unwrap();
    let second_scan = scans::create(
        &mut tx,
        &scans::NewScan {
            site_id: g.site,
            trigger: ScanTrigger::Scheduled,
            ruleset_version: "v".to_owned(),
            theme_ref: None,
        },
    )
    .await
    .unwrap();
    let merged = findings::record(
        &mut tx,
        &findings::Observation {
            site_id: g.site,
            scan_id: second_scan.id,
            fingerprint: [7; 32],
            rule_id: "image-alt".to_owned(),
            criteria: vec!["1.1.1".to_owned()],
            impact: Impact::Critical,
            occurrence_count: 2000,
        },
    )
    .await
    .unwrap();
    assert_eq!(merged.id, g.finding, "same fingerprint, same finding");
    assert_eq!(merged.first_seen_scan, g.scan);
    assert_eq!(merged.last_seen_scan, second_scan.id);
    assert_eq!(merged.occurrence_count, 2000);
    assert_eq!(
        findings::list_for_site(&mut tx, g.site, None)
            .await
            .unwrap()
            .len(),
        1
    );
}

#[sqlx::test]
async fn a_fixed_finding_that_reappears_is_reopened(opts: PgPoolOptions, conn: PgConnectOptions) {
    let db = app_db(opts, conn).await;
    let g = seed(&db, 8).await;
    let mut tx = db.tenant(g.tenant).await.unwrap();
    findings::set_status(&mut tx, g.finding, FindingStatus::Fixed)
        .await
        .unwrap()
        .unwrap();
    let again = findings::record(
        &mut tx,
        &findings::Observation {
            site_id: g.site,
            scan_id: g.scan,
            fingerprint: [8; 32],
            rule_id: "image-alt".to_owned(),
            criteria: vec!["1.1.1".to_owned()],
            impact: Impact::Critical,
            occurrence_count: 1,
        },
    )
    .await
    .unwrap();
    assert_eq!(again.status, FindingStatus::Open);
}

#[sqlx::test]
async fn accepted_risk_survives_a_new_observation(opts: PgPoolOptions, conn: PgConnectOptions) {
    let db = app_db(opts, conn).await;
    let g = seed(&db, 9).await;
    let mut tx = db.tenant(g.tenant).await.unwrap();
    findings::set_status(&mut tx, g.finding, FindingStatus::AcceptedRisk)
        .await
        .unwrap()
        .unwrap();
    let again = findings::record(
        &mut tx,
        &findings::Observation {
            site_id: g.site,
            scan_id: g.scan,
            fingerprint: [9; 32],
            rule_id: "image-alt".to_owned(),
            criteria: vec!["1.1.1".to_owned()],
            impact: Impact::Critical,
            occurrence_count: 4,
        },
    )
    .await
    .unwrap();
    assert_eq!(again.status, FindingStatus::AcceptedRisk);
}

#[sqlx::test]
async fn findings_filter_by_status(opts: PgPoolOptions, conn: PgConnectOptions) {
    let db = app_db(opts, conn).await;
    let g = seed(&db, 10).await;
    let mut tx = db.tenant(g.tenant).await.unwrap();
    assert_eq!(
        findings::list_for_site(&mut tx, g.site, Some(FindingStatus::Open))
            .await
            .unwrap()
            .len(),
        1
    );
    assert_empty(
        &findings::list_for_site(&mut tx, g.site, Some(FindingStatus::Fixed))
            .await
            .unwrap(),
    );
}

#[sqlx::test]
async fn a_scan_starts_once(opts: PgPoolOptions, conn: PgConnectOptions) {
    let db = app_db(opts, conn).await;
    let g = seed(&db, 11).await;
    let mut tx = db.tenant(g.tenant).await.unwrap();
    let started = scans::mark_started(&mut tx, g.scan, 50)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(started.status, ScanStatus::Running);
    assert_eq!(started.pages_planned, 50);
    assert!(started.started_at.is_some());
    assert!(
        scans::mark_started(&mut tx, g.scan, 50)
            .await
            .unwrap()
            .is_none(),
        "already running"
    );
    assert_eq!(
        scans::list_for_site(&mut tx, g.site, 10)
            .await
            .unwrap()
            .len(),
        1
    );
}

#[sqlx::test]
async fn a_fix_is_approved_only_from_proposed(opts: PgPoolOptions, conn: PgConnectOptions) {
    let db = app_db(opts, conn).await;
    let g = seed(&db, 12).await;
    let mut tx = db.tenant(g.tenant).await.unwrap();
    let approver = UserId::new();
    let fix = fixes::approve(&mut tx, g.fix, approver)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(fix.status, FixStatus::Approved);
    assert_eq!(fix.approved_by, Some(approver));
    assert!(fix.approved_at.is_some());
    assert!(
        fixes::approve(&mut tx, g.fix, approver)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        fixes::list_for_finding(&mut tx, g.finding)
            .await
            .unwrap()
            .len(),
        1
    );
    assert_eq!(fix.finding_ids, vec![g.finding]);
    assert!((fix.confidence.unwrap() - 0.912).abs() < 1e-9);
}

#[sqlx::test]
async fn a_fix_must_use_a_channel_that_carries_its_kind(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let db = app_db(opts, conn).await;
    let g = seed(&db, 13).await;
    let mut tx = db.tenant(g.tenant).await.unwrap();
    let result = fixes::propose(
        &mut tx,
        &fixes::NewFix {
            site_id: g.site,
            kind: FixKind::Code,
            channel: FixChannel::AdminApi,
            origin: FixOrigin::Rule,
            model: None,
            prompt_version: None,
            confidence: None,
            diff: None,
            finding_ids: vec![g.finding],
        },
    )
    .await;
    assert!(matches!(result, Err(db::DbError::Invalid(_))), "{result:?}");
}

#[sqlx::test]
async fn an_ai_fix_must_name_its_model_and_prompt(opts: PgPoolOptions, conn: PgConnectOptions) {
    let db = app_db(opts, conn).await;
    let g = seed(&db, 14).await;
    let mut tx = db.tenant(g.tenant).await.unwrap();
    let result = fixes::propose(
        &mut tx,
        &fixes::NewFix {
            site_id: g.site,
            kind: FixKind::Data,
            channel: FixChannel::AdminApi,
            origin: FixOrigin::Ai,
            model: None,
            prompt_version: None,
            confidence: Some(0.5),
            diff: None,
            finding_ids: vec![g.finding],
        },
    )
    .await;
    assert!(matches!(result, Err(db::DbError::Invalid(_))), "{result:?}");
}

#[sqlx::test]
async fn occurrences_are_listed_newest_first(opts: PgPoolOptions, conn: PgConnectOptions) {
    let db = app_db(opts, conn).await;
    let g = seed(&db, 15).await;
    let mut tx = db.tenant(g.tenant).await.unwrap();
    let later = time::OffsetDateTime::now_utc();
    let inserted = occurrences::insert(
        &mut tx,
        &[occurrences::NewOccurrence {
            finding_id: g.finding,
            scan_id: g.scan,
            page_url: "https://store-15.example/cart".to_owned(),
            page_state: PageState::CartDrawer,
            target: "#cart button".to_owned(),
            html_excerpt: "<button></button>".to_owned(),
            captured_at: later,
        }],
    )
    .await
    .unwrap();
    assert_eq!(inserted, 1);
    let listed = occurrences::list_for_finding(&mut tx, g.finding, 10)
        .await
        .unwrap();
    assert_eq!(listed.len(), 2);
    assert_eq!(listed[0].page_state, PageState::CartDrawer);
}

#[sqlx::test]
async fn html_excerpts_are_capped_at_512_characters(opts: PgPoolOptions, conn: PgConnectOptions) {
    let db = app_db(opts, conn).await;
    let g = seed(&db, 16).await;
    let mut tx = db.tenant(g.tenant).await.unwrap();
    let result = occurrences::insert(
        &mut tx,
        &[occurrences::NewOccurrence {
            finding_id: g.finding,
            scan_id: g.scan,
            page_url: "https://store-16.example/".to_owned(),
            page_state: PageState::Default,
            target: "div".to_owned(),
            html_excerpt: "x".repeat(513),
            captured_at: time::OffsetDateTime::now_utc(),
        }],
    )
    .await;
    assert!(matches!(result, Err(db::DbError::Invalid(_))), "{result:?}");
}

#[sqlx::test]
async fn the_audit_log_is_append_only_even_for_the_owner(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let db = app_db(opts.clone(), conn.clone()).await;
    let g = seed(&db, 17).await;
    let mut tx = db.tenant(g.tenant).await.unwrap();
    let entries = audit::list(&mut tx, 10).await.unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].action, "fix.proposed");
    tx.rollback().await.unwrap();

    let owner = owner_pool(opts, conn).await;
    for sql in [
        "update audit_log set action = 'fix.erased'",
        "delete from audit_log",
        "truncate audit_log",
    ] {
        let err = sqlx::query(sql).execute(&owner).await.expect_err(sql);
        assert!(err.to_string().contains("append-only"), "{sql}: {err}");
    }
}

#[sqlx::test]
async fn audit_actions_must_be_dotted_lowercase(opts: PgPoolOptions, conn: PgConnectOptions) {
    let db = app_db(opts, conn).await;
    let g = seed(&db, 18).await;
    let mut tx = db.tenant(g.tenant).await.unwrap();
    let result = audit::append(
        &mut tx,
        &audit::NewEntry {
            actor_kind: domain::ActorKind::User,
            actor_id: Some("u_1".to_owned()),
            action: "Fix Approved".to_owned(),
            subject_type: "fix".to_owned(),
            subject_id: g.fix.as_uuid(),
            data: serde_json::json!({}),
        },
    )
    .await;
    assert!(matches!(result, Err(db::DbError::Invalid(_))), "{result:?}");
}

#[sqlx::test]
async fn every_domain_spelling_is_accepted_by_the_check_constraints(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let db = app_db(opts, conn).await;
    let g = seed(&db, 19).await;
    let mut tx = db.tenant(g.tenant).await.unwrap();
    for platform in Platform::ALL {
        sites::create(
            &mut tx,
            &sites::NewSite {
                platform,
                base_url: "https://p.example".to_owned(),
                primary_locale: "de".to_owned(),
            },
        )
        .await
        .unwrap();
    }
    for trigger in ScanTrigger::ALL {
        scans::create(
            &mut tx,
            &scans::NewScan {
                site_id: g.site,
                trigger,
                ruleset_version: "v".to_owned(),
                theme_ref: None,
            },
        )
        .await
        .unwrap();
    }
    for status in FindingStatus::ALL {
        findings::set_status(&mut tx, g.finding, status)
            .await
            .unwrap()
            .unwrap();
    }
    for impact in Impact::ALL {
        let mut fingerprint = [0u8; 32];
        fingerprint[0] = 200 + u8::try_from(impact.weight()).unwrap();
        findings::record(
            &mut tx,
            &findings::Observation {
                site_id: g.site,
                scan_id: g.scan,
                fingerprint,
                rule_id: "r".to_owned(),
                criteria: vec![],
                impact,
                occurrence_count: 1,
            },
        )
        .await
        .unwrap();
    }
    for state in PageState::ALL {
        occurrences::insert(
            &mut tx,
            &[occurrences::NewOccurrence {
                finding_id: g.finding,
                scan_id: g.scan,
                page_url: "https://p.example/".to_owned(),
                page_state: state,
                target: "a".to_owned(),
                html_excerpt: "<a></a>".to_owned(),
                captured_at: time::OffsetDateTime::now_utc(),
            }],
        )
        .await
        .unwrap();
    }
    for (kind, channel) in [
        (FixKind::Data, FixChannel::AdminApi),
        (FixKind::Code, FixChannel::GithubPr),
        (FixKind::Code, FixChannel::ThemePackage),
    ] {
        for origin in [FixOrigin::Rule, FixOrigin::Human] {
            fixes::propose(
                &mut tx,
                &fixes::NewFix {
                    site_id: g.site,
                    kind,
                    channel,
                    origin,
                    model: None,
                    prompt_version: None,
                    confidence: None,
                    diff: None,
                    finding_ids: vec![],
                },
            )
            .await
            .unwrap();
        }
    }
    for actor_kind in domain::ActorKind::ALL {
        audit::append(
            &mut tx,
            &audit::NewEntry {
                actor_kind,
                actor_id: None,
                action: "test.spelling".to_owned(),
                subject_type: "t".to_owned(),
                subject_id: g.fix.as_uuid(),
                data: serde_json::json!({}),
            },
        )
        .await
        .unwrap();
    }
    tx.commit().await.unwrap();
}

#[sqlx::test]
async fn every_status_spelling_is_accepted_by_the_check_constraints(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let pool = app_pool(opts, conn).await;
    let db = Db::from_pool(pool.clone());
    let g = seed(&db, 20).await;
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("select set_config('app.tenant_id', $1, true)")
        .bind(g.tenant.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    for status in ScanStatus::ALL {
        sqlx::query("insert into scans (id, tenant_id, site_id, trigger, status, ruleset_version) values ($1, $2, $3, 'manual', $4, 'v')")
            .bind(domain::ScanId::new().as_uuid())
            .bind(g.tenant.as_uuid())
            .bind(g.site.as_uuid())
            .bind(status.as_str())
            .execute(&mut *tx)
            .await
            .unwrap_or_else(|e| panic!("{status}: {e}"));
    }
    for status in FixStatus::ALL {
        sqlx::query("update fixes set status = $2 where id = $1")
            .bind(g.fix.as_uuid())
            .bind(status.as_str())
            .execute(&mut *tx)
            .await
            .unwrap_or_else(|e| panic!("{status}: {e}"));
    }
    for (i, status) in domain::ShopStatus::ALL.into_iter().enumerate() {
        sqlx::query("insert into shopify_shops (id, tenant_id, site_id, shop_domain, scopes, api_version, status, installed_at) values ($1, $2, $3, $4, '{read_products}', '2026-10', $5, now())")
            .bind(domain::ShopId::new().as_uuid())
            .bind(g.tenant.as_uuid())
            .bind(g.site.as_uuid())
            .bind(format!("shop-{i}.myshopify.com"))
            .bind(status.as_str())
            .execute(&mut *tx)
            .await
            .unwrap_or_else(|e| panic!("{status}: {e}"));
    }
    tx.rollback().await.unwrap();
}

#[sqlx::test]
async fn occurrence_partitions_exist_for_this_month_and_the_next_three(pool: sqlx::PgPool) {
    let names: Vec<String> = sqlx::query_scalar(
        "select c.relname::text from pg_inherits i join pg_class c on c.oid = i.inhrelid
          where i.inhparent = 'finding_occurrences'::regclass order by 1",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(names.len(), 4, "{names:?}");
    // Creating them again is a no-op.
    sqlx::query("select ensure_finding_occurrence_partitions(3)")
        .execute(&pool)
        .await
        .unwrap();
    let again: i64 = sqlx::query_scalar(
        "select count(*) from pg_inherits where inhparent = 'finding_occurrences'::regclass",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(again, 4);
}

#[sqlx::test]
async fn a_job_enqueued_in_a_tenant_transaction_commits_with_it(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let db = app_db(opts.clone(), conn.clone()).await;
    let owner = owner_pool(opts, conn).await;
    let g = seed(&db, 21).await;
    let job = || {
        queue::NewJob::new(
            "scan.plan",
            "scan.plan@1",
            serde_json::json!({ "scan": g.scan.to_string() }),
        )
    };

    let mut tx = db.tenant(g.tenant).await.unwrap();
    db::repo::jobs::enqueue(&mut tx, job()).await.unwrap();
    tx.rollback().await.unwrap();
    let count: i64 = sqlx::query_scalar("select count(*) from jobs")
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(count, 0, "a rolled-back transaction left a job behind");

    let other_tenant = domain::TenantId::new();
    let mut tx = db.tenant(g.tenant).await.unwrap();
    db::repo::jobs::enqueue(&mut tx, job().for_tenant(other_tenant.as_uuid()))
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let tenant: uuid::Uuid = sqlx::query_scalar("select tenant_id from jobs")
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(
        tenant,
        g.tenant.as_uuid(),
        "the transaction's tenant always wins"
    );
}

#[sqlx::test]
async fn the_app_role_reads_the_schema_version_this_build_expects(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let db = app_db(opts, conn).await;
    db.ping().await.unwrap();
    let applied = db.schema_version().await.unwrap();
    assert_eq!(applied, Some(db::expected_schema_version()));
    assert!(db::expected_schema_version() >= 20_261_017_000_004);
}

// --- Shopify shops and tokens (ADR-022) ---------------------------------------------------

#[sqlx::test]
async fn a_shop_is_found_by_domain_from_the_app_role_without_a_tenant(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let db = app_db(opts, conn).await;
    let a = seed(&db, 1).await;
    let b = seed(&db, 2).await;

    let found = db
        .shop_by_domain("store-2.myshopify.com")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(found.tenant, b.tenant);
    assert_eq!(found.shop, b.shop);
    assert_eq!(found.status, domain::ShopStatus::Installed);
    assert_eq!(
        db.shop_by_domain("store-1.myshopify.com")
            .await
            .unwrap()
            .unwrap()
            .tenant,
        a.tenant
    );
    assert!(
        db.shop_by_domain("store-3.myshopify.com")
            .await
            .unwrap()
            .is_none()
    );
    // Exact match only: no pattern, no case folding.
    assert!(
        db.shop_by_domain("store-%.myshopify.com")
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        db.shop_by_domain("STORE-1.myshopify.com")
            .await
            .unwrap()
            .is_none()
    );
}

#[sqlx::test]
async fn a_shop_domain_belongs_to_one_tenant(opts: PgPoolOptions, conn: PgConnectOptions) {
    let db = app_db(opts, conn).await;
    let a = seed(&db, 1).await;
    let other = seed(&db, 2).await;
    let mut tx = db.tenant(other.tenant).await.unwrap();
    let err = shopify::install(
        &mut tx,
        &shopify::NewShop {
            site_id: other.site,
            shop_domain: "store-1.myshopify.com".to_owned(),
            scopes: vec![],
            api_version: "2026-10".to_owned(),
        },
    )
    .await
    .unwrap_err();
    assert!(matches!(err, db::DbError::Conflict(_)), "{err:?}");
    let _ = a;
}

#[sqlx::test]
async fn shop_domains_and_api_versions_are_checked(opts: PgPoolOptions, conn: PgConnectOptions) {
    let db = app_db(opts, conn).await;
    let g = seed(&db, 1).await;
    for (domain, version) in [
        ("evil.example.com", "2026-10"),
        ("Store.myshopify.com", "2026-10"),
        ("new.myshopify.com", "latest"),
    ] {
        let mut tx = db.tenant(g.tenant).await.unwrap();
        let err = shopify::install(
            &mut tx,
            &shopify::NewShop {
                site_id: g.site,
                shop_domain: domain.to_owned(),
                scopes: vec![],
                api_version: version.to_owned(),
            },
        )
        .await
        .unwrap_err();
        assert!(
            matches!(err, db::DbError::Invalid(_)),
            "{domain} {version}: {err:?}"
        );
    }
}

#[sqlx::test]
async fn reinstalling_a_shop_refreshes_scopes_and_clears_uninstall(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let db = app_db(opts, conn).await;
    let g = seed(&db, 1).await;
    let mut tx = db.tenant(g.tenant).await.unwrap();
    let before = shopify::get(&mut tx, g.shop).await.unwrap().unwrap();
    let scopes = vec!["read_products".to_owned(), "read_themes".to_owned()];
    let after = shopify::reinstall(&mut tx, g.shop, &scopes, "2026-10")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(after.scopes, scopes);
    assert_eq!(after.status, domain::ShopStatus::Installed);
    assert_eq!(after.installed_at, before.installed_at, "already installed");
    assert!(after.uninstalled_at.is_none());
}

#[sqlx::test]
async fn token_writes_bump_the_version_and_rotation_is_compare_and_swap(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let db = app_db(opts, conn).await;
    let g = seed(&db, 1).await;
    let mut tx = db.tenant(g.tenant).await.unwrap();

    let stored = shopify::get_tokens(&mut tx, g.shop).await.unwrap().unwrap();
    assert_eq!(stored.version, 0);
    assert_eq!(stored.tokens, support::sealed_tokens(1));

    // Exchange replaces the row and bumps the version.
    let v1 = shopify::put_tokens(&mut tx, g.shop, Some(0), &support::sealed_tokens(2))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(v1, 1);

    // A writer holding the current version wins once; a stale one loses and changes nothing.
    let v2 = shopify::rotate(&mut tx, g.shop, v1, &support::sealed_tokens(3))
        .await
        .unwrap();
    assert_eq!(v2, Some(2));
    let lost = shopify::rotate(&mut tx, g.shop, v1, &support::sealed_tokens(4))
        .await
        .unwrap();
    assert_eq!(lost, None);
    let now = shopify::get_tokens(&mut tx, g.shop).await.unwrap().unwrap();
    assert_eq!(now.version, 2);
    assert_eq!(now.tokens, support::sealed_tokens(3));

    assert!(shopify::delete_tokens(&mut tx, g.shop).await.unwrap());
    assert!(
        shopify::get_tokens(&mut tx, g.shop)
            .await
            .unwrap()
            .is_none()
    );
    assert!(!shopify::delete_tokens(&mut tx, g.shop).await.unwrap());
}

/// Audit L5, ADR-044: an exchange stores its pair only if the row is still as the caller read
/// it. `None` means "I found no row", `Some(v)` means "I found the row at version v".
#[sqlx::test]
async fn exchange_writes_are_compare_and_swap(opts: PgPoolOptions, conn: PgConnectOptions) {
    let db = app_db(opts, conn).await;
    let g = seed(&db, 1).await; // tokens exist, version 0
    let mut tx = db.tenant(g.tenant).await.unwrap();
    let seeded = support::sealed_tokens(1);

    // "No row" is wrong while one exists; so is a version the row never had. Nothing changes.
    for wrong in [None, Some(7), Some(-1)] {
        let lost = shopify::put_tokens(&mut tx, g.shop, wrong, &support::sealed_tokens(2))
            .await
            .unwrap();
        assert_eq!(lost, None, "{wrong:?}");
    }
    let kept = shopify::get_tokens(&mut tx, g.shop).await.unwrap().unwrap();
    assert_eq!((kept.version, &kept.tokens), (0, &seeded));

    // The version the caller read wins, once.
    let won = shopify::put_tokens(&mut tx, g.shop, Some(0), &support::sealed_tokens(2))
        .await
        .unwrap();
    assert_eq!(won, Some(1));
    let again = shopify::put_tokens(&mut tx, g.shop, Some(0), &support::sealed_tokens(3))
        .await
        .unwrap();
    assert_eq!(again, None, "the same claim is stale after a win");
    let now = shopify::get_tokens(&mut tx, g.shop).await.unwrap().unwrap();
    assert_eq!((now.version, &now.tokens), (1, &support::sealed_tokens(2)));

    // With no row, only "no row" is right, and the first row starts at version 0.
    assert!(shopify::delete_tokens(&mut tx, g.shop).await.unwrap());
    let none = shopify::put_tokens(&mut tx, g.shop, Some(1), &support::sealed_tokens(4))
        .await
        .unwrap();
    assert_eq!(none, None);
    assert!(
        shopify::get_tokens(&mut tx, g.shop)
            .await
            .unwrap()
            .is_none()
    );
    let first = shopify::put_tokens(&mut tx, g.shop, None, &support::sealed_tokens(4))
        .await
        .unwrap();
    assert_eq!(first, Some(0));
    let stored = shopify::get_tokens(&mut tx, g.shop).await.unwrap().unwrap();
    assert_eq!(
        (stored.version, &stored.tokens),
        (0, &support::sealed_tokens(4))
    );
}

#[sqlx::test]
async fn concurrent_exchange_writes_from_the_same_read_have_one_winner(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let db = app_db(opts, conn).await;
    let g = seed(&db, 1).await;
    let put = |claim: Option<i64>, label: u8| {
        let db = db.clone();
        async move {
            let mut tx = db.tenant(g.tenant).await.unwrap();
            let won = shopify::put_tokens(&mut tx, g.shop, claim, &support::sealed_tokens(label))
                .await
                .unwrap();
            tx.commit().await.unwrap();
            won
        }
    };

    // Two writers that both read version 0.
    let (x, y) = tokio::join!(put(Some(0), 10), put(Some(0), 11));
    assert_eq!(
        [x, y].iter().filter(|w| w.is_some()).count(),
        1,
        "{x:?} {y:?}"
    );

    // Two writers that both found no row (an insert race).
    let mut tx = db.tenant(g.tenant).await.unwrap();
    shopify::delete_tokens(&mut tx, g.shop).await.unwrap();
    tx.commit().await.unwrap();
    let (x, y) = tokio::join!(put(None, 12), put(None, 13));
    assert_eq!(
        [x, y].iter().filter(|w| w.is_some()).count(),
        1,
        "{x:?} {y:?}"
    );
}

#[sqlx::test]
async fn concurrent_rotations_from_the_same_version_have_one_winner(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let db = app_db(opts, conn).await;
    let g = seed(&db, 1).await;
    let rotate = |label: u8| {
        let db = db.clone();
        async move {
            let mut tx = db.tenant(g.tenant).await.unwrap();
            let won = shopify::rotate(&mut tx, g.shop, 0, &support::sealed_tokens(label))
                .await
                .unwrap();
            tx.commit().await.unwrap();
            won
        }
    };
    let (x, y) = tokio::join!(rotate(10), rotate(11));
    assert_eq!(
        [x, y].iter().filter(|w| w.is_some()).count(),
        1,
        "{x:?} {y:?}"
    );
}

#[sqlx::test]
async fn the_shop_lock_serialises_holders(opts: PgPoolOptions, conn: PgConnectOptions) {
    let db = app_db(opts, conn).await;
    let first = db.shop_lock("store-1.myshopify.com").await.unwrap();

    // A second holder for the same shop waits; another shop does not.
    let other = db.shop_lock("store-2.myshopify.com").await.unwrap();
    other.release().await.unwrap();
    let waiting = {
        let db = db.clone();
        tokio::spawn(async move { db.shop_lock("store-1.myshopify.com").await.unwrap() })
    };
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    assert!(!waiting.is_finished(), "second holder did not wait");

    first.release().await.unwrap();
    let second = tokio::time::timeout(std::time::Duration::from_secs(5), waiting)
        .await
        .expect("second holder never got the lock")
        .unwrap();
    // Dropping the guard releases the lock too.
    drop(second);
    let third = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        db.shop_lock("store-1.myshopify.com"),
    )
    .await
    .expect("a dropped guard kept the lock")
    .unwrap();
    third.release().await.unwrap();
}

#[sqlx::test]
async fn marking_a_site_verified_keeps_the_first_time(opts: PgPoolOptions, conn: PgConnectOptions) {
    let db = app_db(opts, conn).await;
    let g = seed(&db, 1).await;
    let mut tx = db.tenant(g.tenant).await.unwrap();
    let first = sites::mark_verified(&mut tx, g.site, "shopify_install")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        first.verification_method.as_deref(),
        Some("shopify_install")
    );
    let at = first.verified_at.unwrap();
    let again = sites::mark_verified(&mut tx, g.site, "shopify_install")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(again.verified_at, Some(at));
}

// --- Re-wrapping stored tokens (audit L6, ADR-045) ---------------------------------------------

/// A row's tokens re-wrapped to key `k2`: bytes that differ from the row's, same expiry.
fn rewrapped(label: u8) -> shopify::Rewrapped {
    shopify::Rewrapped {
        access_ct: vec![label, 0xaa],
        refresh_ct: vec![label, 0xbb],
        key_id: "k2".to_owned(),
    }
}

#[sqlx::test]
async fn replacing_the_wrapping_changes_the_key_and_keeps_the_version(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let db = app_db(opts, conn).await;
    let g = seed(&db, 1).await;
    let mut tx = db.tenant(g.tenant).await.unwrap();
    let read = shopify::get_tokens(&mut tx, g.shop).await.unwrap().unwrap();
    assert_eq!((read.version, read.tokens.key_id.as_str()), (0, "k1"));

    assert!(
        shopify::replace_wrapping(&mut tx, g.shop, &read, &rewrapped(1))
            .await
            .unwrap()
    );
    let now = shopify::get_tokens(&mut tx, g.shop).await.unwrap().unwrap();
    assert_eq!(
        now.version, 0,
        "re-wrapping is not a new version of the tokens"
    );
    assert_eq!(now.tokens.key_id, "k2");
    assert_eq!(now.tokens.access_ct, rewrapped(1).access_ct);
    assert_eq!(now.tokens.access_expires_at, read.tokens.access_expires_at);
    assert_eq!(
        now.tokens.refresh_expires_at,
        read.tokens.refresh_expires_at
    );

    // The same read is stale now: nothing is written twice.
    assert!(
        !shopify::replace_wrapping(&mut tx, g.shop, &read, &rewrapped(2))
            .await
            .unwrap()
    );
    // A refresh that read the row before the swap still stores its tokens afterwards.
    let v = shopify::rotate(&mut tx, g.shop, read.version, &support::sealed_tokens(5))
        .await
        .unwrap();
    assert_eq!(v, Some(1));
}

#[sqlx::test]
async fn replacing_the_wrapping_loses_to_any_change_since_the_read(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let db = app_db(opts, conn).await;
    let g = seed(&db, 1).await;
    let mut tx = db.tenant(g.tenant).await.unwrap();
    let read = shopify::get_tokens(&mut tx, g.shop).await.unwrap().unwrap();

    // Rotated since: a new version.
    shopify::rotate(&mut tx, g.shop, 0, &support::sealed_tokens(3))
        .await
        .unwrap()
        .unwrap();
    assert!(
        !shopify::replace_wrapping(&mut tx, g.shop, &read, &rewrapped(1))
            .await
            .unwrap()
    );

    // Deleted and stored again by a process that still seals under the key being retired: the
    // row is back at version 0 under the same key id, but it holds other tokens.
    assert!(shopify::delete_tokens(&mut tx, g.shop).await.unwrap());
    assert_eq!(
        shopify::put_tokens(&mut tx, g.shop, None, &support::sealed_tokens(4))
            .await
            .unwrap(),
        Some(0)
    );
    assert!(
        !shopify::replace_wrapping(&mut tx, g.shop, &read, &rewrapped(1))
            .await
            .unwrap(),
        "a stale read re-wrapped the new tokens over"
    );
    let kept = shopify::get_tokens(&mut tx, g.shop).await.unwrap().unwrap();
    assert_eq!(kept.tokens.access_ct, support::sealed_tokens(4).access_ct);
    assert_eq!(kept.tokens.key_id, "k1");
}

#[sqlx::test]
async fn the_worker_lists_token_rows_under_other_keys_across_tenants(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let app = app_db(opts.clone(), conn.clone()).await;
    let a = seed(&app, 1).await;
    let b = seed(&app, 2).await;
    let worker = Db::from_pool(support::worker_pool(opts, conn).await);

    // Nothing is under another key while k1 is the active one.
    let under_other_keys = worker.tokens_to_rewrap("k1", None, 10).await.unwrap();
    assert!(
        under_other_keys.is_empty(),
        "nothing may be listed under another key, got {under_other_keys:?}"
    );

    // Both tenants' rows are listed in shop id order, with their versions and no ciphertext.
    let mut expected = [(a.tenant, a.shop), (b.tenant, b.shop)];
    expected.sort_by_key(|(_, shop)| shop.as_uuid());
    let listed = worker.tokens_to_rewrap("k2", None, 10).await.unwrap();
    let pairs: Vec<_> = listed.iter().map(|r| (r.tenant, r.shop)).collect();
    assert_eq!(pairs, expected);
    assert!(listed.iter().all(|r| r.version == 0));

    // Keyset paging: a batch of one, then the rest after it, then nothing. Zero means one.
    let first = worker.tokens_to_rewrap("k2", None, 1).await.unwrap();
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].shop, expected[0].1);
    let rest = worker
        .tokens_to_rewrap("k2", Some(first[0].shop), 10)
        .await
        .unwrap();
    assert_eq!(rest.len(), 1);
    assert_eq!(rest[0].shop, expected[1].1);
    let after_last = worker
        .tokens_to_rewrap("k2", Some(rest[0].shop), 10)
        .await
        .unwrap();
    assert!(
        after_last.is_empty(),
        "nothing may follow the last row, got {after_last:?}"
    );
    assert_eq!(
        worker.tokens_to_rewrap("k2", None, 0).await.unwrap().len(),
        1
    );

    let counts = worker.token_key_counts().await.unwrap();
    assert_eq!(
        counts,
        vec![db::KeyCount {
            key_id: "k1".to_owned(),
            tokens: 2
        }]
    );
}

#[sqlx::test]
async fn only_the_worker_may_list_tokens_to_rewrap(opts: PgPoolOptions, conn: PgConnectOptions) {
    let app = app_db(opts, conn).await;
    seed(&app, 1).await;
    // SQLSTATE 42501 (insufficient privilege) is what `DbError` calls `Forbidden`.
    let err = app.tokens_to_rewrap("k2", None, 10).await.unwrap_err();
    assert!(matches!(err, db::DbError::Forbidden), "{err:?}");
    let err = app.token_key_counts().await.unwrap_err();
    assert!(matches!(err, db::DbError::Forbidden), "{err:?}");
}

/// Security audit M2/M3: the limits the engine enforces are stored with the plan, from the same
/// entitlements function the api reads, on every `put`.
#[sqlx::test]
async fn storing_a_plan_stores_the_limits_the_engine_enforces(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    use billing::reconcile::{PaidPlan, Standing};
    use billing::{BillingInterval, BillingState, Plan};
    use sqlx::Row;

    let db = app_db(opts.clone(), conn.clone()).await;
    let owner = owner_pool(opts, conn).await;
    let g = seed(&db, 33).await;
    let limits = |plan: &'static str| {
        let owner = owner.clone();
        async move {
            let row = sqlx::query(
                "select effective_plan, ai_budget_max_micro_usd, alt_text_draft_limit,
                        alt_text_draft_lifetime from shop_billing where shop_id = $1",
            )
            .bind(g.shop.as_uuid())
            .fetch_one(&owner)
            .await
            .unwrap();
            assert_eq!(row.get::<String, _>("effective_plan"), plan);
            (
                row.get::<i64, _>("ai_budget_max_micro_usd"),
                row.get::<i32, _>("alt_text_draft_limit"),
                row.get::<bool, _>("alt_text_draft_lifetime"),
            )
        }
    };

    let mut tx = db.tenant(g.tenant).await.unwrap();
    let unconfirmed = billing::stored::stored_of(&BillingState::new());
    db::repo::shop_billing::put(&mut tx, g.shop, &unconfirmed)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(limits("free").await, (500_000, 25, true));

    let growth = BillingState {
        standing: Standing::Paid(PaidPlan {
            plan: Plan::Growth,
            interval: BillingInterval::Monthly,
            cancel_at_end_of_cycle: false,
            trial_ends_at: None,
            cycle: None,
            scheduled: None,
        }),
        ..BillingState::new()
    };
    let mut tx = db.tenant(g.tenant).await.unwrap();
    db::repo::shop_billing::put(&mut tx, g.shop, &billing::stored::stored_of(&growth))
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(limits("growth").await, (20_000_000, 10_000, false));

    // Back to no plan (an uninstall, a lapsed subscription): the limits fall with it.
    let mut tx = db.tenant(g.tenant).await.unwrap();
    db::repo::shop_billing::put(&mut tx, g.shop, &unconfirmed)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(limits("free").await, (500_000, 25, true));
}
