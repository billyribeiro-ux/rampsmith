//! Verified Shopify webhooks, stored once and processed from the table (PLAN §14, §19;
//! ADR-037, ADR-080).

use domain::ShopId;
use serde_json::Value;
use sha2::{Digest, Sha256};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::{DbError, TenantTx};

/// How long a repeat of the same body counts as a replay (ADR-080, ADR-085): under any
/// compliance topic, and under the same topic for the rest (ADR-269).
///
/// A captured delivery can come back under a new event id and another topic, because neither
/// header is covered by the HMAC (integration audit M1, lane A audit H1). Shopify itself
/// resends a body only on a retry (same webhook id, minutes to 4 hours).
pub const REPLAY_WINDOW_HOURS: i32 = 24;

/// The window for the `*/redact` topics. A genuine `shop/redact` for a shop that installed
/// the app again follows its uninstall by 48 hours, so the earliest a genuine repeat of the
/// same body can arrive is 48 hours after the first one; 40 hours stays under that and well
/// over [`REPLAY_WINDOW_HOURS`]. The worker's grant check, not this window, is what protects
/// an installed shop (ADR-085).
pub const REDACT_REPLAY_WINDOW_HOURS: i32 = 40;

/// The replay window for `topic`, in hours.
#[must_use]
pub fn replay_window_hours(topic: &str) -> i32 {
    if topic.ends_with("/redact") {
        REDACT_REPLAY_WINDOW_HOURS
    } else {
        REPLAY_WINDOW_HOURS
    }
}

/// The compliance topics, whose bodies share one replay digest: a signed body captured under
/// one of them could be resent under another because the topic header is unsigned. Their
/// shapes differ (ADR-269), so a cross-topic replay is also refused on shape.
pub const COMPLIANCE_TOPICS: [&str; 3] =
    ["customers/data_request", "customers/redact", "shop/redact"];

/// The key a body's replay claim is filed under in `webhook_digests` (re-audit L-1).
///
/// A compliance topic files its body's own SHA-256, so the same body under any compliance topic
/// is one claim. Every other topic files a digest keyed on the topic too: `shop/update` and
/// `app/uninstalled` both carry the shop object, so a `shop/update` seconds before an uninstall
/// can have an identical body, and sharing the claim made the uninstall look like a replay and
/// dropped it. Neither value is stored for any other purpose than replay detection.
#[must_use]
pub fn replay_key(topic: &str, body_sha256: &[u8; 32]) -> [u8; 32] {
    if COMPLIANCE_TOPICS.contains(&topic) {
        return *body_sha256;
    }
    let mut hash = Sha256::new();
    hash.update(b"rampsmith.webhook.replay.v1\0");
    hash.update(topic.as_bytes());
    hash.update([0]);
    hash.update(body_sha256);
    hash.finalize().into()
}

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
    /// The same body, under any topic, was claimed within its replay window under another id:
    /// a replay.
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
    let claim = replay_key(&new.topic, &new.body_sha256);
    // One statement claims the digest: it inserts, or takes over a digest whose window has
    // passed, and returns nothing when a live claim exists. The primary key serialises two
    // concurrent replays (the second waits for the first to commit, then finds the claim).
    let claimed = sqlx::query_scalar!(
        r#"insert into webhook_digests (tenant_id, body_sha256, topic, expires_at)
           values ($1, $2, $3, now() + make_interval(hours => $4))
           on conflict (tenant_id, body_sha256) do update
              set topic = excluded.topic, claimed_at = now(), expires_at = excluded.expires_at
            where webhook_digests.expires_at <= now()
        returning 1 as "claimed!""#,
        tenant,
        claim.as_slice(),
        new.topic,
        replay_window_hours(&new.topic),
    )
    .fetch_optional(tx.conn())
    .await?;
    if claimed.is_none() {
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
        new.body_sha256.as_slice(),
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
