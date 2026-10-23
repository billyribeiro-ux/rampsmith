//! Signed email links and the choices they carry (ADR-274, ADR-275): the unsubscribe link of one
//! message category, the email preferences link, the RFC 8058 one-click POST, and the same
//! choices from the App Home settings.
//!
//! The engine mints a link when it sends a message (`packages/email/src/link-token.ts`); this
//! module only reads them. A token is `base64url(body || HMAC-SHA-256)` under a key of
//! `EMAIL_LINK_KEYS`; the layout is documented there and pinned to this reader by
//! `packages/email/test/fixtures/link-vectors.json`. A token names a tenant, a shop, a category
//! and a hash of the address, and is good for 180 days. It is checked before anything else
//! happens, in constant time, and it is the only credential: the pages and endpoints that take
//! it have no session and set no cookie.
//!
//! The private API (`/v1/email/links/...`) serves the web app's `/email/unsubscribe` and
//! `/email/preferences` pages. The one-click POST that mail providers send goes to the public
//! webhook listener (`/webhooks/email/unsubscribe`), because SvelteKit refuses a form POST that
//! carries no `Origin` header, which is how those requests arrive.

use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::{Query, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD_NO_PAD, URL_SAFE_NO_PAD};
use db::Db;
use db::repo::email::{self, OptOutCategory};
use db::repo::{audit, shopify as shops};
use domain::{ActorKind, ShopId, TenantId};
use hmac::{Hmac, KeyInit, Mac};
use http_kit::{ApiError, Limits, ProblemCode, with_middleware};
use secrecy::{ExposeSecret, SecretBox};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::Sha256;
use thiserror::Error;
use time::OffsetDateTime;
use tracing::{info, warn};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::AppState;
use crate::r1::Body;

/// Prefix of every MAC, so a key used for another purpose can never sign a link.
const DOMAIN: &[u8] = b"rampsmith/email-link/v1\0";
const VERSION: u8 = 1;
const FIXED: usize = 72;
const MAC_LEN: usize = 32;
/// The longest token text read; a real one is about 150 characters.
const MAX_TOKEN_CHARS: usize = 400;
const MIN_KEY_BYTES: usize = 32;

/// The categories the preferences screens list: the ones tenant mail uses today. Marketing mail
/// to a merchant does not exist in R1, so there is nothing for a merchant to switch on or off
/// (a marketing unsubscribe link still works).
pub const PREFERENCE_CATEGORIES: [OptOutCategory; 1] = [OptOutCategory::Notification];

/// What a link may be used for. A token for one purpose is refused for the other.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Purpose {
    /// Switch off one category.
    Unsubscribe,
    /// See and change every category.
    Preferences,
}

/// Why a token was not accepted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum Refusal {
    /// Not a token: wrong length, characters or layout.
    #[error("the link is malformed")]
    Malformed,
    /// Signed with a key this ring no longer holds.
    #[error("the link was signed with an unknown key")]
    UnknownKey,
    /// The MAC does not match the contents.
    #[error("the link's signature does not match")]
    BadSignature,
    /// Past its expiry.
    #[error("the link has expired")]
    Expired,
}

/// What a verified token says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Claims {
    /// What the link is for.
    pub purpose: Purpose,
    /// The category an unsubscribe link switches off; `None` for a preferences link.
    pub category: Option<OptOutCategory>,
    /// When the link stops working, seconds since the Unix epoch.
    pub expires_at: u32,
    /// The tenant whose mail it is.
    pub tenant: TenantId,
    /// The shop the mail was about.
    pub shop: ShopId,
    /// `email_address_hash(tenant, address)`.
    pub address_hash: [u8; 32],
}

