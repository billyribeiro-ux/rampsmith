//! Webhook replay claims (re-audit L-1) and what redaction does to a shop's other pending
//! webhook events (re-audit M-1, ADR-269), against the real roles.

// Integration tests are test code: PLAN §8 denies these lints outside tests only.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod support;

use db::Db;
use db::repo::redact::{self, OperatorRedactError};
use db::repo::webhooks::{self, NewWebhook, Recorded};
use queue::NewJob;
use serde_json::json;
use sqlx::PgPool;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use support::{app_pool, ctl_pool, owner_pool, seed};
use uuid::Uuid;

fn event(shop: domain::ShopId, topic: &str, id: &str, digest: u8) -> NewWebhook {
    NewWebhook {
        shop_id: shop,
        external_id: id.to_owned(),
        topic: topic.to_owned(),
        body: json!({"topic": topic}),
        body_sha256: [digest; 32],
    }
}

#[sqlx::test]
async fn compliance_topics_share_one_replay_claim_and_the_other_topics_do_not(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let db = Db::from_pool(app_pool(opts, conn).await);
    let graph = seed(&db, 1).await;
    let mut tx = db.tenant(graph.tenant).await.unwrap();
    let record = |topic: &'static str, id: &'static str, digest: u8| {
        let new = event(graph.shop, topic, id, digest);
        async move { (topic, new) }
    };

    // `shop/update` and `app/uninstalled` carry the same shop object: the uninstall that follows
    // an identical update is a new event, not a replay.
    let (_, update) = record("shop/update", "u-1", 1).await;
    assert!(matches!(
        webhooks::record(&mut tx, &update).await.unwrap(),
        Recorded::Stored(_)
    ));
    let (_, uninstall) = record("app/uninstalled", "u-2", 1).await;
    assert!(matches!(
        webhooks::record(&mut tx, &uninstall).await.unwrap(),
        Recorded::Stored(_)
    ));
    // Each of them is still a replay of itself under a new delivery id.
    let (_, update_again) = record("shop/update", "u-3", 1).await;
    assert_eq!(
        webhooks::record(&mut tx, &update_again).await.unwrap(),
        Recorded::DuplicateBody
    );
    let (_, uninstall_again) = record("app/uninstalled", "u-4", 1).await;
    assert_eq!(
        webhooks::record(&mut tx, &uninstall_again).await.unwrap(),
        Recorded::DuplicateBody
    );

    // The compliance topics share one claim: a body captured under one, resent under another.
    let (_, first) = record("customers/redact", "c-1", 2).await;
    assert!(matches!(
        webhooks::record(&mut tx, &first).await.unwrap(),
        Recorded::Stored(_)
    ));
    for (topic, id) in [
        ("shop/redact", "c-2"),
        ("customers/data_request", "c-3"),
        ("customers/redact", "c-4"),
    ] {
        let (_, relabelled) = record(topic, id, 2).await;
        assert_eq!(
            webhooks::record(&mut tx, &relabelled).await.unwrap(),
            Recorded::DuplicateBody,
            "{topic}"
        );
    }
    // And a compliance body does not collide with a non-compliance body of the same bytes.
    let (_, other) = record("shop/update", "c-5", 2).await;
    assert!(matches!(
        webhooks::record(&mut tx, &other).await.unwrap(),
        Recorded::Stored(_)
    ));
    tx.commit().await.unwrap();
}

