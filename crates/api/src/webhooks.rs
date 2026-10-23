//! The webhook listener: its own router on `WEBHOOK_BIND_ADDR`, serving only `/webhooks/*`
//! (PLAN §14, §18; ADR-080, ADR-182).
//!
//! The public webhook host reaches this listener and nothing else of the api, so the private
//! API's routes (`/readyz`, `/openapi.json`, `/v1/...`) do not exist here: every other path
//! answers 404.
//!
//! A Shopify delivery is handled in this order, cheapest and least trusting first:
//!
//! 1. a permit from a fixed pool (no permit: 503, and the body is never read);
//! 2. the `X-Shopify-Hmac-SHA256` header must be present and base64 (401 otherwise);
//! 3. the body is read up to a size limit (413 above it);
//! 4. HMAC-SHA256 of the raw body under the app's client secret, compared in constant time
//!    (401 on mismatch);
//! 5. only then are the topic and shop headers looked at, the shop found, the event stored
//!    once (deduplicated on the delivery id and on the body's SHA-256, integration audit M1)
//!    and `webhook.process@1` enqueued in the same transaction;
//! 6. 200 with no body. Everything slow happens later, in `ctl`.
//!
//! Sources, read on shopify.dev on 22 Oct 2026: "Verify webhook deliveries" (the signature is
//! the base64 HMAC-SHA256 of the raw body under the app's client secret, in
//! `X-Shopify-Hmac-SHA256`), "Deliver webhooks through HTTPS" (one-second connect and
//! five-second total timeout; a non-2xx counts as an error and is retried eight times over
//! four hours), "Webhook delivery headers" (`X-Shopify-Topic`, `X-Shopify-Shop-Domain`,
//! `X-Shopify-Webhook-Id`) and "Privacy law compliance" (401 for an invalid HMAC).

use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::{self, Body};
use axum::extract::{Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use contracts::WebhookProcess;
use db::Db;
use db::repo::webhooks::{self, NewWebhook, Recorded};
use hmac::{Hmac, KeyInit, Mac};
use http_kit::{ApiError, Limits, ProblemCode, with_middleware};
use queue::NewJob;
use secrecy::{ExposeSecret, SecretString};
use sha2::{Digest, Sha256};
use shopify::ShopDomain;
use tokio::sync::Semaphore;
use tracing::{debug, error, info, warn};

/// The signature header (`X-Shopify-Hmac-SHA256`; header names are case-insensitive).
const SIGNATURE: &str = "x-shopify-hmac-sha256";
const TOPIC: &str = "x-shopify-topic";
const SHOP_DOMAIN: &str = "x-shopify-shop-domain";
const WEBHOOK_ID: &str = "x-shopify-webhook-id";

/// The topics Rampsmith stores and processes. Any other topic is acknowledged and dropped, so
/// Shopify does not count it as a failure.
pub const ACCEPTED_TOPICS: [&str; 5] = [
    "app/uninstalled",
    "customers/data_request",
    "customers/redact",
    "shop/redact",
    "shop/update",
];

/// Largest body read. App Store webhooks of the accepted topics are a few kilobytes.
pub const MAX_BODY_BYTES: usize = 256 * 1024;
/// Deliveries handled at the same time; more are answered 503 and retried by Shopify.
pub const MAX_IN_FLIGHT: usize = 64;
/// Shopify gives up on a delivery after five seconds in total.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

/// What the listener needs.
#[derive(Clone)]
pub struct WebhookState {
    db: Db,
    secret: Arc<SecretString>,
    permits: Arc<Semaphore>,
}

impl std::fmt::Debug for WebhookState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WebhookState").finish_non_exhaustive()
    }
}

impl WebhookState {
    /// State for a listener that verifies with the app's client secret.
    #[must_use]
    pub fn new(db: Db, client_secret: SecretString) -> Self {
        Self {
            db,
            secret: Arc::new(client_secret),
            permits: Arc::new(Semaphore::new(MAX_IN_FLIGHT)),
        }
    }

    /// Replaces the number of deliveries handled at once, for tests.
    #[must_use]
    pub fn with_max_in_flight(mut self, permits: usize) -> Self {
        self.permits = Arc::new(Semaphore::new(permits));
        self
    }
}

/// The listener's router: `POST /webhooks/shopify` and a 404 for everything else.
pub fn router(state: WebhookState) -> Router {
    let router = Router::new()
        .route("/webhooks/shopify", post(shopify))
        .with_state(state);
    with_middleware(
        router,
        Limits {
            request_timeout: REQUEST_TIMEOUT,
            body_bytes: MAX_BODY_BYTES,
        },
    )
}