/// A key ring problem; the message never repeats a key.
#[derive(Debug, Error, PartialEq, Eq)]
#[error("{0}")]
pub struct KeyError(&'static str);

/// `EMAIL_LINK_KEYS`: `id:base64key[,id:base64key…]`, newest first, each key 32 bytes or more.
pub struct LinkKeys {
    keys: Vec<(String, SecretBox<[u8]>)>,
}

impl std::fmt::Debug for LinkKeys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LinkKeys")
            .field(
                "ids",
                &self
                    .keys
                    .iter()
                    .map(|(id, _)| id.as_str())
                    .collect::<Vec<_>>(),
            )
            .finish()
    }
}

impl LinkKeys {
    /// Parses the ring.
    pub fn parse(spec: &str) -> Result<Self, KeyError> {
        let mut keys: Vec<(String, SecretBox<[u8]>)> = Vec::new();
        for entry in spec.split(',') {
            let (id, encoded) = entry
                .trim()
                .split_once(':')
                .ok_or(KeyError("each entry must look like id:base64key"))?;
            let (id, encoded) = (id.trim(), encoded.trim());
            if id.is_empty()
                || id.len() > 16
                || !id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            {
                return Err(KeyError(
                    "a key id is 1 to 16 letters, digits, hyphens or underscores",
                ));
            }
            if keys.iter().any(|(known, _)| known == id) {
                return Err(KeyError("a key id is listed twice"));
            }
            let bytes = decode_key(encoded).ok_or(KeyError("a key is not base64"))?;
            if bytes.len() < MIN_KEY_BYTES {
                return Err(KeyError("a key is shorter than 32 bytes"));
            }
            keys.push((id.to_owned(), SecretBox::new(bytes.into_boxed_slice())));
        }
        if keys.is_empty() {
            return Err(KeyError("the ring is empty"));
        }
        Ok(Self { keys })
    }

    /// The id of the newest key.
    #[must_use]
    pub fn active_id(&self) -> &str {
        self.keys.first().map_or("", |(id, _)| id.as_str())
    }

    fn mac(&self, id: &str) -> Option<Hmac<Sha256>> {
        let (_, key) = self.keys.iter().find(|(known, _)| known == id)?;
        let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(key.expose_secret()).ok()?;
        mac.update(DOMAIN);
        Some(mac)
    }

    /// Reads and checks `token` as of `now` (seconds since the epoch). The signature is checked
    /// before any claim is trusted, and the expiry last.
    pub fn verify(&self, token: &str, now: i64) -> Result<Claims, Refusal> {
        if token.len() > MAX_TOKEN_CHARS
            || !token
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err(Refusal::Malformed);
        }
        let raw = URL_SAFE_NO_PAD
            .decode(token)
            .map_err(|_| Refusal::Malformed)?;
        if raw.len() < FIXED + 1 + MAC_LEN || raw.first() != Some(&VERSION) {
            return Err(Refusal::Malformed);
        }
        let id_len = usize::from(raw.get(71).copied().unwrap_or(0));
        let body_end = FIXED + id_len;
        if !(1..=16).contains(&id_len) || raw.len() != body_end + MAC_LEN {
            return Err(Refusal::Malformed);
        }
        let (body, presented) = raw.split_at(body_end);
        let id = std::str::from_utf8(raw.get(FIXED..body_end).unwrap_or_default())
            .map_err(|_| Refusal::Malformed)?;
        let mut mac = self.mac(id).ok_or(Refusal::UnknownKey)?;
        mac.update(body);
        // `verify_slice` compares in constant time.
        mac.verify_slice(presented)
            .map_err(|_| Refusal::BadSignature)?;

