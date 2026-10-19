//! The Shopify offline-token lifecycle (PLAN §14, ADR-021, ADR-022).
//!
//! - [`ShopifyAuth::authenticate`] turns an App Bridge session token into a [`ShopSession`]:
//!   it verifies the token, finds the shop's tenant, and when the shop has no valid offline
//!   token (first install, reinstall, expired or revoked token) runs token exchange under the
//!   shop's lock and stores the sealed pair.
//! - [`ShopifyAuth::refresh_if_due`] refreshes an access token within ten minutes of expiry,
//!   with compare-and-swap rotation; `ctl`'s `shopify.token_refresh` job calls it weekly.
//!
//! Plaintext tokens exist only in memory, inside `SecretString`, and are never logged.

use std::time::Duration as StdDuration;

use contracts::ShopifyTokenRefresh;
use crypto::{CryptoError, KeyRing};
use db::repo::shopify::{self as shops, NewShop, SealedTokens, StoredTokens};
use db::repo::{audit, jobs, sites, tenants};
use db::{Db, DbError, ShopRef, TenantTx};
use domain::{ActorKind, Platform, ShopId, ShopStatus, TenantId, TenantKind};
use queue::NewJob;
use secrecy::SecretString;
use shopify::{
    OfflineToken, SessionTokenError, SessionTokenVerifier, ShopDomain, TokenClient, TokenError,
};
use time::{Duration, OffsetDateTime};
use tracing::{info, instrument, warn};

/// Refresh an access token this long before it expires (PLAN §14 step 6).
pub const REFRESH_MARGIN: Duration = Duration::minutes(10);
/// The keep-alive cadence that stops refresh tokens from ageing out (PLAN §14 step 7).
pub const KEEPALIVE_EVERY: Duration = Duration::days(7);

/// A merchant's authenticated request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShopSession {
    /// The shop's tenant: open every transaction for this request with it.
    pub tenant: TenantId,
    /// The shop.
    pub shop_id: ShopId,
    /// The shop's domain.
    pub shop: ShopDomain,
    /// The Shopify staff user (`sub`).
    pub user_id: Option<String>,
    /// Whether this request installed (or reinstalled) the app.
    pub installed: bool,
}