async fn enqueue_for(db: &Db, tenant: domain::TenantId, event_id: Uuid) {
    let mut tx = db.tenant(tenant).await.unwrap();
    db::repo::jobs::enqueue(
        &mut tx,
        NewJob::new(
            "webhook.process",
            "webhook.process@1",
            json!({"event_id": event_id}),
        )
        .idempotency_key(format!("webhook.process:{event_id}")),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
}

async fn store_pending(db: &Db, graph: support::Graph, topic: &str, n: u8) -> Uuid {
    let mut tx = db.tenant(graph.tenant).await.unwrap();
    let Recorded::Stored(id) = webhooks::record(
        &mut tx,
        &event(graph.shop, topic, &format!("ev-{topic}-{n}"), 40 + n),
    )
    .await
    .unwrap() else {
        panic!("expected a new event");
    };
    tx.commit().await.unwrap();
    enqueue_for(db, graph.tenant, id).await;
    id
}

async fn sweep(owner: &PgPool) -> (i64, i64, i64) {
    sqlx::query_as("select requeued, stuck_24h, oldest_seconds from webhook_events_sweep()")
        .fetch_one(owner)
        .await
        .unwrap()
}

#[sqlx::test]
async fn redacting_a_shop_closes_its_other_pending_events_and_cancels_their_jobs(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let owner = owner_pool(opts.clone(), conn.clone()).await;
    let db = Db::from_pool(ctl_pool(opts, conn).await);
    let graph = seed(&db, 3).await;
    let redact_event = store_pending(&db, graph, "shop/redact", 1).await;
    let pending = [
        store_pending(&db, graph, "customers/redact", 2).await,
        store_pending(&db, graph, "customers/data_request", 3).await,
        store_pending(&db, graph, "app/uninstalled", 4).await,
    ];
    // An old event, past the 24 hour mark, which would raise the alert for ever.
    sqlx::query("update webhook_events set received_at = now() - interval '3 days'")
        .execute(&owner)
        .await
        .unwrap();
    // A pending hold of the alt-text job is tenant data too (L-5).
    sqlx::query(
        "insert into ai_draft_holds (id, tenant_id, units, expires_at)
         values (gen_random_uuid(), $1, 1, now() + interval '1 hour')",
    )
    .bind(graph.tenant.as_uuid())
    .execute(&owner)
    .await
    .unwrap();

    // The worker redacts on the strength of `redact_event`; the others are still pending.
    let mut tx = db.tenant(graph.tenant).await.unwrap();
    let report = redact::shop(&mut tx, graph.shop).await.unwrap().unwrap();
    assert_eq!(report.events_closed, 4, "{report:?}");
    assert_eq!(report.jobs_cancelled, 4, "{report:?}");
    assert!(report.other >= 1, "the draft hold was counted: {report:?}");
    webhooks::mark_processed(&mut tx, redact_event)
        .await
        .unwrap();
    tx.commit().await.unwrap();

    for id in pending {
        let row: (bool, bool) = sqlx::query_as(
            "select processed_at is not null, body is null from webhook_events where id = $1",
        )
        .bind(id)
        .fetch_one(&owner)
        .await
        .unwrap();
        assert_eq!(row, (true, true));
    }
    let jobs: Vec<(String,)> =
        sqlx::query_as("select state from jobs where queue = 'webhook.process' order by 1")
            .fetch_all(&owner)
            .await
            .unwrap();
    assert!(
        jobs.iter().all(|(state,)| state == "cancelled"),
        "no job is left to die: {jobs:?}"
    );
    let holds: i64 = sqlx::query_scalar("select count(*) from ai_draft_holds")
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(holds, 0);
    // Nothing for the sweep to bring back or to page about.
    assert_eq!(sweep(&owner).await, (0, 0, 0));
}

#[sqlx::test]
async fn the_sweep_ignores_unreadable_events_of_a_redacted_shop_and_keeps_compliance_events_longer(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let owner = owner_pool(opts.clone(), conn.clone()).await;
    let db = Db::from_pool(ctl_pool(opts, conn).await);
    let graph = seed(&db, 4).await;
    let compliance = store_pending(&db, graph, "shop/redact", 1).await;
    let ordinary = store_pending(&db, graph, "shop/update", 2).await;
    // Both jobs are gone (as after a lost queue) and both events are old.
    sqlx::query("delete from jobs")
        .execute(&owner)
        .await
        .unwrap();

    // 20 days: past the 14 days of an ordinary event, inside the 45 of a compliance event.
    sqlx::query("update webhook_events set received_at = now() - interval '20 days'")
        .execute(&owner)
        .await
        .unwrap();
    let (requeued, stuck, _) = sweep(&owner).await;
    assert_eq!((requeued, stuck), (1, 2));
    let queued: Vec<String> = sqlx::query_scalar(
        "select payload ->> 'event_id' from jobs where queue = 'webhook.process'",
    )
    .fetch_all(&owner)
    .await
    .unwrap();
    assert_eq!(queued, [compliance.to_string()]);
    assert!(!queued.contains(&ordinary.to_string()));

    // 50 days: even a compliance event is past the window (the operator path takes over), but it
    // still counts as stuck.
    sqlx::query("delete from jobs")
        .execute(&owner)
        .await
        .unwrap();
    sqlx::query("update webhook_events set received_at = now() - interval '50 days'")
        .execute(&owner)
        .await
        .unwrap();
    let (requeued, stuck, _) = sweep(&owner).await;
    assert_eq!((requeued, stuck), (0, 2));

    // A redacted shop's events whose bodies were cleared are neither re-queued nor counted.
    sqlx::query("update shopify_shops set status = 'redacted'")
        .execute(&owner)
        .await
        .unwrap();
    sqlx::query("update webhook_events set body = null, received_at = now() - interval '2 days'")
        .execute(&owner)
        .await
        .unwrap();
    assert_eq!(sweep(&owner).await, (0, 0, 0));
}

#[sqlx::test]
async fn an_operator_can_complete_a_redaction_once_and_it_is_audited(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let owner = owner_pool(opts.clone(), conn.clone()).await;
    let db = Db::from_pool(ctl_pool(opts, conn).await);
    let graph = seed(&db, 5).await;
    let pending = store_pending(&db, graph, "shop/redact", 1).await;

    let done = redact::complete_by_operator(
        &db,
        "store-5.myshopify.com",
        "ops-1",
        "Partner Dashboard shows the app uninstalled",
    )
    .await
    .unwrap();
    assert_eq!(done.was, "installed");
    assert!(done.ended.changed);
    assert!(done.removed.scans >= 1 && done.removed.events_closed == 1);

    let status: String = sqlx::query_scalar("select status from shopify_shops")
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(status, "redacted");
    let tokens: i64 = sqlx::query_scalar("select count(*) from shopify_tokens")
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(tokens, 0);
    let entry: (String, serde_json::Value) = sqlx::query_as(
        "select actor_kind, data from audit_log where action = 'compliance.shop_redacted_by_operator'",
    )
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(entry.0, "operator");
    assert_eq!(entry.1["confirmed_by"], "ops-1");
    assert_eq!(entry.1["was"], "installed");
    let closed: bool =
        sqlx::query_scalar("select processed_at is not null from webhook_events where id = $1")
            .bind(pending)
            .fetch_one(&owner)
            .await
            .unwrap();
    assert!(
        closed,
        "the pending shop/redact event is closed with the rest"
    );

    assert!(matches!(
        redact::complete_by_operator(&db, "store-5.myshopify.com", "ops-1", "again").await,
        Err(OperatorRedactError::AlreadyRedacted)
    ));
    assert!(matches!(
        redact::complete_by_operator(&db, "nobody.myshopify.com", "ops-1", "x").await,
        Err(OperatorRedactError::UnknownShop)
    ));
}