        let purpose = match raw.get(1) {
            Some(1) => Purpose::Unsubscribe,
            Some(2) => Purpose::Preferences,
            _ => return Err(Refusal::Malformed),
        };
        let category = match raw.get(2) {
            Some(0) => None,
            Some(1) => Some(OptOutCategory::Notification),
            Some(2) => Some(OptOutCategory::Marketing),
            _ => return Err(Refusal::Malformed),
        };
        if (purpose == Purpose::Unsubscribe) != category.is_some() {
            return Err(Refusal::Malformed);
        }
        let expires_at = u32::from_be_bytes(array(&raw, 3).ok_or(Refusal::Malformed)?);
        if now >= i64::from(expires_at) {
            return Err(Refusal::Expired);
        }
        Ok(Claims {
            purpose,
            category,
            expires_at,
            tenant: TenantId::from_uuid(Uuid::from_bytes(
                array(&raw, 7).ok_or(Refusal::Malformed)?,
            )),
            shop: ShopId::from_uuid(Uuid::from_bytes(array(&raw, 23).ok_or(Refusal::Malformed)?)),
            address_hash: array(&raw, 39).ok_or(Refusal::Malformed)?,
        })
    }

    /// Mints a token under the newest key, in the layout `packages/email` writes. The api never
    /// sends mail; this is for tests, and for checking the two implementations against the same
    /// bytes.
    #[must_use]
    pub fn mint(&self, claims: &Claims) -> String {
        let id = self.active_id();
        let mut body = Vec::with_capacity(FIXED + id.len());
        body.push(VERSION);
        body.push(match claims.purpose {
            Purpose::Unsubscribe => 1,
            Purpose::Preferences => 2,
        });
        body.push(match claims.category {
            None => 0,
            Some(OptOutCategory::Notification) => 1,
            Some(OptOutCategory::Marketing) => 2,
        });
        body.extend_from_slice(&claims.expires_at.to_be_bytes());
        body.extend_from_slice(claims.tenant.as_uuid().as_bytes());
        body.extend_from_slice(claims.shop.as_uuid().as_bytes());
        body.extend_from_slice(&claims.address_hash);
        body.push(u8::try_from(id.len()).unwrap_or(0));
        body.extend_from_slice(id.as_bytes());
        let mut out = body.clone();
        if let Some(mut mac) = self.mac(id) {
            mac.update(&body);
            out.extend_from_slice(&mac.finalize().into_bytes());
        }
        URL_SAFE_NO_PAD.encode(out)
    }
}

/// `N` bytes of `raw` from `at`.
fn array<const N: usize>(raw: &[u8], at: usize) -> Option<[u8; N]> {
    raw.get(at..at + N)?.try_into().ok()
}

fn decode_key(encoded: &str) -> Option<Vec<u8>> {
    // Standard or URL-safe alphabet, padded or not, as Node's `Buffer.from(..., 'base64')` reads it.
    let standard: String = encoded
        .trim_end_matches('=')
        .chars()
        .map(|c| match c {
            '-' => '+',
            '_' => '/',
            other => other,
        })
        .collect();
    STANDARD_NO_PAD.decode(standard).ok()
}

/// What the routes need: the ring and the app's origin, which a bare GET of the one-click
/// address is sent to.
#[derive(Clone, Debug)]
pub struct EmailLinks {
    keys: Arc<LinkKeys>,
    app_origin: String,
}

impl EmailLinks {
    /// `app_origin` is `https://app.rampsmith.com`: scheme, host and optional port.
    #[must_use]
    pub fn new(keys: LinkKeys, app_origin: &str) -> Self {
        Self {
            keys: Arc::new(keys),
            app_origin: app_origin.trim_end_matches('/').to_owned(),
        }
    }

    /// The ring, for tests that mint links.
    #[must_use]
    pub fn keys(&self) -> &LinkKeys {
        &self.keys
    }

    /// The address of the page that handles an unsubscribe link, for `token`.
    fn page(&self, token: &str) -> String {
        format!("{}/email/unsubscribe?t={token}", self.app_origin)
    }
}

// ---------------------------------------------------------------------------------------------
// The private API: the web app's two public pages

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct LinkRequest {
    /// The `t` of the link.
    token: String,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct LinkChange {
    /// The `t` of the link.
    token: String,
    /// `notification` or `marketing`.
    category: String,
    /// `false` switches the category off, `true` back on.
    enabled: bool,
}

/// One category and whether its mail is on.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct EmailCategoryDto {
    /// `notification` or `marketing`.
    category: String,
    /// Whether the address receives this category.
    enabled: bool,
}

