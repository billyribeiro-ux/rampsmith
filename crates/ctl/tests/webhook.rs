//! `webhook.process@1` (ADR-080): uninstall, the compliance topics and shop updates, against
//! PostgreSQL as the worker role and a mock Admin API.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use contracts::WebhookProcess;
use db::repo::webhooks::{self, NewWebhook, Recorded};
use queue::Failure;
use serde_json::{Value, json};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use uuid::Uuid;

mod support;

use support::world::{SHOP, World, world};

/// Stores an event the way the api does and returns its id.
async fn store(w: &World, topic: &str, body: Value) -> Uuid {
    let mut tx = w.db.tenant(w.session.tenant).await.unwrap();
    let recorded = webhooks::record(
        &mut tx,
        &NewWebhook {
            shop_id: w.session.shop_id,
            external_id: Uuid::now_v7().to_string(),
            topic: topic.to_owned(),
            body_sha256: {
                let mut digest = [0_u8; 32];
                digest[..16].copy_from_slice(Uuid::now_v7().as_bytes());
                digest
            },
            body,
        },
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let Recorded::Stored(id) = recorded else {
        panic!("expected a new event, got {recorded:?}");
    };
    id
}

async fn process(w: &World, event: Uuid) -> Result<(), Failure> {
    let job = w.job(
        WebhookProcess::QUEUE,
        WebhookProcess::SCHEMA,
        json!({"event_id": event}),
    );
    w.jobs.dispatch(job).await
}

fn shop_object() -> Value {
    json!({"id": 548_380_009, "myshopify_domain": SHOP, "domain": "demo.example"})
}

fn shop_response() -> Value {
    json!({"data": {
        "shop": {"id": "gid://shopify/Shop/1", "name": "Demo",
                 "myshopifyDomain": SHOP,
                 "primaryDomain": {"host": "demo.example", "url": "https://demo.example"}},
        "shopLocales": [{"locale": "en", "primary": true, "published": true},
                        {"locale": "fr", "primary": false, "published": true}],
        "themes": {"nodes": []}
    }})
}

async fn status(w: &World) -> String {
    sqlx::query_scalar("select status from shopify_shops where shop_domain = $1")
        .bind(SHOP)
        .fetch_one(&w.owner)
        .await
        .unwrap()
}

async fn processed(w: &World, event: Uuid) -> (bool, bool) {
    sqlx::query_as(
        "select processed_at is not null, body is null from webhook_events where id = $1",
    )
    .bind(event)
    .fetch_one(&w.owner)
    .await
    .unwrap()
}

fn permanent(result: Result<(), Failure>) -> String {
    match result {
        Err(Failure::Permanent(e)) => e.code,
        other => panic!("expected a permanent failure, got {other:?}"),
    }
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn a_real_uninstall_ends_the_shop_cancels_its_jobs_and_deletes_its_tokens(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let w = world(opts, conn).await;
    // Shopify answers 401: the token no longer works, as after a real uninstall.
    w.admin_answers(
        401,
        json!({"errors": "[API] Invalid API key or access token"}),
    )
    .await;
    for queue in ["shopify.token_refresh", "scan.page", "webhook.process"] {
        sqlx::query(
            "insert into jobs (id, queue, payload_schema, payload, tenant_id, state)
             values ($1, $2, $3, '{}', $4, 'ready')",
        )
        .bind(Uuid::now_v7())
        .bind(queue)
        .bind(format!("{queue}@1"))
        .bind(w.session.tenant.as_uuid())
        .execute(&w.owner)
        .await
        .unwrap();
    }
    let event = store(&w, "app/uninstalled", shop_object()).await;

    process(&w, event).await.unwrap();

    assert_eq!(status(&w).await, "uninstalled");
    assert_eq!(w.count("select count(*) from shopify_tokens").await, 0);
    assert_eq!(
        w.count("select count(*) from shopify_shops where uninstalled_at is not null")
            .await,
        1,
        "the retention clock runs"
    );
    // Work in line is cancelled; a compliance webhook waiting in line is not.
    assert!(
        w.count("select count(*) from jobs where state = 'cancelled'")
            .await
            >= 2
    );
    assert_eq!(
        w.count("select count(*) from jobs where state = 'ready' and queue <> 'webhook.process'")
            .await,
        0
    );
    assert_eq!(
        w.count("select count(*) from jobs where queue = 'webhook.process' and state = 'ready'")
            .await,
        1
    );
    assert_eq!(processed(&w, event).await, (true, true));
    assert_eq!(
        w.count("select count(*) from audit_log where action = 'shopify.app_uninstalled' and actor_kind = 'shopify'").await,
        1
    );
    // Run again: nothing changes and nothing fails.
    process(&w, event).await.unwrap();
    assert_eq!(
        w.count("select count(*) from audit_log where action = 'shopify.app_uninstalled'")
            .await,
        1
    );
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn a_replayed_uninstall_for_a_shop_that_still_works_changes_nothing(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let w = world(opts, conn).await;
    w.admin_answers(200, shop_response()).await;
    let event = store(&w, "app/uninstalled", shop_object()).await;

    process(&w, event).await.unwrap();

    assert_eq!(status(&w).await, "installed");
    assert_eq!(w.count("select count(*) from shopify_tokens").await, 1);
    assert_eq!(
        w.count("select count(*) from audit_log where action = 'webhook.uninstall_ignored'")
            .await,
        1
    );
    assert_eq!(processed(&w, event).await, (true, true));
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn an_unreachable_shopify_retries_instead_of_deciding(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let w = world(opts, conn).await;
    w.admin_answers(503, json!({})).await;
    let event = store(&w, "app/uninstalled", shop_object()).await;

    let Err(Failure::Retryable(error)) = process(&w, event).await else {
        panic!("expected a retryable failure");
    };
    assert_eq!(error.code, "shopify_unavailable");
    assert_eq!(status(&w).await, "installed");
    assert_eq!(processed(&w, event).await, (false, false));
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn a_shop_without_a_token_is_uninstalled_without_asking_shopify(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let w = world(opts, conn).await;
    sqlx::query("delete from shopify_tokens")
        .execute(&w.owner)
        .await
        .unwrap();
    let event = store(&w, "app/uninstalled", shop_object()).await;
    process(&w, event).await.unwrap();
    assert_eq!(status(&w).await, "uninstalled");
    assert!(w.admin.received_requests().await.unwrap().is_empty());
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn the_customer_compliance_topics_record_that_nothing_is_held_and_keep_no_details(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let w = world(opts, conn).await;
    let request = json!({
        "shop_id": 954_889, "shop_domain": SHOP,
        "orders_requested": [299_938], "customer": {"id": 191_167, "email": "jane@example.com", "phone": "555-0100"},
        "data_request": {"id": 9999}
    });
    let redact = json!({
        "shop_id": 954_889, "shop_domain": SHOP,
        "customer": {"id": 191_167, "email": "jane@example.com", "phone": "555-0100"},
        "orders_to_redact": [299_938]
    });
    let a = store(&w, "customers/data_request", request).await;
    let b = store(&w, "customers/redact", redact).await;
    process(&w, a).await.unwrap();
    process(&w, b).await.unwrap();

    let entries: Vec<(String, Value)> = sqlx::query_as(
        "select action, data from audit_log where action like 'compliance.%' order by at, id",
    )
    .fetch_all(&w.owner)
    .await
    .unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].0, "compliance.customer_data_request");
    assert_eq!(entries[0].1["result"], "none_held");
    assert_eq!(entries[0].1["request_id"], 9999);
    assert_eq!(entries[1].0, "compliance.customer_redact");
    let everything = format!("{entries:?}");
    assert!(!everything.contains("jane@example.com") && !everything.contains("555-0100"));
    // The bodies, which carried the customer's details, are cleared once processed.
    assert_eq!(processed(&w, a).await, (true, true));
    assert_eq!(processed(&w, b).await, (true, true));
    assert_eq!(
        w.count("select count(*) from webhook_events where body::text like '%jane@%'")
            .await,
        0
    );
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn shop_redact_deletes_the_shops_data_and_only_the_shops_data(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let w = world(opts, conn).await;
    let other = seed_other_tenant(&w).await;
    seed_shop_data(&w).await;
    let before = w.count("select count(*) from scans").await;
    assert!(before >= 2, "both tenants have scans");

    // Shopify no longer accepts the shop's token: the uninstall is real.
    w.admin_answers(
        401,
        json!({"errors": "[API] Invalid API key or access token"}),
    )
    .await;
    let event = store(
        &w,
        "shop/redact",
        json!({"shop_id": 1, "shop_domain": SHOP}),
    )
    .await;
    process(&w, event).await.unwrap();

    for table in [
        "data_fix_snapshots",
        "fix_findings",
        "fixes",
        "evidence",
        "finding_occurrences",
        "findings",
        "scan_inputs",
        "scan_pages",
        "scans",
        "statements",
        "ai_calls",
        "ai_reservations",
        "ai_budgets",
        "shopify_tokens",
    ] {
        let mine: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
            "select count(*) from {table} where tenant_id = $1"
        )))
        .bind(w.session.tenant.as_uuid())
        .fetch_one(&w.owner)
        .await
        .unwrap();
        assert_eq!(mine, 0, "{table} still holds the redacted shop's rows");
    }
    // The other tenant is untouched.
    for (table, expected) in [
        ("scans", 1_i64),
        ("findings", 1),
        ("scan_inputs", 1),
        ("shopify_tokens", 1),
    ] {
        let theirs: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
            "select count(*) from {table} where tenant_id = $1"
        )))
        .bind(other)
        .fetch_one(&w.owner)
        .await
        .unwrap();
        assert_eq!(theirs, expected, "{table} lost another tenant's rows");
    }
    let shop: (String, Vec<String>, Option<String>, Option<String>) = sqlx::query_as(
        "select status, scopes, primary_domain, name from shopify_shops where tenant_id = $1",
    )
    .bind(w.session.tenant.as_uuid())
    .fetch_one(&w.owner)
    .await
    .unwrap();
    assert_eq!(shop.0, "redacted");
    assert!(shop.1.is_empty() && shop.2.is_none());
    assert!(shop.3.is_none(), "the shop's name goes with the rest");
    let settings: Value = sqlx::query_scalar("select settings from sites where tenant_id = $1")
        .bind(w.session.tenant.as_uuid())
        .fetch_one(&w.owner)
        .await
        .unwrap();
    assert_eq!(settings, json!({}));
    // The audit log is append-only and survives, with counts and no content.
    let audit: Value =
        sqlx::query_scalar("select data from audit_log where action = 'compliance.shop_redacted'")
            .fetch_one(&w.owner)
            .await
            .unwrap();
    assert!(audit["removed"]["scans"].as_u64().unwrap() >= 1);
    assert_eq!(processed(&w, event).await, (true, true));

    // A second shop/redact (after the app was installed and removed again) is harmless.
    let again = store(
        &w,
        "shop/redact",
        json!({"shop_id": 1, "shop_domain": SHOP, "again": true}),
    )
    .await;
    process(&w, again).await.unwrap();
    assert_eq!(status(&w).await, "redacted");
}

