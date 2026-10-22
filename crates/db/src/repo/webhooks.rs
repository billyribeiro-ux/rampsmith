//! Verified Shopify webhooks, stored once and processed from the table (PLAN §14, §19;
//! ADR-037, ADR-080).

use domain::ShopId;
use serde_json::Value;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::{DbError, TenantTx};

/// How long a repeat of the same body for the same topic counts as a replay (ADR-080).
///
/// A captured delivery can come back under a new event id, because the id headers are not
/// covered by the HMAC (integration audit M1). Shopify itself resends a body only on a
/// retry (same webhook id, minutes to 4 hours) or, for `shop/redact`, once per uninstall,
/// which is at least 48 hours after the app was installed again.
pub const REPLAY_WINDOW_HOURS: i32 = 24;

/// The shop domain a webhook body names: `shop_domain` in the compliance payloads,
/// `myshopify_domain` in the shop object that `app/uninstalled` and `shop/update` carry.
///
/// The `X-Shopify-Shop-Domain` header is not covered by the signature, the body is, so the api
/// and the worker both refuse a delivery whose header names another shop than its body.
#[must_use]
pub fn body_shop_domain(body: &Value) -> Option<&str> {
    body.get("shop_domain")
        .or_else(|| body.get("myshopify_domain"))
        .and_then(Value::as_str)
}

/// Input for [`record`].
#[derive(Debug, Clone)]
pub struct NewWebhook {
    /// The shop the webhook is about.
    pub shop_id: ShopId,
    /// `X-Shopify-Webhook-Id`: unique per delivery attempt chain (a retry reuses it).
    pub external_id: String,
    /// `X-Shopify-Topic`, such as `app/uninstalled`.
    pub topic: String,
    /// The parsed body.
    pub body: Value,
    /// SHA-256 of the raw body.
    pub body_sha256: [u8; 32],
}

/// What [`record`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Recorded {
    /// A new event, with this id, ready to process.
    Stored(Uuid),
    /// The same delivery (event id) was stored before.
    DuplicateDelivery,
    /// The same body for this topic was stored within [`REPLAY_WINDOW_HOURS`] under another
    /// id: a replay.
    DuplicateBody,
}

/// A stored webhook event.
#[derive(Debug, Clone, PartialEq)]
pub struct WebhookEvent {
    /// The event's id.
    pub id: Uuid,
    /// The shop it is about.
    pub shop_id: ShopId,
    /// The topic.
    pub topic: String,
    /// The body, until the event is processed.
    pub body: Option<Value>,
    /// When it arrived.
    pub received_at: OffsetDateTime,
    /// When it was processed.
    pub processed_at: Option<OffsetDateTime>,
}

/// Stores a verified webhook unless it repeats one already stored. The caller enqueues
/// `webhook.process` in the same transaction when this returns [`Recorded::Stored`].
pub async fn record(tx: &mut TenantTx, new: &NewWebhook) -> Result<Recorded, DbError> {
    let tenant = tx.tenant_uuid();
    let digest = new.body_sha256.as_slice();
    let replay = sqlx::query_scalar!(
        r#"select exists (
             select 1 from webhook_events
              where tenant_id = $1 and topic = $2 and body_sha256 = $3
                and received_at > now() - make_interval(hours => $4)
           ) as "replay!""#,
        tenant,
        new.topic,
        digest,
        REPLAY_WINDOW_HOURS,
    )
    .fetch_one(tx.conn())
    .await?;
    if replay {
        return Ok(Recorded::DuplicateBody);
    }
    let id = Uuid::now_v7();
    let inserted = sqlx::query_scalar!(
        r#"insert into webhook_events (id, tenant_id, shop_id, external_id, topic, body, body_sha256)
           values ($1, $2, $3, $4, $5, $6, $7)
           on conflict (tenant_id, external_id) do nothing
        returning id"#,
        id,
        tenant,
        new.shop_id.as_uuid(),
        new.external_id,
        new.topic,
        new.body,
        digest,
    )
    .fetch_optional(tx.conn())
    .await?;
    Ok(inserted.map_or(Recorded::DuplicateDelivery, Recorded::Stored))
}

/// One event of the transaction's tenant.
pub async fn get(tx: &mut TenantTx, id: Uuid) -> Result<Option<WebhookEvent>, DbError> {
    let tenant = tx.tenant_uuid();
    let row = sqlx::query!(
        r#"select id, shop_id, topic, body, received_at, processed_at
             from webhook_events where tenant_id = $1 and id = $2"#,
        tenant,
        id,
    )
    .fetch_optional(tx.conn())
    .await?;
    Ok(row.map(|r| WebhookEvent {
        id: r.id,
        shop_id: ShopId::from_uuid(r.shop_id),
        topic: r.topic,
        body: r.body,
        received_at: r.received_at,
        processed_at: r.processed_at,
    }))
}

/// Marks an event processed and clears its body (the digest stays). `false` when it does not
/// exist for this tenant or was already processed.
pub async fn mark_processed(tx: &mut TenantTx, id: Uuid) -> Result<bool, DbError> {
    let tenant = tx.tenant_uuid();
    let done = sqlx::query!(
        r#"update webhook_events set processed_at = now(), body = null
            where tenant_id = $1 and id = $2 and processed_at is null"#,
        tenant,
        id,
    )
    .execute(tx.conn())
    .await?;
    Ok(done.rows_affected() > 0)
}