/// What a link allows and where each category stands.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct EmailLinkDto {
    /// `ok`, `expired` (past its 180 days) or `invalid` (not one of ours).
    status: String,
    /// `unsubscribe` or `preferences`; null unless `ok`.
    purpose: Option<String>,
    /// The categories this link may change; empty unless `ok`.
    categories: Vec<EmailCategoryDto>,
}

impl EmailLinkDto {
    fn refused(refusal: Refusal) -> Self {
        Self {
            status: match refusal {
                Refusal::Expired => "expired",
                _ => "invalid",
            }
            .to_owned(),
            purpose: None,
            categories: Vec::new(),
        }
    }
}

fn unavailable() -> ApiError {
    ApiError::new(ProblemCode::Unavailable).detail("Email links are not configured.")
}

fn now() -> i64 {
    OffsetDateTime::now_utc().unix_timestamp()
}

/// The categories `claims` may change.
fn allowed(claims: &Claims) -> Vec<OptOutCategory> {
    match claims.category {
        Some(only) => vec![only],
        None => PREFERENCE_CATEGORIES.to_vec(),
    }
}

async fn describe(db: &Db, claims: &Claims) -> Result<EmailLinkDto, ApiError> {
    let mut tx = db.tenant(claims.tenant).await?;
    let off = email::opted_out(&mut tx, &claims.address_hash).await?;
    tx.rollback().await?;
    Ok(EmailLinkDto {
        status: "ok".to_owned(),
        purpose: Some(
            match claims.purpose {
                Purpose::Unsubscribe => "unsubscribe",
                Purpose::Preferences => "preferences",
            }
            .to_owned(),
        ),
        categories: allowed(claims)
            .into_iter()
            .map(|category| EmailCategoryDto {
                category: category.as_str().to_owned(),
                enabled: !off.contains(&category),
            })
            .collect(),
    })
}

/// Reads an email link: what it is for and where each category it covers stands.
#[utoipa::path(
    post,
    path = "/v1/email/links/inspect",
    tag = "email",
    operation_id = "inspectEmailLink",
    request_body = LinkRequest,
    responses(
        (status = OK, description = "The link, or why it is not usable", body = EmailLinkDto),
        (status = SERVICE_UNAVAILABLE, description = "Email links are not configured",
            body = http_kit::Problem, content_type = "application/problem+json")
    )
)]
pub(crate) async fn inspect_link(
    State(state): State<AppState>,
    Body(body): Body<LinkRequest>,
) -> Result<Json<EmailLinkDto>, ApiError> {
    let links = state.email_links().ok_or_else(unavailable)?;
    match links.keys.verify(&body.token, now()) {
        Ok(claims) => Ok(Json(describe(&state.db, &claims).await?)),
        Err(refusal) => Ok(Json(EmailLinkDto::refused(refusal))),
    }
}

/// Switches one category on or off for the address the link was made for.
#[utoipa::path(
    post,
    path = "/v1/email/links/preference",
    tag = "email",
    operation_id = "changeEmailLink",
    request_body = LinkChange,
    responses(
        (status = OK, description = "The link after the change, or why it is not usable",
            body = EmailLinkDto),
        (status = UNPROCESSABLE_ENTITY, description = "The link does not cover that category",
            body = http_kit::Problem, content_type = "application/problem+json"),
        (status = SERVICE_UNAVAILABLE, description = "Email links are not configured",
            body = http_kit::Problem, content_type = "application/problem+json")
    )
)]
pub(crate) async fn change_link(
    State(state): State<AppState>,
    Body(body): Body<LinkChange>,
) -> Result<Json<EmailLinkDto>, ApiError> {
    let links = state.email_links().ok_or_else(unavailable)?;
    let claims = match links.keys.verify(&body.token, now()) {
        Ok(claims) => claims,
        Err(refusal) => return Ok(Json(EmailLinkDto::refused(refusal))),
    };
    let category = OptOutCategory::parse(&body.category)
        .filter(|c| allowed(&claims).contains(c))
        .ok_or_else(|| {
            ApiError::new(ProblemCode::ValidationFailed)
                .detail("This link does not cover that category.")
        })?;
    apply(&state.db, &claims, category, body.enabled, "link").await?;
    Ok(Json(describe(&state.db, &claims).await?))
}

