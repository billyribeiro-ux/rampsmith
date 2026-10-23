//! `webhook.process@1` (ADR-035, ADR-036, ADR-080): handles one verified Shopify webhook that
//! the api stored in `webhook_events`. The body is read from that row, never from the payload.
//!
//! | Topic | Action |
//! | --- | --- |
//! | `app/uninstalled` | Ask Shopify whether the grant is really gone (the delivery headers are not signed, so a captured delivery can be replayed), then mark the shop uninstalled, cancel its jobs, delete its tokens and start the retention clock |
//! | `shop/redact` | Delete all of the shop's data (PLAN §19), keeping the audit log and the webhook digests |
//! | `customers/data_request`, `customers/redact` | R1 stores no data about a shop's customers, so the answer is "none held", recorded in the audit log without the customer's details |
//! | `shop/update` | Read the shop again: primary domain and locales |
//!
//! Every branch is idempotent: running an event twice, or two events for one shop at once,
//! ends in the same state.

use contracts::WebhookProcess;
use db::repo::{audit, redact, shopify as shops, webhooks};
use domain::{ActorKind, ShopId, TenantId};
use queue::{ClaimedJob, Failure};
use serde_json::{Value, json};
use tracing::{info, instrument, warn};
use uuid::Uuid;

use super::{Jobs, admin, database, failure, payload, tenant_of};

/// Handles one `webhook.process@1` job.
#[instrument(skip_all, fields(job = %job.lease.job_id), err(Debug))]
pub async fn handle(jobs: &Jobs, job: ClaimedJob) -> Result<(), Failure> {
    let WebhookProcess { event_id } = payload(&job, WebhookProcess::SCHEMA)?;
    let tenant = tenant_of(&job)?;

    let mut tx = jobs.db.tenant(tenant).await.map_err(|e| database(&e))?;
    let event = webhooks::get(&mut tx, event_id)
        .await
        .map_err(|e| database(&e))?;
    let shop_row = match &event {
        Some(event) => shops::get(&mut tx, event.shop_id)
            .await
            .map_err(|e| database(&e))?,
        None => None,
    };
    tx.rollback().await.map_err(|e| database(&e))?;
    let Some(event) = event else {
        return Err(failure(
            false,
            "event_missing",
            "the webhook event does not exist",
        ));
    };
    if event.processed_at.is_some() {
        return Ok(());
    }
    let (Some(body), Some(shop_row)) = (event.body.as_ref(), shop_row) else {
        return Err(failure(
            false,
            "event_unreadable",
            "the event has no body or shop",
        ));
    };
    // The shop header is not covered by the signature, but the body is: refuse an event whose
    // body names another shop than the one it was filed under (the api checks this too).
    if webhooks::body_shop_domain(body) != Some(shop_row.shop_domain.as_str()) {
        warn!(topic = %event.topic, "webhook body names another shop than its header");
        return Err(failure(
            false,
            "shop_mismatch",
            "the body names another shop",
        ));
    }

    match event.topic.as_str() {
        "app/uninstalled" => uninstalled(jobs, tenant, event_id, event.shop_id).await,
        "shop/redact" => redact_shop(jobs, tenant, event_id, event.shop_id).await,
        "customers/data_request" => {
            customer(jobs, tenant, event_id, event.shop_id, "data_request", body).await
        }
        "customers/redact" => customer(jobs, tenant, event_id, event.shop_id, "redact", body).await,
        "shop/update" => shop_update(jobs, tenant, event_id, event.shop_id).await,
        other => Err(failure(
            false,
            "topic_unsupported",
            format!("no handler for {other}"),
        )),
    }
}

async fn finish(
    jobs: &Jobs,
    tenant: TenantId,
    event_id: Uuid,
    action: &str,
    shop: ShopId,
    data: Value,
) -> Result<(), Failure> {
    let mut tx = jobs.db.tenant(tenant).await.map_err(|e| database(&e))?;
    record(&mut tx, event_id, action, shop, data).await?;
    tx.commit().await.map_err(|e| database(&e))
}

async fn record(
    tx: &mut db::TenantTx,
    event_id: Uuid,
    action: &str,
    shop: ShopId,
    mut data: Value,
) -> Result<(), Failure> {
    if let Some(map) = data.as_object_mut() {
        map.insert("event_id".to_owned(), json!(event_id));
        map.insert("shop_id".to_owned(), json!(shop.as_uuid()));
    }
    audit::append(
        tx,
        &audit::NewEntry {
            actor_kind: ActorKind::Shopify,
            actor_id: None,
            action: action.to_owned(),
            subject_type: "webhook_event".to_owned(),
            subject_id: event_id,
            data,
        },
    )
    .await
    .map_err(|e| database(&e))?;
    webhooks::mark_processed(tx, event_id)
        .await
        .map_err(|e| database(&e))?;
    Ok(())
}

