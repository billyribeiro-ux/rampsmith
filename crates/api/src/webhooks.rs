//! The webhook listener: its own router on `WEBHOOK_BIND_ADDR`, serving only `/webhooks/*`
//! (PLAN §14, §18; ADR-080, ADR-182).
//!
//! The public webhook host reaches this listener and nothing else of the api, so the private
//! API's routes (`/readyz`, `/openapi.json`, `/v1/...`) do not exist here: every other path
//! answers 404.
//!
//! A Shopify delivery is handled in this order, cheapest and least trusting first:
//!
//! 1. a permit from a large pool for connections that have not proved anything yet (no permit:
//!    503, and the body is never read). It protects memory and sockets, never the database;
//! 2. the `X-Shopify-Hmac-SHA256` header must be present and base64 (401 otherwise);
//! 3. the body is read up to a size limit (413 above it) and under a one second deadline (503
//!    above it, so a client that stalls cannot hold a permit: lane A audit M1);
//! 4. HMAC-SHA256 of the raw body under the app's client secret, compared in constant time
//!    (401 on mismatch);
//! 5. only a verified delivery takes a permit of the small pool that protects the database (no
//!    permit: 503). Then the topic and shop headers are looked at, the shop found, the event
//!    stored once (deduplicated on the delivery id and on the body's SHA-256, integration
//!    audit M1) and `webhook.process@1` enqueued in the same transaction;
//! 6. 200 with no body. Everything slow happens later, in `ctl`.
//!
//! `POST /webhooks/github` follows the same order with GitHub's `X-Hub-Signature-256` (a
//! `sha256=` HMAC of the raw body under the App's webhook secret, which the `github` crate
//! checks in constant time against the current and, during a rotation, the previous secret). A
//! verified delivery is stored under its delivery id *and* the SHA-256 of its body, because the
//! delivery and event headers are not covered by the signature and a captured body can be
//! replayed under new ones (integration audit M1); the installation it names must be linked to
//! a store; and the job reads the installation's state from the GitHub API, never from the body
//! (ADR-292). While `CODE_FIX_CHANNEL_ENABLED` is off the route acknowledges and drops
//! everything without reading the body (ADR-290).
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
use contracts::{GithubProcessEvent, WebhookProcess};
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
/// Verified deliveries stored at the same time; more are answered 503 and retried by Shopify.
/// This pool protects the database, so only a delivery whose signature checked out takes a permit.
pub const MAX_IN_FLIGHT: usize = 64;
/// Connections whose body is being read or verified at the same time. Larger than
/// [`MAX_IN_FLIGHT`] and held for at most [`BODY_DEADLINE`] plus the HMAC, so unsigned traffic
/// cannot starve verified deliveries.
pub const MAX_UNVERIFIED: usize = 512;
/// The longest the listener waits for a delivery's whole body. Shopify's own total timeout is
/// five seconds and its bodies are a few kilobytes.
pub const BODY_DEADLINE: Duration = Duration::from_secs(1);
/// Largest GitHub body read. GitHub allows up to 25 MB, but the events Rampsmith stores
/// (installation changes, pull request activity, pushes) are far smaller; a push of thousands
/// of commits that exceeds this is answered 413 and never stored.
pub const MAX_GITHUB_BODY_BYTES: usize = 1024 * 1024;
/// Shopify gives up on a delivery after five seconds in total.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

/// What the listener needs.
#[derive(Clone)]
pub struct WebhookState {
    db: Db,
    secret: Arc<SecretString>,
    permits: Arc<Semaphore>,
    unverified: Arc<Semaphore>,
    github: Option<Arc<github::WebhookVerifier>>,
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
            unverified: Arc::new(Semaphore::new(MAX_UNVERIFIED)),
            github: None,
        }
    }

    /// Accepts GitHub deliveries signed with this verifier (the channel is switched on). Without
    /// it `/webhooks/github` acknowledges and drops.
    #[must_use]
    pub fn with_github(mut self, verifier: github::WebhookVerifier) -> Self {
        self.github = Some(Arc::new(verifier));
        self
    }

    /// Replaces the number of verified deliveries stored at once, for tests.
    #[must_use]
    pub fn with_max_in_flight(mut self, permits: usize) -> Self {
        self.permits = Arc::new(Semaphore::new(permits));
        self
    }

    /// Replaces the number of unverified connections read at once, for tests.
    #[must_use]
    pub fn with_max_unverified(mut self, permits: usize) -> Self {
        self.unverified = Arc::new(Semaphore::new(permits));
        self
    }
}