/// Records the choice, and says so in the audit log (the category and the way, never the address).
async fn apply(
    db: &Db,
    claims: &Claims,
    category: OptOutCategory,
    enabled: bool,
    via: &str,
) -> Result<(), ApiError> {
    let mut tx = db.tenant(claims.tenant).await?;
    let changed = if enabled {
        email::opt_in(&mut tx, &claims.address_hash, category).await?
    } else {
        let was_on = !email::opted_out(&mut tx, &claims.address_hash)
            .await?
            .contains(&category);
        email::opt_out(&mut tx, &claims.address_hash, category).await?;
        was_on
    };
    if changed {
        audit::append(
            &mut tx,
            &audit::NewEntry {
                actor_kind: ActorKind::System,
                actor_id: Some("email-link".to_owned()),
                action: if enabled {
                    "email.opted_in"
                } else {
                    "email.opted_out"
                }
                .to_owned(),
                subject_type: "shop".to_owned(),
                subject_id: claims.shop.as_uuid(),
                data: json!({"category": category.as_str(), "via": via}),
            },
        )
        .await?;
    }
    tx.commit().await?;
    info!(
        category = category.as_str(),
        enabled, via, "email choice recorded"
    );
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// The public listener: RFC 8058 one-click

/// What the webhook listener's email routes need.
#[derive(Clone, Debug)]
pub struct OneClickState {
    db: Db,
    links: EmailLinks,
}

impl OneClickState {
    /// State for the listener.
    #[must_use]
    pub fn new(db: Db, links: EmailLinks) -> Self {
        Self { db, links }
    }
}

#[derive(Debug, Deserialize)]
struct TokenQuery {
    t: Option<String>,
}

/// The routes mail providers reach: `POST /webhooks/email/unsubscribe?t=` (RFC 8058) and a `GET`
/// of the same address, which sends a person to the page. Their body limit is a kilobyte.
pub fn one_click_router(state: OneClickState) -> Router {
    let router = Router::new()
        .route(
            "/webhooks/email/unsubscribe",
            post(one_click).get(one_click_page),
        )
        .with_state(state);
    with_middleware(
        router,
        Limits {
            request_timeout: std::time::Duration::from_secs(5),
            body_bytes: 1024,
        },
    )
}

/// RFC 8058 section 3.1: the mail client POSTs `List-Unsubscribe=One-Click` to the address in
/// `List-Unsubscribe`, with no cookies and no other context. The address alone identifies what to
/// do, so the token is in the query.
async fn one_click(
    State(state): State<OneClickState>,
    Query(query): Query<TokenQuery>,
    body: axum::body::Bytes,
) -> Result<StatusCode, ApiError> {
    if !is_one_click_body(&body) {
        return Err(ApiError::new(ProblemCode::BadRequest)
            .detail("The body must be List-Unsubscribe=One-Click."));
    }
    let token = query.t.unwrap_or_default();
    let claims = match state.links.keys.verify(&token, now()) {
        Ok(claims) if claims.purpose == Purpose::Unsubscribe => claims,
        Ok(_) | Err(_) => {
            warn!("one-click unsubscribe refused");
            return Err(
                ApiError::new(ProblemCode::BadRequest).detail("The unsubscribe link is not valid.")
            );
        }
    };
    let Some(category) = claims.category else {
        return Err(ApiError::new(ProblemCode::BadRequest).detail("The link names no category."));
    };
    apply(&state.db, &claims, category, false, "one_click").await?;
    Ok(StatusCode::OK)
}

/// Whether the form body holds `List-Unsubscribe=One-Click` (RFC 8058: exactly this pair; other
/// pairs are tolerated, as the RFC says a sender may add its own).
fn is_one_click_body(body: &[u8]) -> bool {
    std::str::from_utf8(body).is_ok_and(|text| {
        text.split('&')
            .any(|pair| pair.trim() == "List-Unsubscribe=One-Click")
    })
}

/// A person who follows the address gets the page, which asks before it changes anything.
async fn one_click_page(
    State(state): State<OneClickState>,
    Query(query): Query<TokenQuery>,
) -> Response {
    let token = query.t.unwrap_or_default();
    let well_formed = !token.is_empty()
        && token.len() <= MAX_TOKEN_CHARS
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if !well_formed {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let mut response = StatusCode::SEE_OTHER.into_response();
    if let Ok(target) = HeaderValue::from_str(&state.links.page(&token)) {
        response.headers_mut().insert(header::LOCATION, target);
    }
    response.headers_mut().insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    response
}

// ---------------------------------------------------------------------------------------------
// The App Home settings

/// Where the shop's notification mail stands.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct EmailPreferencesDto {
    /// Whether an address is on file for the shop. Without one nothing is sent.
    address_known: bool,
    /// The categories the merchant can switch, with their state.
    categories: Vec<EmailCategoryDto>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct EmailPreferencesUpdate {
    /// `notification`.
    category: String,
    /// `false` switches the category off.
    enabled: bool,
}

async fn preferences_of(
    tx: &mut db::TenantTx,
    shop: ShopId,
) -> Result<(Option<Vec<u8>>, EmailPreferencesDto), ApiError> {
    let hash = email::notification_address_hash(tx, shop).await?;
    let off = match &hash {
        Some(hash) => email::opted_out(tx, hash).await?,
        None => Vec::new(),
    };
    let dto = EmailPreferencesDto {
        address_known: hash.is_some(),
        categories: PREFERENCE_CATEGORIES
            .iter()
            .map(|category| EmailCategoryDto {
                category: category.as_str().to_owned(),
                enabled: !off.contains(category),
            })
            .collect(),
    };
    Ok((hash, dto))
}

/// The shop's email preferences.
#[utoipa::path(
    get,
    path = "/v1/shopify/email-preferences",
    tag = "app",
    operation_id = "getEmailPreferences",
    security(("shopify_session" = [])),
    responses(
        (status = OK, description = "The preferences", body = EmailPreferencesDto),
        (status = UNAUTHORIZED, description = "Missing or invalid session token",
            body = http_kit::Problem, content_type = "application/problem+json")
    )
)]
pub(crate) async fn get_email_preferences(
    State(state): State<AppState>,
    crate::shopify::ShopSession(session): crate::shopify::ShopSession,
) -> Result<Json<EmailPreferencesDto>, ApiError> {
    let mut tx = state.db.tenant(session.tenant).await?;
    let (_, dto) = preferences_of(&mut tx, session.shop_id).await?;
    tx.rollback().await?;
    Ok(Json(dto))
}