/// Why a request could not be authenticated.
#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    /// The session token failed verification. Answer 401 with the retry header.
    #[error("invalid session token: {0}")]
    InvalidSessionToken(#[from] SessionTokenError),
    /// Shopify refused the token in exchange: it is stale. Answer 401 with the retry header.
    #[error("Shopify rejected the session token as stale")]
    StaleSessionToken,
    /// Shopify is throttling or failing; the request may succeed later. Answer 503.
    #[error("Shopify is unavailable: {0}")]
    Unavailable(TokenError),
    /// Shopify refused the app's credentials or answered nonsense. Answer 500 and alert.
    #[error("token exchange failed: {0}")]
    Exchange(TokenError),
    /// The database failed.
    #[error(transparent)]
    Database(#[from] DbError),
    /// Sealing or opening a token failed (a missing master key, for example).
    #[error(transparent)]
    Crypto(#[from] CryptoError),
}

/// What [`ShopifyAuth::refresh_if_due`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefreshOutcome {
    /// The access token has more than [`REFRESH_MARGIN`] left.
    Fresh,
    /// A new pair was stored.
    Refreshed,
    /// Shopify revoked the grant; the tokens were deleted. The merchant re-authenticates the
    /// next time they open the app.
    Revoked,
    /// The shop is not installed or has no tokens.
    NotInstalled,
}

/// Why a refresh failed.
#[derive(Debug, thiserror::Error)]
pub enum RefreshError {
    /// Throttled, a server error or a timeout: retry with backoff.
    #[error("refresh may succeed later: {0}")]
    Retryable(TokenError),
    /// Shopify refused the request for a reason a retry cannot fix.
    #[error("refresh rejected: {0}")]
    Rejected(TokenError),
    /// The database failed.
    #[error(transparent)]
    Database(#[from] DbError),
    /// Opening or sealing failed.
    #[error(transparent)]
    Crypto(#[from] CryptoError),
}

/// The offline-token lifecycle for one app.
#[derive(Debug, Clone)]
pub struct ShopifyAuth {
    db: Db,
    keys: KeyRing,
    verifier: SessionTokenVerifier,
    tokens: TokenClient,
}

/// What an exchange found under the shop's lock before it called Shopify.
#[derive(Debug, Clone, Copy)]
struct Prior {
    /// The shop, if it is known.
    existing: Option<ShopRef>,
    /// The version of its token row, if it has one (the compare-and-swap claim, ADR-044).
    claimed: Option<i64>,
}

fn access_context(shop: ShopId) -> String {
    format!("shopify_tokens/access/{shop}")
}

fn refresh_context(shop: ShopId) -> String {
    format!("shopify_tokens/refresh/{shop}")
}

fn seconds(duration: StdDuration) -> Duration {
    Duration::seconds(i64::try_from(duration.as_secs()).unwrap_or(i64::MAX))
}

/// The next weekly keep-alive for `shop`, deduplicated per ISO week of its run time so app
/// opens and job chains converge on one job.
#[must_use]
pub fn keepalive_job(shop: ShopId, now: OffsetDateTime) -> NewJob {
    let run_at = now + KEEPALIVE_EVERY;
    let (year, week, _) = run_at.to_iso_week_date();
    let payload = ShopifyTokenRefresh {
        shop_id: shop.as_uuid(),
    };
    NewJob::new(
        ShopifyTokenRefresh::QUEUE,
        ShopifyTokenRefresh::SCHEMA,
        serde_json::to_value(payload).unwrap_or_default(),
    )
    .run_at(run_at)
    .idempotency_key(format!(
        "{}:{shop}:{year}-W{week:02}",
        ShopifyTokenRefresh::QUEUE
    ))
}

impl ShopifyAuth {
    /// Wires the lifecycle together.
    #[must_use]
    pub const fn new(
        db: Db,
        keys: KeyRing,
        verifier: SessionTokenVerifier,
        tokens: TokenClient,
    ) -> Self {
        Self {
            db,
            keys,
            verifier,
            tokens,
        }
    }

    /// Authenticates an embedded request by its session token, now.
    pub async fn authenticate(&self, id_token: &str) -> Result<ShopSession, AuthError> {
        self.authenticate_at(id_token, OffsetDateTime::now_utc())
            .await
    }

    /// Authenticates an embedded request by its session token, as of `now`.
    #[instrument(skip_all, err(Display))]
    pub async fn authenticate_at(
        &self,
        id_token: &str,
        now: OffsetDateTime,
    ) -> Result<ShopSession, AuthError> {
        let token = self.verifier.verify_at(id_token, now)?;
        let session = |tenant, shop_id, installed| ShopSession {
            tenant,
            shop_id,
            shop: token.shop.clone(),
            user_id: token.user_id.clone(),
            installed,
        };

        if let Some((tenant, shop_id)) = self.usable_shop(&token.shop, now).await? {
            return Ok(session(tenant, shop_id, false));
        }

        // Exchange retires every other token of this app on this shop, so it runs under the
        // shop's lock (ADR-022). The check is repeated once the lock is held, and the lock's
        // own connection does the re-check and the store, so a holder needs one connection
        // and a burst of cold opens cannot drain the pool (ADR-041).
        let mut lock = self.db.shop_lock(token.shop.as_str()).await?;
        let existing = lock.shop_by_domain(token.shop.as_str()).await?;
        let tenant = existing.map_or_else(TenantId::new, |f| f.tenant);
        let mut tx = lock.into_tenant(tenant).await?;
        // The token row as it is now. The new pair is stored only if the row is still like this
        // when the exchange returns (compare-and-swap, ADR-044).
        let mut claimed = None;
        if let Some(found) = existing {
            let current = shops::get_tokens(&mut tx, found.shop).await?;
            if found.status == ShopStatus::Installed
                && current
                    .as_ref()
                    .is_some_and(|s| s.tokens.access_expires_at > now)
            {
                tx.rollback().await?;
                return Ok(session(tenant, found.shop, false));
            }
            claimed = current.map(|s| s.version);
        }
        let exchanged = self.tokens.exchange(&token.shop, id_token).await;
        let offline = match exchanged {
            Ok(offline) => offline,
            Err(e) => {
                let _ = tx.rollback().await;
                return Err(match e {
                    TokenError::InvalidSubjectToken => AuthError::StaleSessionToken,
                    e if e.is_retryable() => AuthError::Unavailable(e),
                    e => AuthError::Exchange(e),
                });
            }
        };
        let stored = self
            .store_exchanged(
                &mut tx,
                Prior { existing, claimed },
                &token.shop,
                token.user_id.as_deref(),
                &offline,
                now,
            )
            .await;
        let shop_id = match stored {
            Ok(shop_id) => shop_id,
            Err(e) => {
                let _ = tx.rollback().await;
                return Err(e);
            }
        };
        tx.commit().await?;
        info!(%tenant, %shop_id, "offline token acquired by token exchange");
        Ok(session(tenant, shop_id, true))
    }

    /// The shop's tenant and id when it is installed and holds an unexpired access token.
    async fn usable_shop(
        &self,
        shop: &ShopDomain,
        now: OffsetDateTime,
    ) -> Result<Option<(TenantId, ShopId)>, DbError> {
        let Some(found) = self.db.shop_by_domain(shop.as_str()).await? else {
            return Ok(None);
        };
        if found.status != ShopStatus::Installed {
            return Ok(None);
        }
        let mut tx = self.db.tenant(found.tenant).await?;
        let stored = shops::get_tokens(&mut tx, found.shop).await?;
        tx.rollback().await?;
        Ok(stored
            .filter(|s| s.tokens.access_expires_at > now)
            .map(|_| (found.tenant, found.shop)))
    }

    fn seal(
        &self,
        shop: ShopId,
        offline: &OfflineToken,
        now: OffsetDateTime,
    ) -> Result<SealedTokens, CryptoError> {
        use secrecy::ExposeSecret;
        let access = self.keys.seal(
            offline.access_token.expose_secret().as_bytes(),
            access_context(shop).as_bytes(),
        )?;
        let refresh = self.keys.seal(
            offline.refresh_token.expose_secret().as_bytes(),
            refresh_context(shop).as_bytes(),
        )?;
        let (key_id, access_ct) = access.into_parts();
        let (_, refresh_ct) = refresh.into_parts();
        Ok(SealedTokens {
            access_ct,
            refresh_ct,
            key_id: key_id.as_str().to_owned(),
            access_expires_at: now + seconds(offline.expires_in),
            refresh_expires_at: now + seconds(offline.refresh_token_expires_in),
        })
    }

    /// Installs or reinstalls the shop and stores the exchanged pair in the lock's transaction,
    /// which the caller commits. If the token row has changed since `prior` was read, nothing is
    /// stored and the result is a conflict (every in-band writer holds the shop's lock, so only
    /// an out-of-band write can cause it).
    async fn store_exchanged(
        &self,
        tx: &mut TenantTx,
        prior: Prior,
        shop: &ShopDomain,
        user_id: Option<&str>,
        offline: &OfflineToken,
        now: OffsetDateTime,
    ) -> Result<ShopId, AuthError> {
        let (shop_id, action) = if let Some(found) = prior.existing {
            shops::reinstall(tx, found.shop, &offline.scopes, shopify::API_VERSION)
                .await?
                .ok_or(DbError::Forbidden)?;
            (found.shop, "shopify.token_exchanged")
        } else {
            (
                install(tx, shop, &offline.scopes).await?,
                "shopify.installed",
            )
        };
        let sealed = self.seal(shop_id, offline, now)?;
        if shops::put_tokens(tx, shop_id, prior.claimed, &sealed)
            .await?
            .is_none()
        {
            return Err(DbError::Conflict("shopify_tokens.version".to_owned()).into());
        }
        jobs::enqueue(tx, keepalive_job(shop_id, now)).await?;
        audit::append(
            tx,
            &audit::NewEntry {
                actor_kind: ActorKind::User,
                actor_id: user_id.map(|u| format!("shopify:{u}")),
                action: action.to_owned(),
                subject_type: "shopify_shop".to_owned(),
                subject_id: shop_id.as_uuid(),
                data: serde_json::json!({ "scopes": offline.scopes }),
            },
        )
        .await?;
        Ok(shop_id)
    }

    /// Refreshes the shop's access token if it expires within [`REFRESH_MARGIN`] of `now`.
    #[instrument(skip(self), err(Display))]
    pub async fn refresh_if_due(
        &self,
        tenant: TenantId,
        shop_id: ShopId,
        now: OffsetDateTime,
    ) -> Result<RefreshOutcome, RefreshError> {
        let Some((shop, stored)) = self.load(tenant, shop_id).await? else {
            return Ok(RefreshOutcome::NotInstalled);
        };
        if stored.tokens.access_expires_at > now + REFRESH_MARGIN {
            return Ok(RefreshOutcome::Fresh);
        }

        // The lock's own connection does the re-read, the call to Shopify and the store, so a
        // holder needs one connection (ADR-041).
        let lock = self.db.shop_lock(shop.as_str()).await?;
        let mut tx = lock.into_tenant(tenant).await?;
        let outcome = self.refresh_locked(&mut tx, shop_id, &shop, now).await;
        match outcome {
            Ok(done @ (RefreshOutcome::Refreshed | RefreshOutcome::Revoked)) => {
                tx.commit().await?;
                if done == RefreshOutcome::Revoked {
                    warn!(%shop_id, "Shopify revoked the offline token; tokens deleted");
                } else {
                    info!(%shop_id, "offline token refreshed");
                }
                Ok(done)
            }
            other => {
                let _ = tx.rollback().await;
                other
            }
        }
    }

    /// Runs under the shop's lock on its transaction; the caller commits or rolls back.
    async fn refresh_locked(
        &self,
        tx: &mut TenantTx,
        shop_id: ShopId,
        shop: &ShopDomain,
        now: OffsetDateTime,
    ) -> Result<RefreshOutcome, RefreshError> {
        // Re-read under the lock: an exchange or another refresh may have just finished.
        let Some((_, stored)) = load_in(tx, shop_id).await? else {
            return Ok(RefreshOutcome::NotInstalled);
        };
        if stored.tokens.access_expires_at > now + REFRESH_MARGIN {
            return Ok(RefreshOutcome::Fresh);
        }
        let refresh_token: SecretString = self.keys.open_string(
            &stored.tokens.key_id,
            &stored.tokens.refresh_ct,
            refresh_context(shop_id).as_bytes(),
        )?;
        let offline = match self.tokens.refresh(shop, &refresh_token).await {
            Ok(offline) => offline,
            Err(TokenError::Revoked) => {
                revoke(tx, shop_id).await?;
                return Ok(RefreshOutcome::Revoked);
            }
            Err(e) if e.is_retryable() => return Err(RefreshError::Retryable(e)),
            Err(e) => return Err(RefreshError::Rejected(e)),
        };
        let sealed = self.seal(shop_id, &offline, now)?;
        if shops::rotate(tx, shop_id, stored.version, &sealed)
            .await?
            .is_none()
        {
            // Another writer rotated first despite the lock (an operator, a restore). Its pair
            // is the newer one; keep it.
            warn!(%shop_id, "token rotation lost a compare-and-swap; keeping the stored pair");
            return Ok(RefreshOutcome::Fresh);
        }
        audit::append(
            tx,
            &audit::NewEntry {
                actor_kind: ActorKind::System,
                actor_id: None,
                action: "shopify.token_refreshed".to_owned(),
                subject_type: "shopify_shop".to_owned(),
                subject_id: shop_id.as_uuid(),
                data: serde_json::json!({}),
            },
        )
        .await?;
        Ok(RefreshOutcome::Refreshed)
    }

    async fn load(
        &self,
        tenant: TenantId,
        shop_id: ShopId,
    ) -> Result<Option<(ShopDomain, StoredTokens)>, RefreshError> {
        let mut tx = self.db.tenant(tenant).await?;
        let loaded = load_in(&mut tx, shop_id).await;
        tx.rollback().await?;
        loaded
    }

    /// A usable access token for background work: refreshed first if due. `None` when the
    /// shop is not installed or its grant was revoked.
    pub async fn access_token(
        &self,
        tenant: TenantId,
        shop_id: ShopId,
    ) -> Result<Option<SecretString>, RefreshError> {
        let now = OffsetDateTime::now_utc();
        match self.refresh_if_due(tenant, shop_id, now).await? {
            RefreshOutcome::Revoked | RefreshOutcome::NotInstalled => return Ok(None),
            RefreshOutcome::Fresh | RefreshOutcome::Refreshed => {}
        }
        let Some((_, stored)) = self.load(tenant, shop_id).await? else {
            return Ok(None);
        };
        Ok(Some(self.keys.open_string(
            &stored.tokens.key_id,
            &stored.tokens.access_ct,
            access_context(shop_id).as_bytes(),
        )?))
    }
}

/// The installed shop's domain and stored tokens, read on `tx`.
async fn load_in(
    tx: &mut TenantTx,
    shop_id: ShopId,
) -> Result<Option<(ShopDomain, StoredTokens)>, RefreshError> {
    let shop = shops::get(tx, shop_id).await?;
    let stored = shops::get_tokens(tx, shop_id).await?;
    let (Some(shop), Some(stored)) = (shop, stored) else {
        return Ok(None);
    };
    if shop.status != ShopStatus::Installed {
        return Ok(None);
    }
    let domain = ShopDomain::parse(&shop.shop_domain).map_err(|_| DbError::Corrupt {
        what: "shopify_shops.shop_domain",
    })?;
    Ok(Some((domain, stored)))
}

/// Deletes the shop's tokens after Shopify revoked the grant.
async fn revoke(tx: &mut TenantTx, shop_id: ShopId) -> Result<(), DbError> {
    shops::delete_tokens(tx, shop_id).await?;
    audit::append(
        tx,
        &audit::NewEntry {
            actor_kind: ActorKind::Shopify,
            actor_id: None,
            action: "shopify.token_revoked".to_owned(),
            subject_type: "shopify_shop".to_owned(),
            subject_id: shop_id.as_uuid(),
            data: serde_json::json!({}),
        },
    )
    .await?;
    Ok(())
}

/// Creates the tenant, its verified storefront site and the shop.
async fn install(
    tx: &mut TenantTx,
    shop: &ShopDomain,
    scopes: &[String],
) -> Result<ShopId, DbError> {
    tenants::create(tx, TenantKind::ShopifyStore).await?;
    let site = sites::create(
        tx,
        &sites::NewSite {
            platform: Platform::Shopify,
            base_url: shop.origin(),
            primary_locale: "en".to_owned(),
        },
    )
    .await?;
    sites::mark_verified(tx, site.id, "shopify_install").await?;
    let installed = shops::install(
        tx,
        &NewShop {
            site_id: site.id,
            shop_domain: shop.as_str().to_owned(),
            scopes: scopes.to_vec(),
            api_version: shopify::API_VERSION.to_owned(),
        },
    )
    .await?;
    Ok(installed.id)
}
