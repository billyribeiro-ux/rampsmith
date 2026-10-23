//! `webhook.process@1` (ADR-035, ADR-036, ADR-080): handles one verified Shopify webhook that
//! the api stored in `webhook_events`. The body is read from that row, never from the payload.
//!
//! | Topic | Action |
//! | --- | --- |
//! | `app/uninstalled` | Ask Shopify whether the grant is really gone (the delivery headers are not signed, so a captured delivery can be replayed), then mark the shop uninstalled, cancel its jobs, delete its tokens and start the retention clock |
//! | `shop/redact` | A shop still `installed` is redacted only after the same grant check as an uninstall (a token Shopify still accepts: audit `compliance.shop_redact_ignored`, nothing deleted); then delete all of the shop's data (PLAN §19), keeping the audit log and the webhook digests |
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
    if !webhooks::body_shop_domain(body)
        .is_some_and(|named| named.eq_ignore_ascii_case(&shop_row.shop_domain))
    {
        warn!(topic = %event.topic, "webhook body names another shop than its header");
        return Err(failure(
            false,
            "shop_mismatch",
            "the body names another shop",
        ));
    }

    match event.topic.as_str() {
        "app/uninstalled" => uninstalled(jobs, tenant, event_id, event.shop_id).await,
        "shop/redact" => {
            let installed = shop_row.status == domain::ShopStatus::Installed;
            redact_shop(jobs, tenant, event_id, event.shop_id, installed).await
        }
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

/// Whether Shopify has really revoked the shop's grant. `Ok(true)`: it is gone (no token to
/// try, or Shopify answers 401). `Ok(false)`: a token Shopify still accepts, so the delivery
/// that asked is a replay for a shop that installed the app again (integration audit M1, lane
/// A audit H1). Any other answer is an error to retry, never a decision.
async fn grant_is_gone(jobs: &Jobs, tenant: TenantId, shop: ShopId) -> Result<bool, Failure> {
    // `client` is `None` when the shop is not installed or Shopify revoked the refresh token.
    let Some(client) = jobs.client(tenant, shop).await? else {
        return Ok(true);
    };
    match client.grant_check().await {
        Ok(()) => Ok(false),
        Err(e) if e.is_token_dead() => Ok(true),
        Err(e) => Err(admin(&e)),
    }
}

/// What ending an installation changed.
struct Ended {
    /// The shop's status changed (it was installed).
    changed: bool,
    /// Queued jobs cancelled.
    cancelled: u64,
    /// Approved or applying fixes ended as failed (`shop_uninstalled`).
    fixes_failed: u64,
}

/// Marks the shop uninstalled and removes what an uninstall removes.
async fn end_installation(tx: &mut db::TenantTx, shop: ShopId) -> Result<Ended, Failure> {
    let changed = shops::mark_uninstalled(tx, shop)
        .await
        .map_err(|e| database(&e))?;
    shops::delete_tokens(tx, shop)
        .await
        .map_err(|e| database(&e))?;
    let cancelled = db::repo::jobs::cancel_pending(tx, WebhookProcess::QUEUE)
        .await
        .map_err(|e| database(&e))?;
    // Their apply jobs were cancelled with the rest: without this they would stay approved for
    // ever (lane A audit L2).
    let fixes_failed = db::repo::data_fixes::fail_in_flight(tx, "shop_uninstalled")
        .await
        .map_err(|e| database(&e))?;
    Ok(Ended {
        changed,
        cancelled,
        fixes_failed,
    })
}

async fn uninstalled(
    jobs: &Jobs,
    tenant: TenantId,
    event_id: Uuid,
    shop: ShopId,
) -> Result<(), Failure> {
    if !grant_is_gone(jobs, tenant, shop).await? {
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
    let mut tx = jobs.db.tenant(tenant).await.map_err(|e| database(&e))?;
    let ended = end_installation(&mut tx, shop).await?;
    record(
        &mut tx,
        event_id,
        "shopify.app_uninstalled",
        shop,
        json!({"changed": ended.changed, "jobs_cancelled": ended.cancelled,
               "fixes_failed": ended.fixes_failed,
               // No mail transport or send job exists yet (audit L8, ADR-087).
               "export_email": "not_queued_no_sender"}),
    )
    .await?;
    tx.commit().await.map_err(|e| database(&e))?;
    info!(%shop, changed = ended.changed, cancelled = ended.cancelled, "app uninstalled");
    Ok(())
}

/// `shop/redact`. Shopify sends it 48 hours after an uninstall, but the topic header and the
/// delivery id are not signed, so a captured signed body can be replayed against a shop that
/// installed the app again. An `installed` shop is therefore redacted only when Shopify
/// confirms the grant is gone, exactly as for `app/uninstalled` (lane A audit H1, ADR-085).
async fn redact_shop(
    jobs: &Jobs,
    tenant: TenantId,
    event_id: Uuid,
    shop: ShopId,
    installed: bool,
) -> Result<(), Failure> {
    if installed && !grant_is_gone(jobs, tenant, shop).await? {
        warn!(%shop, "shop/redact ignored: the shop's token still works");
        return finish(
            jobs,
            tenant,
            event_id,
            "compliance.shop_redact_ignored",
            shop,
            json!({"reason": "grant_still_valid"}),
        )
        .await;
    }
    let mut tx = jobs.db.tenant(tenant).await.map_err(|e| database(&e))?;
    let cancelled = if installed {
        end_installation(&mut tx, shop).await?.cancelled
    } else {
        db::repo::jobs::cancel_pending(&mut tx, WebhookProcess::QUEUE)
            .await
            .map_err(|e| database(&e))?
    };
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