/// The listener's router: `POST /webhooks/shopify`, `POST /webhooks/github` and a 404 for
/// everything else.
pub fn router(state: WebhookState) -> Router {
    let router = Router::new()
        .route("/webhooks/shopify", post(shopify))
        .route("/webhooks/github", post(github_hook))
        .with_state(state);
    with_middleware(
        router,
        Limits {
            request_timeout: REQUEST_TIMEOUT,
            // The Shopify handler enforces its own, smaller limit while reading.
            body_bytes: MAX_GITHUB_BODY_BYTES,
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
/// a body that is not shaped like its topic is refused (lane A audit H1, ADR-085). Each shape
/// requires its own fields, denies the keys that mark another topic's payload and tolerates
/// anything else, because Shopify adds fields to payloads without a version (ADR-269):
///
/// - `shop/redact`: `shop_id` and `shop_domain`, and none of the customer keys or the shop
///   object's `myshopify_domain`;
/// - `customers/data_request`: `shop_id`, `shop_domain`, a `customer` object, a `data_request`
///   object and an `orders_requested` array, and no `orders_to_redact`;
/// - `customers/redact`: `shop_id`, `shop_domain`, a `customer` object and an `orders_to_redact`
///   array, and neither `data_request` nor `orders_requested`;
/// - `app/uninstalled`, `shop/update`: the shop object, which names `myshopify_domain` (and
///   never the compliance payloads' `shop_domain`).
///
/// The payloads are those of Shopify's "Privacy law compliance" page and the shop webhook
/// reference, read on 22 Oct 2026.
fn body_fits_topic(topic: &str, body: &serde_json::Value) -> bool {
    use serde_json::Value;
    let Some(map) = body.as_object() else {
        return false;
    };
    let has = |key: &str, ok: fn(&Value) -> bool| map.get(key).is_some_and(ok);
    let lacks = |keys: &[&str]| keys.iter().all(|key| !map.contains_key(*key));
    let compliance_envelope = has("shop_id", Value::is_u64) && has("shop_domain", Value::is_string);
    match topic {
        "shop/redact" => {
            compliance_envelope
                && lacks(&[
                    "customer",
                    "data_request",
                    "orders_requested",
                    "orders_to_redact",
                    "myshopify_domain",
                ])
        }
        "customers/data_request" => {
            compliance_envelope
                && has("customer", Value::is_object)
                && has("data_request", Value::is_object)
                && has("orders_requested", Value::is_array)
                && lacks(&["orders_to_redact", "myshopify_domain"])
        }
        "customers/redact" => {
            compliance_envelope
                && has("customer", Value::is_object)
                && has("orders_to_redact", Value::is_array)
                && lacks(&["data_request", "orders_requested", "myshopify_domain"])
        }
        "app/uninstalled" | "shop/update" => {
            has("myshopify_domain", Value::is_string) && !map.contains_key("shop_domain")
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

    // 1. Concurrency of unverified reads, before anything is read.
    let Ok(unverified) = state.unverified.try_acquire() else {
        warn!("webhook listener is full of unverified reads");
        return Err(ApiError::new(ProblemCode::Unavailable)
            .detail("Too many webhooks are being read; Shopify will retry."));
    };

    // 2. The signature header must be there before the body is read.
    let presented = header(&parts.headers, SIGNATURE)
        .and_then(|v| STANDARD.decode(v.trim()).ok())
        .ok_or_else(|| {
            warn!(reason = "missing_or_malformed", "webhook signature refused");
            unauthorized()
        })?;

    // 3. The body, up to the limit and the deadline.
    let read = tokio::time::timeout(
        BODY_DEADLINE,
        body::to_bytes(Body::new(request_body), MAX_BODY_BYTES),
    )
    .await;
    let body = match read {
        Ok(Ok(body)) => body,
        Ok(Err(_)) => return Err(ApiError::new(ProblemCode::PayloadTooLarge)),
        Err(_) => {
            warn!(reason = "slow_body", "webhook body not delivered in time");
            return Err(ApiError::new(ProblemCode::Unavailable)
                .detail("The body did not arrive in time; Shopify will retry."));
        }
    };

    // 4. Verify over the raw bytes.
    if !signature_matches(&state.secret, &body, &presented) {
        warn!(reason = "mismatch", "webhook signature refused");
        return Err(unauthorized());
    }
    drop(unverified);

    // 5. Trusted from here on: now a permit of the pool that protects the database.
    let Ok(_permit) = state.permits.try_acquire() else {
        warn!("webhook listener is full");
        return Err(ApiError::new(ProblemCode::Unavailable)
            .detail("Too many webhooks are being handled; Shopify will retry."));
    };
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
        // An error, not a warning: a genuine delivery that Shopify shaped differently (a
        // changed payload) or an attacker's relabelled body. Either needs a person.
        error!(
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
                    .idempotency_key(format!("{}:{event_id}", WebhookProcess::QUEUE))
                    .max_attempts(WebhookProcess::MAX_ATTEMPTS),
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

// ---------------------------------------------------------------------------------------------
// GitHub

const GITHUB_SIGNATURE: &str = "x-hub-signature-256";
const GITHUB_DELIVERY: &str = "x-github-delivery";
const GITHUB_EVENT: &str = "x-github-event";

/// The events Rampsmith stores and processes (the App's manifest subscribes to the first
/// two of the pull request and push events, and GitHub sends installation events always).
/// Any other event, `ping` included, is acknowledged and dropped.
pub const ACCEPTED_GITHUB_EVENTS: [&str; 4] = [
    "installation",
    "installation_repositories",
    "pull_request",
    "push",
];

async fn github_hook(
    State(state): State<WebhookState>,
    request: Request,
) -> Result<StatusCode, ApiError> {
    let Some(verifier) = state.github.clone() else {
        debug!("GitHub webhook while the channel is off; acknowledged");
        return Ok(StatusCode::OK);
    };
    let (parts, request_body) = request.into_parts();
    let Ok(unverified) = state.unverified.try_acquire() else {
        warn!("webhook listener is full of unverified reads");
        return Err(ApiError::new(ProblemCode::Unavailable)
            .detail("Too many webhooks are being read; GitHub will retry."));
    };
    // The header must look like a signature before the body is read.
    let signature = parts
        .headers
        .get(GITHUB_SIGNATURE)
        .filter(|v| github::signature_header_is_well_formed(v.as_bytes()))
        .ok_or_else(|| {
            warn!(
                reason = "missing_or_malformed",
                "GitHub webhook signature refused"
            );
            unauthorized()
        })?;
    let read = tokio::time::timeout(
        BODY_DEADLINE,
        body::to_bytes(Body::new(request_body), MAX_GITHUB_BODY_BYTES),
    )
    .await;
    let body = match read {
        Ok(Ok(body)) => body,
        Ok(Err(_)) => return Err(ApiError::new(ProblemCode::PayloadTooLarge)),
        Err(_) => {
            warn!(
                reason = "slow_body",
                "GitHub webhook body not delivered in time"
            );
            return Err(ApiError::new(ProblemCode::Unavailable)
                .detail("The body did not arrive in time; GitHub will retry."));
        }
    };
    if verifier.verify(signature.as_bytes(), &body).is_err() {
        warn!(reason = "mismatch", "GitHub webhook signature refused");
        return Err(unauthorized());
    }
    drop(unverified);
    let Ok(_permit) = state.permits.try_acquire() else {
        warn!("webhook listener is full");
        return Err(ApiError::new(ProblemCode::Unavailable)
            .detail("Too many webhooks are being handled; GitHub will retry."));
    };
    store_github(&state, &parts.headers, &body).await
}

fn github_id_is_well_formed(id: &str) -> bool {
    (1..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// After the signature checked out: parse, find the store, store once, enqueue.
async fn store_github(
    state: &WebhookState,
    headers: &HeaderMap,
    body: &[u8],
) -> Result<StatusCode, ApiError> {
    let name = header(headers, GITHUB_EVENT)
        .filter(|n| {
            (1..=64).contains(&n.len()) && n.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
        })
        .ok_or_else(|| {
            ApiError::new(ProblemCode::BadRequest).detail("X-GitHub-Event is missing or malformed.")
        })?;
    let delivery = header(headers, GITHUB_DELIVERY)
        .map(str::trim)
        .filter(|id| github_id_is_well_formed(id))
        .ok_or_else(|| {
            ApiError::new(ProblemCode::BadRequest)
                .detail("X-GitHub-Delivery is missing or malformed.")
        })?;
    if !ACCEPTED_GITHUB_EVENTS.contains(&name) {
        debug!(event = name, "GitHub event not handled; acknowledged");
        return Ok(StatusCode::OK);
    }
    if let Some(content_type) = header(headers, "content-type") {
        let media = content_type.split(';').next().unwrap_or("").trim();
        if !media.eq_ignore_ascii_case("application/json") {
            return Err(ApiError::new(ProblemCode::BadRequest)
                .detail("GitHub deliveries must be application/json."));
        }
    }
    // The payload must be the documented shape for its event: the event header is not signed.
    let parsed = github::Event::parse(name, body).map_err(|_| {
        ApiError::new(ProblemCode::BadRequest).detail("The body does not match the X-GitHub-Event.")
    })?;
    let json: serde_json::Value = serde_json::from_slice(body)
        .map_err(|_| ApiError::new(ProblemCode::BadRequest).detail("The body is not JSON."))?;
    let Some(installation) = parsed
        .installation_id()
        .and_then(|i| i64::try_from(i.get()).ok())
    else {
        debug!(
            event = name,
            "GitHub event names no installation; acknowledged"
        );
        return Ok(StatusCode::OK);
    };
    let Some(owner) = state.db.github_installation(installation).await? else {
        // Not linked to a store (yet): the callback reads the API itself. Acknowledging stops
        // GitHub's failure counter.
        info!(
            event = name,
            "GitHub event for an unlinked installation acknowledged"
        );
        return Ok(StatusCode::OK);
    };
    let digest: [u8; 32] = Sha256::digest(body).into();
    let mut tx = state.db.tenant(owner.tenant).await?;
    let recorded = db::repo::github::record_event(
        &mut tx,
        &db::repo::github::NewEvent {
            delivery_id: delivery.to_owned(),
            event: name.to_owned(),
            installation_id: installation,
            repository_id: parsed
                .repository_id()
                .and_then(|r| i64::try_from(r.get()).ok()),
            body: json,
            body_sha256: digest,
        },
    )
    .await?;
    match recorded {
        db::repo::github::Recorded::Stored(event_id) => {
            let payload = serde_json::to_value(GithubProcessEvent { event_id }).map_err(|e| {
                error!(error = %e, "could not encode the GitHub event job");
                ApiError::new(ProblemCode::Internal)
            })?;
            db::repo::jobs::enqueue(
                &mut tx,
                NewJob::new(
                    GithubProcessEvent::QUEUE,
                    GithubProcessEvent::SCHEMA,
                    payload,
                )
                .idempotency_key(format!("{}:{event_id}", GithubProcessEvent::QUEUE))
                .max_attempts(GithubProcessEvent::MAX_ATTEMPTS),
            )
            .await?;
            tx.commit().await?;
            info!(event = name, %event_id, "GitHub event stored");
        }
        db::repo::github::Recorded::DuplicateDelivery
        | db::repo::github::Recorded::DuplicateBody => {
            tx.rollback().await?;
            info!(
                event = name,
                ?recorded,
                "GitHub event repeated; acknowledged"
            );
        }
    }
    Ok(StatusCode::OK)
}
