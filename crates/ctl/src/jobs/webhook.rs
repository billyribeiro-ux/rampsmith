//! `webhook.process@1` (ADR-035, ADR-036, ADR-080): handles one verified Shopify webhook that
//! the api stored in `webhook_events`. The body is read from that row, never from the payload.
//!
//! | Topic | Action |
//! | --- | --- |
//! | `app/uninstalled` | Ask Shopify whether the grant is really gone (the delivery headers are not signed, so a captured delivery can be replayed), then mark the shop uninstalled, cancel its jobs, delete its tokens and start the retention clock |
//! | `shop/redact` | A shop still `installed` is redacted only after the same grant check as an uninstall (a token Shopify still accepts: audit `compliance.shop_redact_ignored`, nothing deleted; a 404 means the store is gone and counts as a revoked grant); then delete all of the shop's data (PLAN §19), keeping the audit log and the webhook digests, and close the shop's other pending events |
//! | `customers/data_request`, `customers/redact` | R1 stores no data about a shop's customers, so the answer is "none held", recorded in the audit log without the customer's details |
//! | `shop/update` | Read the shop again: primary domain and locales |
//!
//! Every branch is idempotent: running an event twice, or two events for one shop at once,
//! ends in the same state.
//!
//! The grant check retries on every answer except 401 (and, for `shop/redact`, 404): a frozen
//! (402), locked (423, `SHOP_INACTIVE`) or forbidden (403) store may recover, and deciding
//! anything from those answers would let a replay end a live shop. `*/redact` events keep being
//! re-queued by the sweep for 45 days, and an operator can complete a redaction by hand once a
//! person has confirmed the uninstall (`rsctl shops redact`, ADR-269).

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
    let Some(shop_row) = shop_row else {
        return Err(failure(false, "event_unreadable", "the event has no shop"));
    };
    let Some(body) = event.body.as_ref() else {
        // Redaction clears the bodies of the shop's events and closes the pending ones; a job
        // that was already running or queued still arrives here. There is nothing left to
        // handle and nothing to retry: record it and finish (re-audit M-1, ADR-269).
        if shop_row.status == domain::ShopStatus::Redacted {
            return finish(
                jobs,
                tenant,
                event_id,
                "webhook.skipped_shop_redacted",
                event.shop_id,
                json!({"topic": event.topic}),
            )
            .await;
        }
        return Err(failure(false, "event_unreadable", "the event has no body"));
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

/// What Shopify says about the shop's grant.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Grant {
    /// The grant is gone: no token to try, or Shopify answers 401.
    Gone,
    /// Shopify still accepts the token: a delivery that asks to end the installation is a
    /// replay for a shop that installed the app again (integration audit M1, lane A audit H1).
    Valid,
    /// Shopify answers 404: the store no longer exists.
    StoreGone,
}

/// Asks Shopify whether the shop's grant is revoked. Only 401 is an answer to act on, and 404
/// where the caller says a deleted store settles the question. Every other answer (402, 403,
/// 423, `SHOP_INACTIVE`, 429, 5xx, a lost connection) is a retry, never a decision: a frozen
/// or closed shop may recover, a missing scope is not an uninstall, and none of them may end a
/// live shop (re-audit M-2, ADR-085 item 4, ADR-269). The sweep re-queues the event for weeks
/// after the job's own attempts run out.
async fn check_grant(jobs: &Jobs, tenant: TenantId, shop: ShopId) -> Result<Grant, Failure> {
    // `client` is `None` when the shop is not installed or Shopify revoked the refresh token.
    let Some(client) = jobs.client(tenant, shop).await? else {
        return Ok(Grant::Gone);
    };
    match client.grant_check().await {
        Ok(()) => Ok(Grant::Valid),
        Err(e) if e.is_token_dead() => Ok(Grant::Gone),
        Err(shopify_admin::AdminError::NotFound) => Ok(Grant::StoreGone),
        // Retryable whatever the error's own classification says.
        Err(e) => Err(failure(true, e.code(), e.to_string())),
    }
}

/// Whether an `app/uninstalled` may proceed. A deleted store (404) is not enough here: the
/// matching `shop/redact` settles it, and until then the uninstall is retried.
async fn grant_is_gone(jobs: &Jobs, tenant: TenantId, shop: ShopId) -> Result<bool, Failure> {
    match check_grant(jobs, tenant, shop).await? {
        Grant::Gone => Ok(true),
        Grant::Valid => Ok(false),
        Grant::StoreGone => Err(failure(
            true,
            "shop_not_found",
            "Shopify does not know the store; the shop/redact settles it",
        )),
    }
}

/// Marks the shop uninstalled and removes what an uninstall removes.
async fn end_installation(tx: &mut db::TenantTx, shop: ShopId) -> Result<redact::Ended, Failure> {
    redact::end_installation(tx, shop)
        .await
        .map_err(|e| database(&e))
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
/// confirms the grant is gone, exactly as for `app/uninstalled` (lane A audit H1, ADR-085). A
/// store Shopify no longer knows (404) has no grant to check and is redacted too (ADR-269).
async fn redact_shop(
    jobs: &Jobs,
    tenant: TenantId,
    event_id: Uuid,
    shop: ShopId,
    installed: bool,
) -> Result<(), Failure> {
    if installed && check_grant(jobs, tenant, shop).await? == Grant::Valid {
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
    // The decision above rests on a read made before Shopify was asked. Lock the row and look
    // again: a shop that was not installed then and is installed now was installed again in
    // between, and nothing has checked its new grant (re-audit L-2). Start over instead.
    let current = shops::lock_status(&mut tx, shop)
        .await
        .map_err(|e| database(&e))?
        .ok_or_else(|| failure(false, "shop_missing", "the shop does not exist"))?;
    if !installed && current == domain::ShopStatus::Installed {
        tx.rollback().await.map_err(|e| database(&e))?;
        return Err(failure(
            true,
            "shop_changed",
            "the shop was installed again while shop/redact was handled; checking again",
        ));
    }
    let ended = end_installation(&mut tx, shop).await?;
    let report = redact::shop(&mut tx, shop)
        .await
        .map_err(|e| database(&e))?
        .ok_or_else(|| failure(false, "shop_missing", "the shop does not exist"))?;
    record(
        &mut tx,
        event_id,
        "compliance.shop_redacted",
        shop,
        json!({"removed": report, "jobs_cancelled": ended.cancelled}),
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