/// The base64 HMAC-SHA256 of `body` under `secret`, as Shopify sends it. `None` only for a key
/// the MAC rejects, which HMAC never does.
#[must_use]
pub fn sign(secret: &str, body: &[u8]) -> Option<String> {
    let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(secret.as_bytes()).ok()?;
    mac.update(body);
    Some(STANDARD.encode(mac.finalize().into_bytes()))
}

fn signature_matches(secret: &SecretString, body: &[u8], presented: &[u8]) -> bool {
    let Ok(mut mac) = <Hmac<Sha256> as KeyInit>::new_from_slice(secret.expose_secret().as_bytes())
    else {
        return false;
    };
    mac.update(body);
    // `verify_slice` compares in constant time.
    mac.verify_slice(presented).is_ok()
}

fn unauthorized() -> ApiError {
    ApiError::new(ProblemCode::Unauthenticated)
        .detail("The webhook signature is missing or invalid.")
}

fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}

fn topic_is_well_formed(topic: &str) -> bool {
    // The same shape the `webhook_events.topic` check accepts.
    topic.len() <= 100
        && topic.contains('/')
        && topic.split('/').all(|part| {
            !part.is_empty() && part.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
        })
}

/// Whether `body` has the shape Shopify documents for `topic`. The topic header is not covered
/// by the signature, so a signed body captured under one topic could be resent under another:
/// a body that is not shaped like its topic is refused (lane A audit H1, ADR-085).
///
/// - `shop/redact`: exactly `{shop_id, shop_domain}`;
/// - `customers/data_request`, `customers/redact`: `shop_id`, `shop_domain` and a `customer`
///   object;
/// - `app/uninstalled`, `shop/update`: the shop object, which names `myshopify_domain` (and
///   never the compliance payloads' `shop_domain`).
fn body_fits_topic(topic: &str, body: &serde_json::Value) -> bool {
    let Some(map) = body.as_object() else {
        return false;
    };
    match topic {
        "shop/redact" => {
            map.len() == 2
                && map.get("shop_id").is_some_and(serde_json::Value::is_u64)
                && map
                    .get("shop_domain")
                    .is_some_and(serde_json::Value::is_string)
        }
        "customers/data_request" | "customers/redact" => {
            map.get("shop_id").is_some_and(serde_json::Value::is_u64)
                && map
                    .get("shop_domain")
                    .is_some_and(serde_json::Value::is_string)
                && map
                    .get("customer")
                    .is_some_and(serde_json::Value::is_object)
        }
        "app/uninstalled" | "shop/update" => {
            map.get("myshopify_domain")
                .is_some_and(serde_json::Value::is_string)
                && !map.contains_key("shop_domain")
        }
        _ => false,
    }
}

fn delivery_id_is_well_formed(id: &str) -> bool {
    (1..=200).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_graphic())
}

async fn shopify(
    State(state): State<WebhookState>,
    request: Request,
) -> Result<StatusCode, ApiError> {
    let (parts, request_body) = request.into_parts();

    // 1. Concurrency, before anything is read.
    let Ok(_permit) = state.permits.try_acquire() else {
        warn!("webhook listener is full");
        return Err(ApiError::new(ProblemCode::Unavailable)
            .detail("Too many webhooks are being handled; Shopify will retry."));
    };

    // 2. The signature header must be there before the body is read.
    let presented = header(&parts.headers, SIGNATURE)
        .and_then(|v| STANDARD.decode(v.trim()).ok())
        .ok_or_else(|| {
            warn!(reason = "missing_or_malformed", "webhook signature refused");
            unauthorized()
        })?;

    // 3. The body, up to the limit.
    let body = body::to_bytes(Body::new(request_body), MAX_BODY_BYTES)
        .await
        .map_err(|_| ApiError::new(ProblemCode::PayloadTooLarge))?;

    // 4. Verify over the raw bytes.
    if !signature_matches(&state.secret, &body, &presented) {
        warn!(reason = "mismatch", "webhook signature refused");
        return Err(unauthorized());
    }

    store_verified(&state, &parts.headers, &body).await
}

/// Whether a `shop/redact` body names the shop by the Shopify id stored for it. The id is
/// recorded by the first scan; before that nothing can be compared and the worker's grant
/// check is the only guard.
async fn redact_names_this_shop(
    tx: &mut db::TenantTx,
    shop: domain::ShopId,
    body: &serde_json::Value,
) -> Result<bool, db::DbError> {
    let Some(stored) = db::repo::shopify::shop_gid(tx, shop).await? else {
        return Ok(true);
    };
    let named = body.get("shop_id").and_then(serde_json::Value::as_u64);
    Ok(named
        .map(|id| format!("gid://shopify/Shop/{id}"))
        .is_some_and(|gid| gid == stored))
}