fn genuine_redact() -> Value {
    json!({"shop_id": 954_889, "shop_domain": SHOP})
}

async fn counts(w: &World) -> (i64, i64, i64) {
    (
        w.count("select count(*) from scans").await,
        w.count("select count(*) from findings").await,
        w.count("select count(*) from shopify_tokens").await,
    )
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn a_relabelled_customer_request_sent_as_shop_redact_deletes_nothing_while_the_token_works(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let w = world(opts, conn).await;
    seed_shop_data(&w).await;
    w.admin_answers(200, shop_response()).await;
    let before = counts(&w).await;
    assert!(before.0 >= 1 && before.1 >= 1 && before.2 == 1);

    // A signed customers/data_request body, filed under shop/redact (the topic header is not
    // signed). The listener refuses it; this is the backstop if one ever got through.
    let event = store(
        &w,
        "shop/redact",
        json!({"shop_id": 954_889, "shop_domain": SHOP,
               "customer": {"id": 191_167, "email": "jane@example.com"},
               "data_request": {"id": 9999}}),
    )
    .await;
    process(&w, event).await.unwrap();

    assert_eq!(counts(&w).await, before, "nothing was deleted");
    assert_eq!(status(&w).await, "installed");
    assert_eq!(
        w.count("select count(*) from audit_log where action = 'compliance.shop_redact_ignored'")
            .await,
        1
    );
    assert_eq!(
        w.count("select count(*) from audit_log where action = 'compliance.shop_redacted'")
            .await,
        0
    );
    assert_eq!(processed(&w, event).await, (true, true));
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn a_genuine_shop_redact_replayed_after_a_reinstall_deletes_nothing(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let w = world(opts, conn).await;
    seed_shop_data(&w).await;
    // The real redact: Shopify rejects the token, the shop is redacted.
    sqlx::query("create table token_copy as select * from shopify_tokens")
        .execute(&w.owner)
        .await
        .unwrap();
    w.admin_answers(
        401,
        json!({"errors": "[API] Invalid API key or access token"}),
    )
    .await;
    let first = store(&w, "shop/redact", genuine_redact()).await;
    process(&w, first).await.unwrap();
    assert_eq!(status(&w).await, "redacted");
    assert_eq!(counts(&w).await, (0, 0, 0));

    // The merchant installs the app again and gets new data and a working token.
    sqlx::query(
        "update shopify_shops set status = 'installed', uninstalled_at = null,
                installed_at = now(), scopes = '{read_products}'",
    )
    .execute(&w.owner)
    .await
    .unwrap();
    seed_shop_data(&w).await;
    sqlx::query("insert into shopify_tokens select * from token_copy")
        .execute(&w.owner)
        .await
        .unwrap();
    w.admin.reset().await;
    w.admin_answers(200, shop_response()).await;
    let before = counts(&w).await;
    assert!(before.0 >= 1 && before.1 >= 1);

    // The captured, signed redact comes back more than a day later with a new delivery id.
    let replay = store(&w, "shop/redact", genuine_redact()).await;
    process(&w, replay).await.unwrap();
    assert_eq!(counts(&w).await, before, "the live shop kept its data");
    assert_eq!(status(&w).await, "installed");
    assert_eq!(
        w.count("select count(*) from audit_log where action = 'compliance.shop_redact_ignored'")
            .await,
        1
    );
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn an_unreachable_shopify_retries_a_shop_redact_instead_of_deciding(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let w = world(opts, conn).await;
    seed_shop_data(&w).await;
    w.admin_answers(503, json!({})).await;
    let before = counts(&w).await;
    let event = store(&w, "shop/redact", genuine_redact()).await;
    let Err(Failure::Retryable(error)) = process(&w, event).await else {
        panic!("expected a retryable failure");
    };
    assert_eq!(error.code, "shopify_unavailable");
    assert_eq!(counts(&w).await, before);
    assert_eq!(status(&w).await, "installed");
    assert_eq!(processed(&w, event).await, (false, false));
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn a_shop_that_is_already_uninstalled_is_redacted_without_asking_shopify(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let w = world(opts, conn).await;
    seed_shop_data(&w).await;
    sqlx::query("update shopify_shops set status = 'uninstalled', uninstalled_at = now()")
        .execute(&w.owner)
        .await
        .unwrap();
    let event = store(&w, "shop/redact", genuine_redact()).await;
    process(&w, event).await.unwrap();
    assert_eq!(status(&w).await, "redacted");
    assert!(w.admin.received_requests().await.unwrap().is_empty());
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn the_shop_domain_in_a_body_is_compared_without_regard_to_case(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let w = world(opts, conn).await;
    w.admin_answers(200, shop_response()).await;
    let event = store(
        &w,
        "shop/update",
        json!({"id": 1, "myshopify_domain": SHOP.to_uppercase()}),
    )
    .await;
    process(&w, event).await.unwrap();
    assert_eq!(processed(&w, event).await, (true, true));
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn shop_update_refreshes_the_primary_domain_and_locales(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let w = world(opts, conn).await;
    w.admin_answers(200, shop_response()).await;
    let event = store(&w, "shop/update", shop_object()).await;
    process(&w, event).await.unwrap();
    let row: (Option<String>, Vec<String>, bool, Option<String>) = sqlx::query_as(
        "select primary_domain, locales, synced_at is not null, name from shopify_shops",
    )
    .fetch_one(&w.owner)
    .await
    .unwrap();
    assert_eq!(row.0.as_deref(), Some("demo.example"));
    assert_eq!(row.1, ["en", "fr"]);
    assert!(row.2);
    assert_eq!(row.3.as_deref(), Some("Demo"));
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn events_that_cannot_be_handled_fail_permanently_and_stay_unprocessed(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let w = world(opts, conn).await;
    // The body names another shop than the one the event was filed under.
    let forged = store(
        &w,
        "shop/redact",
        json!({"shop_id": 1, "shop_domain": "victim.myshopify.com"}),
    )
    .await;
    assert_eq!(permanent(process(&w, forged).await), "shop_mismatch");
    assert_eq!(status(&w).await, "installed");
    assert_eq!(processed(&w, forged).await, (false, false));

    let odd = store(&w, "products/update", shop_object()).await;
    assert_eq!(permanent(process(&w, odd).await), "topic_unsupported");

    assert_eq!(
        permanent(process(&w, Uuid::now_v7()).await),
        "event_missing"
    );

    let bad = w.job(
        WebhookProcess::QUEUE,
        "webhook.process@2",
        json!({"event_id": odd}),
    );
    assert_eq!(
        permanent(w.jobs.dispatch(bad).await),
        "payload_schema_unknown"
    );
    let bad = w.job(
        WebhookProcess::QUEUE,
        WebhookProcess::SCHEMA,
        json!({"event": 1}),
    );
    assert_eq!(permanent(w.jobs.dispatch(bad).await), "payload_invalid");
    let mut no_tenant = w.job(
        WebhookProcess::QUEUE,
        WebhookProcess::SCHEMA,
        json!({"event_id": odd}),
    );
    no_tenant.tenant_id = None;
    assert_eq!(
        permanent(w.jobs.dispatch(no_tenant).await),
        "tenant_missing"
    );
}

/// A second tenant with a scan, a finding, a scan input and a token.
async fn seed_other_tenant(w: &World) -> Uuid {
    let tenant = Uuid::now_v7();
    let (site, scan, finding) = (Uuid::now_v7(), Uuid::now_v7(), Uuid::now_v7());
    let shop = Uuid::now_v7();
    for sql in [
        format!("insert into tenants (id, kind) values ('{tenant}', 'shopify_store')"),
        format!(
            "insert into sites (id, tenant_id, platform, base_url) values ('{site}', '{tenant}', 'shopify', 'https://other.myshopify.com')"
        ),
        format!(
            "insert into shopify_shops (id, tenant_id, site_id, shop_domain, scopes, api_version, status, installed_at) values ('{shop}', '{tenant}', '{site}', 'other.myshopify.com', '{{}}', '2026-10', 'installed', now())"
        ),
        format!(
            "insert into shopify_tokens (shop_id, tenant_id, access_ct, refresh_ct, key_id, access_expires_at, refresh_expires_at) values ('{shop}', '{tenant}', '\\x01', '\\x02', 'k1', now(), now())"
        ),
        format!(
            "insert into scans (id, tenant_id, site_id, trigger, status, ruleset_version) values ('{scan}', '{tenant}', '{site}', 'manual', 'queued', 'v')"
        ),
        format!(
            "insert into findings (id, tenant_id, site_id, fingerprint, rule_id, criteria, impact, status, first_seen_scan, last_seen_scan, occurrence_count) values ('{finding}', '{tenant}', '{site}', '\\x{}', 'image-alt', '{{1.1.1}}', 'serious', 'open', '{scan}', '{scan}', 1)",
            "ab".repeat(32)
        ),
        format!(
            "insert into scan_inputs (id, tenant_id, scan_id, site_id, kind, seq, payload) values ('{}', '{tenant}', '{scan}', '{site}', 'shop', 0, '{{}}')",
            Uuid::now_v7()
        ),
    ] {
        sqlx::query(sqlx::AssertSqlSafe(sql))
            .execute(&w.owner)
            .await
            .unwrap();
    }
    tenant
}

/// Rows in every table `shop/redact` must empty, for the world's own tenant.
async fn seed_shop_data(w: &World) {
    let tenant = w.session.tenant.as_uuid();
    let site: Uuid = sqlx::query_scalar("select id from sites where tenant_id = $1")
        .bind(tenant)
        .fetch_one(&w.owner)
        .await
        .unwrap();
    let (scan, finding, fix, evidence) = (
        Uuid::now_v7(),
        Uuid::now_v7(),
        Uuid::now_v7(),
        Uuid::now_v7(),
    );
    for sql in [
        format!(
            "update sites set settings = '{{\"notify\":\"owner@example.com\"}}' where id = '{site}'"
        ),
        format!(
            "insert into scans (id, tenant_id, site_id, trigger, status, ruleset_version) values ('{scan}', '{tenant}', '{site}', 'manual', 'succeeded', 'v')"
        ),
        format!(
            "insert into scan_pages (id, tenant_id, scan_id, url, page_state, duration_ms) values ('{}', '{tenant}', '{scan}', 'https://demo.myshopify.com/', 'default', 5)",
            Uuid::now_v7()
        ),
        format!(
            "insert into scan_inputs (id, tenant_id, scan_id, site_id, kind, seq, payload) values ('{}', '{tenant}', '{scan}', '{site}', 'products', 0, '{{\"products\":[]}}')",
            Uuid::now_v7()
        ),
        format!(
            "insert into findings (id, tenant_id, site_id, fingerprint, rule_id, criteria, impact, status, first_seen_scan, last_seen_scan, occurrence_count) values ('{finding}', '{tenant}', '{site}', '\\x{}', 'image-alt', '{{1.1.1}}', 'serious', 'open', '{scan}', '{scan}', 1)",
            "cd".repeat(32)
        ),
        format!(
            "insert into finding_occurrences (finding_id, scan_id, tenant_id, page_url, page_state, target, html_excerpt, captured_at) values ('{finding}', '{scan}', '{tenant}', 'https://demo.myshopify.com/', 'default', 'img', '<img>', now())"
        ),
        format!(
            "insert into evidence (id, tenant_id, scan_id, finding_id, content_type, bytes) values ('{evidence}', '{tenant}', '{scan}', '{finding}', 'image/png', '\\x89')"
        ),
        format!(
            "insert into fixes (id, tenant_id, site_id, kind, channel, status, origin, before_evidence_id) values ('{fix}', '{tenant}', '{site}', 'data', 'admin_api', 'applied', 'rule', '{evidence}')"
        ),
        format!(
            "insert into fix_findings (fix_id, finding_id, tenant_id) values ('{fix}', '{finding}', '{tenant}')"
        ),
        format!(
            "insert into data_fix_snapshots (fix_id, tenant_id, resource_gid, field, before_value, after_value) values ('{fix}', '{tenant}', 'gid://shopify/MediaImage/1', 'alt', 'null', '\"a cat\"')"
        ),
        format!(
            "insert into statements (id, tenant_id, site_id, version, status, content) values ('{}', '{tenant}', '{site}', 1, 'draft', '{{}}')",
            Uuid::now_v7()
        ),
        format!(
            "insert into ai_calls (id, tenant_id, task, model, mode, prompt_version, input_tokens, output_tokens, cost_micro_usd, cost_is_estimate, outcome, attempts, duration_ms, started_at) values ('{}', '{tenant}', 'alt_text', 'claude-haiku-5-5', 'sync', 'v1', 1, 1, 1, false, 'ok', 1, 1, now())",
            Uuid::now_v7()
        ),
        format!("insert into ai_budgets (tenant_id, period) values ('{tenant}', '2026-10')"),
        format!(
            "insert into ai_reservations (id, tenant_id, period, amount_micro_usd, state) values ('{}', '{tenant}', '2026-10', 5, 'reserved')",
            Uuid::now_v7()
        ),
    ] {
        sqlx::query(sqlx::AssertSqlSafe(sql))
            .execute(&w.owner)
            .await
            .unwrap();
    }
}

/// Files an event received `minutes` ago, unprocessed, with a job in `job_state` (if any).
async fn aged_event(w: &World, minutes: i32, job_state: Option<&str>) -> Uuid {
    let event = store(w, "shop/update", shop_object()).await;
    sqlx::query(
        "update webhook_events set received_at = now() - make_interval(mins => $2) where id = $1",
    )
    .bind(event)
    .bind(minutes)
    .execute(&w.owner)
    .await
    .unwrap();
    sqlx::query("delete from jobs where queue = 'webhook.process' and payload ->> 'event_id' = $1")
        .bind(event.to_string())
        .execute(&w.owner)
        .await
        .unwrap();
    if let Some(state) = job_state {
        let finished = if matches!(state, "dead" | "succeeded" | "failed" | "cancelled") {
            "now()"
        } else {
            "null"
        };
        let lease = if state == "running" {
            "'x', now() + interval '1 hour'"
        } else {
            "null, null"
        };
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "insert into jobs (id, queue, payload_schema, payload, tenant_id, state, locked_by,
                               locked_until, finished_at)
             values ($1, 'webhook.process', 'webhook.process@1', $2, $3, '{state}', {lease}, {finished})"
        )))
        .bind(Uuid::now_v7())
        .bind(json!({"event_id": event}))
        .bind(w.session.tenant.as_uuid())
        .execute(&w.owner)
        .await
        .unwrap();
    }
    event
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn the_sweep_brings_back_stored_events_whose_job_is_gone_and_reports_the_old_ones(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let w = world(opts, conn).await;
    let fresh = aged_event(&w, 5, None).await;
    let lost = aged_event(&w, 45, None).await;
    let dead = aged_event(&w, 90, Some("dead")).await;
    let waiting = aged_event(&w, 90, Some("ready")).await;
    let running = aged_event(&w, 90, Some("running")).await;
    let ancient = aged_event(&w, 60 * 24 * 15, None).await;
    let done = aged_event(&w, 90, None).await;
    sqlx::query("update webhook_events set processed_at = now(), body = null where id = $1")
        .bind(done)
        .execute(&w.owner)
        .await
        .unwrap();
    let ready_for = |event: Uuid| {
        let owner = w.owner.clone();
        async move {
            sqlx::query_scalar::<_, i64>(
                "select count(*) from jobs where queue = 'webhook.process' and state = 'ready'
                    and payload ->> 'event_id' = $1",
            )
            .bind(event.to_string())
            .fetch_one(&owner)
            .await
            .unwrap()
        }
    };

    let found = ctl::leader::sweep_webhooks(&w.pool).await.unwrap();

    assert_eq!(
        found.requeued, 2,
        "the lost event and the one whose job died"
    );
    assert_eq!(ready_for(lost).await, 1);
    assert_eq!(ready_for(dead).await, 1);
    assert_eq!(ready_for(fresh).await, 0, "too young");
    assert_eq!(ready_for(waiting).await, 1, "its own job, not a second");
    assert_eq!(ready_for(running).await, 0);
    assert_eq!(ready_for(ancient).await, 0, "past the 14 day window");
    assert_eq!(ready_for(done).await, 0);
    // The ancient event is the 24 hour alert; the oldest age is reported.
    assert_eq!(found.stuck, 1);
    let again = ctl::leader::sweep_webhooks(&w.pool).await.unwrap();
    assert_eq!(again.requeued, 0, "live jobs exist now");
    assert!(again.stuck >= 1 && again.oldest_seconds >= 15 * 24 * 3600 - 60);

    // The re-enqueued job processes the event.
    let job = w.job(
        WebhookProcess::QUEUE,
        WebhookProcess::SCHEMA,
        json!({"event_id": lost}),
    );
    w.admin_answers(200, shop_response()).await;
    w.jobs.dispatch(job).await.unwrap();
    assert_eq!(processed(&w, lost).await, (true, true));
}
