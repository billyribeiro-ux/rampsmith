//! The owner's contact and the uninstall export email (ADR-270 to ADR-272, lane A audit L8),
//! against PostgreSQL as the worker role and a mock Admin API.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use contracts::{EmailRecipient, EmailSend, EmailTemplate, WebhookProcess};
use db::repo::webhooks::{self, NewWebhook, Recorded};
use serde_json::{Value, json};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use uuid::Uuid;

mod support;

use support::world::{SHOP, World, world};

const OWNER: &str = "Owner.Of.Demo@Demo-Store.example";

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

async fn process(w: &World, jobs: &ctl::jobs::Jobs, event: Uuid) {
    let job = w.job(
        WebhookProcess::QUEUE,
        WebhookProcess::SCHEMA,
        json!({"event_id": event}),
    );
    jobs.dispatch(job).await.unwrap();
}

fn shop_object() -> Value {
    json!({"id": 548_380_009, "myshopify_domain": SHOP, "domain": "demo.example"})
}

fn shop_response(email: Option<&str>) -> Value {
    let mut shop = json!({"id": "gid://shopify/Shop/1", "name": "Demo Outfitters",
                          "myshopifyDomain": SHOP,
                          "primaryDomain": {"host": "demo.example", "url": "https://demo.example"}});
    if let Some(email) = email {
        shop["email"] = json!(email);
    }
    json!({"data": {
        "shop": shop,
        "shopLocales": [{"locale": "fr", "primary": true, "published": true},
                        {"locale": "en", "primary": false, "published": true}],
        "themes": {"nodes": []}
    }})
}

/// What a real uninstall looks like to ctl: Shopify rejects the token.
async fn shopify_revoked(w: &World) {
    w.admin_answers(
        401,
        json!({"errors": "[API] Invalid API key or access token"}),
    )
    .await;
}

async fn export_email_result(w: &World, action: &str) -> String {
    let data: Value = sqlx::query_scalar(
        "select data from audit_log where action = $1 order by at desc, id desc limit 1",
    )
    .bind(action)
    .fetch_one(&w.owner)
    .await
    .unwrap();
    data["export_email"].as_str().unwrap().to_owned()
}