/// Switches a category of the shop's notification mail on or off.
#[utoipa::path(
    put,
    path = "/v1/shopify/email-preferences",
    tag = "app",
    operation_id = "updateEmailPreferences",
    security(("shopify_session" = [])),
    request_body = EmailPreferencesUpdate,
    responses(
        (status = OK, description = "The preferences after the change", body = EmailPreferencesDto),
        (status = NOT_FOUND, description = "No address is on file for the shop yet",
            body = http_kit::Problem, content_type = "application/problem+json"),
        (status = UNPROCESSABLE_ENTITY, description = "Not a category a merchant can change",
            body = http_kit::Problem, content_type = "application/problem+json"),
        (status = UNAUTHORIZED, description = "Missing or invalid session token",
            body = http_kit::Problem, content_type = "application/problem+json")
    )
)]
pub(crate) async fn update_email_preferences(
    State(state): State<AppState>,
    crate::shopify::ShopSession(session): crate::shopify::ShopSession,
    Body(body): Body<EmailPreferencesUpdate>,
) -> Result<Json<EmailPreferencesDto>, ApiError> {
    let category = OptOutCategory::parse(&body.category)
        .filter(|c| PREFERENCE_CATEGORIES.contains(c))
        .ok_or_else(|| {
            ApiError::new(ProblemCode::ValidationFailed)
                .detail("That category cannot be changed here.")
        })?;
    let mut tx = state.db.tenant(session.tenant).await?;
    // The shop must be one of the tenant's installed shops: RLS confines the tenant, and this
    // confines the shop.
    if shops::get(&mut tx, session.shop_id).await?.is_none() {
        return Err(ApiError::new(ProblemCode::NotFound));
    }
    let (hash, _) = preferences_of(&mut tx, session.shop_id).await?;
    let Some(hash) = hash else {
        return Err(ApiError::new(ProblemCode::NotFound)
            .detail("No email address is on file for this shop yet."));
    };
    let changed = if body.enabled {
        email::opt_in(&mut tx, &hash, category).await?
    } else {
        let was_on = !email::opted_out(&mut tx, &hash).await?.contains(&category);
        email::opt_out(&mut tx, &hash, category).await?;
        was_on
    };
    if changed {
        audit::append(
            &mut tx,
            &audit::NewEntry {
                actor_kind: ActorKind::User,
                actor_id: session
                    .user_id
                    .as_deref()
                    .map(|sub| format!("shopify:{sub}")),
                action: if body.enabled {
                    "email.opted_in"
                } else {
                    "email.opted_out"
                }
                .to_owned(),
                subject_type: "shop".to_owned(),
                subject_id: session.shop_id.as_uuid(),
                data: json!({"category": category.as_str(), "via": "settings"}),
            },
        )
        .await?;
    }
    let (_, dto) = preferences_of(&mut tx, session.shop_id).await?;
    tx.commit().await?;
    Ok(Json(dto))
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../../../packages/email/test/fixtures/link-vectors.json");

    fn fixture() -> serde_json::Value {
        serde_json::from_str(FIXTURE).unwrap()
    }

    fn claims_of(vector: &serde_json::Value) -> Claims {
        let c = &vector["claims"];
        let hash: Vec<u8> = c["addressHash"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| u8::try_from(v.as_u64().unwrap()).unwrap())
            .collect();
        Claims {
            purpose: if c["purpose"] == "unsubscribe" {
                Purpose::Unsubscribe
            } else {
                Purpose::Preferences
            },
            category: c["category"].as_str().and_then(OptOutCategory::parse),
            expires_at: u32::try_from(c["expiresAt"].as_u64().unwrap()).unwrap(),
            tenant: TenantId::from_uuid(c["tenantId"].as_str().unwrap().parse().unwrap()),
            shop: ShopId::from_uuid(c["shopId"].as_str().unwrap().parse().unwrap()),
            address_hash: hash.try_into().unwrap(),
        }
    }

    fn now_of_fixture() -> i64 {
        i64::try_from(fixture()["now"].as_u64().unwrap()).unwrap()
    }

    #[test]
    fn reads_the_tokens_the_typescript_minter_wrote() {
        let fixture = fixture();
        let keys = LinkKeys::parse(fixture["keys"].as_str().unwrap()).unwrap();
        for vector in fixture["vectors"].as_array().unwrap() {
            let token = vector["token"].as_str().unwrap();
            let name = vector["name"].as_str().unwrap();
            assert_eq!(
                keys.verify(token, now_of_fixture()),
                Ok(claims_of(vector)),
                "{name}"
            );
        }
    }

    #[test]
    fn writes_the_same_bytes_as_the_typescript_minter() {
        let fixture = fixture();
        for vector in fixture["vectors"].as_array().unwrap() {
            let name = vector["name"].as_str().unwrap();
            let spec = if name.ends_with("old-key") {
                fixture["oldKeys"].as_str().unwrap()
            } else {
                fixture["keys"].as_str().unwrap()
            };
            let keys = LinkKeys::parse(spec).unwrap();
            assert_eq!(
                keys.mint(&claims_of(vector)),
                vector["token"].as_str().unwrap(),
                "{name}"
            );
        }
    }

    #[test]
    fn any_changed_bit_is_refused() {
        let fixture = fixture();
        let keys = LinkKeys::parse(fixture["keys"].as_str().unwrap()).unwrap();
        let token = fixture["vectors"][0]["token"].as_str().unwrap();
        let raw = URL_SAFE_NO_PAD.decode(token).unwrap();
        for index in 0..raw.len() {
            let mut changed = raw.clone();
            changed[index] ^= 1;
            let text = URL_SAFE_NO_PAD.encode(&changed);
            assert!(
                keys.verify(&text, now_of_fixture()).is_err(),
                "byte {index} changed"
            );
        }
    }

    #[test]
    fn a_forged_claim_is_a_bad_signature_and_an_old_key_is_unknown() {
        let fixture = fixture();
        let keys = LinkKeys::parse(fixture["keys"].as_str().unwrap()).unwrap();
        let token = fixture["vectors"][0]["token"].as_str().unwrap();
        let mut raw = URL_SAFE_NO_PAD.decode(token).unwrap();
        raw[2] = 2; // notification -> marketing
        assert_eq!(
            keys.verify(&URL_SAFE_NO_PAD.encode(&raw), now_of_fixture()),
            Err(Refusal::BadSignature)
        );
        let retired =
            LinkKeys::parse(fixture["keys"].as_str().unwrap().split(',').next().unwrap()).unwrap();
        let old = fixture["vectors"][3]["token"].as_str().unwrap();
        assert_eq!(
            retired.verify(old, now_of_fixture()),
            Err(Refusal::UnknownKey)
        );
    }

    #[test]
    fn expires_at_the_named_second() {
        let fixture = fixture();
        let keys = LinkKeys::parse(fixture["keys"].as_str().unwrap()).unwrap();
        let token = fixture["vectors"][0]["token"].as_str().unwrap();
        let expires = i64::try_from(
            fixture["vectors"][0]["claims"]["expiresAt"]
                .as_u64()
                .unwrap(),
        )
        .unwrap();
        assert!(keys.verify(token, expires - 1).is_ok());
        assert_eq!(keys.verify(token, expires), Err(Refusal::Expired));
    }

    #[test]
    fn malformed_text_is_refused_without_panicking() {
        let fixture = fixture();
        let keys = LinkKeys::parse(fixture["keys"].as_str().unwrap()).unwrap();
        for text in ["", "x", "!!!!", &"A".repeat(401), &"A".repeat(140), "é"] {
            assert!(keys.verify(text, 0).is_err(), "{text:?}");
        }
    }

    #[test]
    fn key_errors_never_repeat_a_key() {
        let short = STANDARD_NO_PAD.encode([9_u8; 8]);
        for spec in [
            "",
            "no-colon",
            &format!("k1:{short}"),
            "bad id:AAAA",
            "k1:@@@@",
        ] {
            let error = LinkKeys::parse(spec).unwrap_err();
            assert!(!error.to_string().contains(&short), "{spec}");
        }
        let long = STANDARD_NO_PAD.encode([1_u8; 32]);
        assert_eq!(
            LinkKeys::parse(&format!("k1:{long},k1:{long}")).unwrap_err(),
            KeyError("a key id is listed twice")
        );
        let ring = LinkKeys::parse(&format!("k1:{long}")).unwrap();
        assert!(!format!("{ring:?}").contains(&long));
    }

    #[test]
    fn the_one_click_body_is_the_rfc_8058_pair() {
        assert!(is_one_click_body(b"List-Unsubscribe=One-Click"));
        assert!(is_one_click_body(b"x=1&List-Unsubscribe=One-Click"));
        for bad in [
            &b""[..],
            b"List-Unsubscribe=Other",
            b"unsubscribe=1",
            &[0xff, 0xfe],
        ] {
            assert!(!is_one_click_body(bad));
        }
    }
}