async fn uninstalled(
    jobs: &Jobs,
    tenant: TenantId,
    event_id: Uuid,
    shop: ShopId,
) -> Result<(), Failure> {
    // Is the grant really gone? `client` is `None` when the shop is not installed or Shopify
    // revoked the refresh token; a token Shopify still accepts means a replayed delivery for a
    // shop that installed the app again (integration audit M1).
    if let Some(client) = jobs.client(tenant, shop).await? {
        match client.shop().await {
            Err(e) if e.is_token_dead() => {}
            Ok(_) => {
                info!(%shop, "app/uninstalled ignored: the shop's token still works");
                return finish(
                    jobs,
                    tenant,
                    event_id,
                    "webhook.uninstall_ignored",
                    shop,
                    json!({"reason": "grant_still_valid"}),
                )
                .await;
            }
            Err(e) => return Err(admin(&e)),
        }
    }
    let mut tx = jobs.db.tenant(tenant).await.map_err(|e| database(&e))?;
    let changed = shops::mark_uninstalled(&mut tx, shop)
        .await
        .map_err(|e| database(&e))?;
    shops::delete_tokens(&mut tx, shop)
        .await
        .map_err(|e| database(&e))?;
    let cancelled = db::repo::jobs::cancel_pending(&mut tx, WebhookProcess::QUEUE)
        .await
        .map_err(|e| database(&e))?;
    record(
        &mut tx,
        event_id,
        "shopify.app_uninstalled",
        shop,
        json!({"changed": changed, "jobs_cancelled": cancelled}),
    )
    .await?;
    tx.commit().await.map_err(|e| database(&e))?;
    info!(%shop, changed, cancelled, "app uninstalled");
    Ok(())
}

async fn redact_shop(
    jobs: &Jobs,
    tenant: TenantId,
    event_id: Uuid,
    shop: ShopId,
) -> Result<(), Failure> {
    let mut tx = jobs.db.tenant(tenant).await.map_err(|e| database(&e))?;
    let cancelled = db::repo::jobs::cancel_pending(&mut tx, WebhookProcess::QUEUE)
        .await
        .map_err(|e| database(&e))?;
    let report = redact::shop(&mut tx, shop)
        .await
        .map_err(|e| database(&e))?
        .ok_or_else(|| failure(false, "shop_missing", "the shop does not exist"))?;
    record(
        &mut tx,
        event_id,
        "compliance.shop_redacted",
        shop,
        json!({"removed": report, "jobs_cancelled": cancelled}),
    )
    .await?;
    tx.commit().await.map_err(|e| database(&e))?;
    info!(%shop, "shop data redacted");
    Ok(())
}

async fn customer(
    jobs: &Jobs,
    tenant: TenantId,
    event_id: Uuid,
    shop: ShopId,
    kind: &str,
    body: &Value,
) -> Result<(), Failure> {
    // R1 keeps nothing about a shop's customers: scans read pages, products and menus, never
    // orders or customers (PLAN §14, scopes). Barrier reports, which could carry a shopper's
    // email, arrive with the theme app extension in R2 and bring their own lookup and delete.
    // The request's own details (id, email, phone) are not copied anywhere.
    let request = body
        .get("data_request")
        .and_then(|r| r.get("id"))
        .and_then(Value::as_i64);
    finish(
        jobs,
        tenant,
        event_id,
        &format!("compliance.customer_{kind}"),
        shop,
        json!({"result": "none_held", "request_id": request}),
    )
    .await
}

async fn shop_update(
    jobs: &Jobs,
    tenant: TenantId,
    event_id: Uuid,
    shop: ShopId,
) -> Result<(), Failure> {
    let Some(client) = jobs.client(tenant, shop).await? else {
        return finish(
            jobs,
            tenant,
            event_id,
            "webhook.shop_update_skipped",
            shop,
            json!({"reason": "not_installed"}),
        )
        .await;
    };
    let info = client.shop().await.map_err(|e| admin(&e))?;
    let locales: Vec<String> = info.locales.iter().map(|l| l.locale.clone()).collect();
    let mut tx = jobs.db.tenant(tenant).await.map_err(|e| database(&e))?;
    shops::set_info(
        &mut tx,
        shop,
        &info.name,
        info.primary_domain.as_ref().map(|d| d.host.as_str()),
        &locales,
    )
    .await
    .map_err(|e| database(&e))?;
    record(&mut tx, event_id, "shopify.shop_updated", shop, json!({})).await?;
    tx.commit().await.map_err(|e| database(&e))
}