/// Gives the shop a stored contact, as `shop/update` and `shopify.read_store` do.
async fn contact_stored(w: &World, jobs: &ctl::jobs::Jobs) {
    w.admin_operation("RampsmithShop", shop_response(Some(OWNER)))
        .await;
    w.admin_operation("RampsmithShopOwner", shop_response(Some(OWNER)))
        .await;
    let update = store(w, "shop/update", shop_object()).await;
    process(w, jobs, update).await;
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn shop_update_keeps_the_owners_address_for_email_and_the_audit_log_never_sees_it(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let w = world(opts, conn).await;
    contact_stored(&w, &w.jobs).await;

    let row: (String, String, Option<String>) =
        sqlx::query_as("select email, store_name, locale from shop_contacts")
            .fetch_one(&w.owner)
            .await
            .unwrap();
    assert_eq!(
        row,
        (
            OWNER.to_lowercase(),
            "Demo Outfitters".to_owned(),
            Some("fr".to_owned())
        ),
        "the address is stored lower-case, with the store's name and primary language"
    );
    let audit: Value =
        sqlx::query_scalar("select data from audit_log where action = 'shopify.shop_updated'")
            .fetch_one(&w.owner)
            .await
            .unwrap();
    assert_eq!(audit["contact"], "stored");
    let everything: String =
        sqlx::query_scalar("select coalesce(string_agg(data::text, ' '), '') from audit_log")
            .fetch_one(&w.owner)
            .await
            .unwrap();
    assert!(!everything.to_lowercase().contains("demo-store.example"));
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn a_shop_that_reports_no_usable_address_gets_no_contact(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let w = world(opts, conn).await;
    for (email, expected) in [
        (None, "none_reported"),
        (Some("not an address"), "unusable"),
        // Passes the table's check but not the sender's rule (audit L3).
        (Some("owner@.com"), "unusable"),
    ] {
        w.admin.reset().await;
        w.admin_operation("RampsmithShop", shop_response(email))
            .await;
        w.admin_operation("RampsmithShopOwner", shop_response(email))
            .await;
        let update = store(&w, "shop/update", shop_object()).await;
        process(&w, &w.jobs, update).await;
        let audit: Value = sqlx::query_scalar(
            "select data from audit_log where action = 'shopify.shop_updated'
              order by at desc, id desc limit 1",
        )
        .fetch_one(&w.owner)
        .await
        .unwrap();
        assert_eq!(audit["contact"], expected);
    }
    assert_eq!(w.count("select count(*) from shop_contacts").await, 0);
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn an_uninstall_queues_the_export_email_by_reference_in_the_same_transaction(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let w = world(opts, conn).await;
    let jobs = w.jobs.clone();
    contact_stored(&w, &jobs).await;
    w.admin.reset().await;
    shopify_revoked(&w).await;
    let event = store(&w, "app/uninstalled", shop_object()).await;
    let before = OffsetDateTime::now_utc();

    process(&w, &jobs, event).await;

    assert_eq!(
        export_email_result(&w, "shopify.app_uninstalled").await,
        "queued"
    );
    let (queue, schema, payload, tenant, key, state): (
        String,
        String,
        Value,
        Uuid,
        String,
        String,
    ) = sqlx::query_as(
        "select queue, payload_schema, payload, tenant_id, idempotency_key, state
               from jobs where queue = 'email.send'",
    )
    .fetch_one(&w.owner)
    .await
    .unwrap();
    assert_eq!(
        (queue.as_str(), schema.as_str()),
        ("email.send", "email.send@1")
    );
    assert_eq!(tenant, w.session.tenant.as_uuid());
    assert_eq!(
        state, "ready",
        "the uninstall's own job cancellation spared it"
    );
    assert_eq!(key, format!("email.send:uninstall-export:{event}"));

    // The payload is the contract's, and names the recipient by reference.
    let message: EmailSend = serde_json::from_value(payload.clone()).unwrap();
    assert_eq!(message.template, EmailTemplate::UninstallExport);
    assert_eq!(
        message.recipient,
        EmailRecipient::ShopOwner {
            shop_id: w.session.shop_id.as_uuid()
        }
    );
    assert_eq!(message.message_key, format!("uninstall-export:{event}"));
    assert_eq!(message.input["storeName"], "Demo Outfitters");
    assert!(
        message.input.get("exportUrl").is_none(),
        "the record is an attachment the mailer builds, not a link (ADR-277)"
    );
    assert_eq!(message.input["locale"], "fr");
    let delete_at =
        OffsetDateTime::parse(message.input["deleteAt"].as_str().unwrap(), &Rfc3339).unwrap();
    let window = delete_at - before;
    assert!(
        window > time::Duration::hours(47) && window < time::Duration::hours(49),
        "the data goes with Shopify's shop/redact, 48 hours after the uninstall: {window}"
    );
    assert!(
        !payload
            .to_string()
            .to_lowercase()
            .contains("demo-store.example"),
        "no address travels through the queue"
    );
    let audit: String = sqlx::query_scalar("select string_agg(data::text, ' ') from audit_log")
        .fetch_one(&w.owner)
        .await
        .unwrap();
    assert!(!audit.to_lowercase().contains("demo-store.example"));
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn a_replayed_uninstall_queues_nothing_more(opts: PgPoolOptions, conn: PgConnectOptions) {
    let w = world(opts, conn).await;
    let jobs = w.jobs.clone();
    contact_stored(&w, &jobs).await;
    w.admin.reset().await;
    shopify_revoked(&w).await;
    let first = store(&w, "app/uninstalled", shop_object()).await;
    process(&w, &jobs, first).await;
    // A second delivery of the same uninstall, with a new delivery id.
    let again = store(
        &w,
        "app/uninstalled",
        json!({"id": 1, "myshopify_domain": SHOP, "n": 2}),
    )
    .await;
    process(&w, &jobs, again).await;

    assert_eq!(
        w.count("select count(*) from jobs where queue = 'email.send'")
            .await,
        1
    );
    assert_eq!(
        export_email_result(&w, "shopify.app_uninstalled").await,
        "not_queued_already_uninstalled"
    );
    // The second uninstall's cancellation spared the mail still waiting to go out (audit L1).
    assert_eq!(
        w.count("select count(*) from jobs where queue = 'email.send' and state = 'ready'")
            .await,
        1,
        "the export email is still ready after a repeated app/uninstalled"
    );
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn a_shop_never_read_has_no_contact_to_email(opts: PgPoolOptions, conn: PgConnectOptions) {
    let w = world(opts, conn).await;
    let jobs = w.jobs.clone();
    shopify_revoked(&w).await;
    let event = store(&w, "app/uninstalled", shop_object()).await;
    process(&w, &jobs, event).await;
    assert_eq!(
        export_email_result(&w, "shopify.app_uninstalled").await,
        "not_queued_no_contact"
    );
    assert_eq!(
        w.count("select count(*) from jobs where queue = 'email.send'")
            .await,
        0
    );
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn an_uninstall_for_a_shop_whose_token_still_works_queues_nothing(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let w = world(opts, conn).await;
    let jobs = w.jobs.clone();
    contact_stored(&w, &jobs).await;
    // Shopify still accepts the token: the delivery is a replay (audit M1).
    w.admin_answers(200, shop_response(Some(OWNER))).await;
    let event = store(&w, "app/uninstalled", shop_object()).await;
    process(&w, &jobs, event).await;
    assert_eq!(
        w.count("select count(*) from jobs where queue = 'email.send'")
            .await,
        0
    );
    assert_eq!(w.count("select count(*) from shop_contacts").await, 1);
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn shop_redact_deletes_the_contact(opts: PgPoolOptions, conn: PgConnectOptions) {
    let w = world(opts, conn).await;
    let jobs = w.jobs.clone();
    contact_stored(&w, &jobs).await;
    assert_eq!(w.count("select count(*) from shop_contacts").await, 1);
    w.admin.reset().await;
    shopify_revoked(&w).await;
    let event = store(
        &w,
        "shop/redact",
        json!({"shop_id": 1, "shop_domain": SHOP}),
    )
    .await;
    process(&w, &jobs, event).await;
    assert_eq!(w.count("select count(*) from shop_contacts").await, 0);
}