/// Steps 5 and 6: everything after the signature checked out.
async fn store_verified(
    state: &WebhookState,
    headers: &HeaderMap,
    body: &[u8],
) -> Result<StatusCode, ApiError> {
    let topic = header(headers, TOPIC).ok_or_else(|| {
        ApiError::new(ProblemCode::BadRequest).detail("X-Shopify-Topic is missing.")
    })?;
    if !topic_is_well_formed(topic) {
        return Err(ApiError::new(ProblemCode::BadRequest).detail("X-Shopify-Topic is malformed."));
    }
    if !ACCEPTED_TOPICS.contains(&topic) {
        debug!(topic, "webhook topic not handled; acknowledged");
        return Ok(StatusCode::OK);
    }
    let shop = header(headers, SHOP_DOMAIN)
        .and_then(|v| ShopDomain::parse(v.trim()).ok())
        .ok_or_else(|| {
            ApiError::new(ProblemCode::BadRequest)
                .detail("X-Shopify-Shop-Domain is missing or malformed.")
        })?;
    let delivery = header(headers, WEBHOOK_ID)
        .map(str::trim)
        .filter(|id| delivery_id_is_well_formed(id))
        .ok_or_else(|| {
            ApiError::new(ProblemCode::BadRequest)
                .detail("X-Shopify-Webhook-Id is missing or malformed.")
        })?;
    let json: serde_json::Value = serde_json::from_slice(body)
        .map_err(|_| ApiError::new(ProblemCode::BadRequest).detail("The body is not JSON."))?;
    // The shop header is unsigned and the body is signed: they must name the same shop, or a
    // captured delivery of one shop could be filed under another (and, for `shop/redact`,
    // delete the other's data).
    if webhooks::body_shop_domain(&json)
        .map(str::to_ascii_lowercase)
        .as_deref()
        != Some(shop.as_str())
    {
        warn!(
            reason = "shop_mismatch",
            "webhook refused: the header and the body name different shops"
        );
        return Err(unauthorized());
    }
    if !body_fits_topic(topic, &json) {
        warn!(
            topic,
            reason = "body_not_for_topic",
            "webhook refused: the body is not shaped like its topic"
        );
        return Err(ApiError::new(ProblemCode::BadRequest)
            .detail("The body does not match the X-Shopify-Topic."));
    }
    let digest: [u8; 32] = Sha256::digest(body).into();

    let Some(shop_ref) = state.db.shop_by_domain(shop.as_str()).await? else {
        // A shop that never installed, or whose row is gone. Nothing to do; acknowledging
        // stops Shopify from retrying and from deleting the subscription.
        info!(topic, "webhook for an unknown shop acknowledged");
        return Ok(StatusCode::OK);
    };

    let mut tx = state.db.tenant(shop_ref.tenant).await?;
    if topic == "shop/redact" && !redact_names_this_shop(&mut tx, shop_ref.shop, &json).await? {
        warn!(
            reason = "shop_id_mismatch",
            "webhook refused: shop/redact names another shop id than the stored one"
        );
        tx.rollback().await?;
        return Err(unauthorized());
    }
    let recorded = webhooks::record(
        &mut tx,
        &NewWebhook {
            shop_id: shop_ref.shop,
            external_id: delivery.to_owned(),
            topic: topic.to_owned(),
            body: json,
            body_sha256: digest,
        },
    )
    .await?;
    match recorded {
        Recorded::Stored(event_id) => {
            let payload = serde_json::to_value(WebhookProcess { event_id }).map_err(|e| {
                error!(error = %e, "could not encode the webhook job");
                ApiError::new(ProblemCode::Internal)
            })?;
            db::repo::jobs::enqueue(
                &mut tx,
                NewJob::new(WebhookProcess::QUEUE, WebhookProcess::SCHEMA, payload)
                    .idempotency_key(format!("{}:{event_id}", WebhookProcess::QUEUE)),
            )
            .await?;
            tx.commit().await?;
            info!(topic, %event_id, shop = %shop_ref.shop, "webhook stored");
        }
        Recorded::DuplicateDelivery | Recorded::DuplicateBody => {
            tx.rollback().await?;
            info!(topic, shop = %shop_ref.shop, ?recorded, "webhook repeated; acknowledged");
        }
    }
    Ok(StatusCode::OK)
}
