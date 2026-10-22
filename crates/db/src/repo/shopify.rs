//! Shopify shops and their sealed offline tokens (PLAN §9, §14; ADR-021, ADR-022).
//!
//! Token columns hold ciphertext from `crates/crypto` only; this module never sees a
//! plaintext token. Every token write is a compare-and-swap on `version`.

use domain::{ShopId, ShopStatus, SiteId};
use time::OffsetDateTime;

use crate::error::parse;
use crate::{DbError, TenantTx};

/// Input for [`install`].
#[derive(Debug, Clone)]
pub struct NewShop {
    /// The site that represents the storefront.
    pub site_id: SiteId,
    /// The validated `*.myshopify.com` host.
    pub shop_domain: String,
    /// Granted scopes.
    pub scopes: Vec<String>,
    /// Admin API version, such as `2026-10`.
    pub api_version: String,
}

/// A shop owned by the transaction's tenant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Shop {
    /// The shop's id.
    pub id: ShopId,
    /// Its site.
    pub site_id: SiteId,
    /// Its `*.myshopify.com` host.
    pub shop_domain: String,
    /// Granted scopes.
    pub scopes: Vec<String>,
    /// Admin API version.
    pub api_version: String,
    /// Installation state.
    pub status: ShopStatus,
    /// When the app was (last) installed.
    pub installed_at: OffsetDateTime,
    /// When the app was uninstalled, if it is.
    pub uninstalled_at: Option<OffsetDateTime>,
}

struct ShopRow {
    id: uuid::Uuid,
    site_id: uuid::Uuid,
    shop_domain: String,
    scopes: Vec<String>,
    api_version: String,
    status: String,
    installed_at: OffsetDateTime,
    uninstalled_at: Option<OffsetDateTime>,
}

impl TryFrom<ShopRow> for Shop {
    type Error = DbError;

    fn try_from(r: ShopRow) -> Result<Self, DbError> {
        Ok(Self {
            id: ShopId::from_uuid(r.id),
            site_id: SiteId::from_uuid(r.site_id),
            shop_domain: r.shop_domain,
            scopes: r.scopes,
            api_version: r.api_version,
            status: parse(&r.status, "shopify_shops.status")?,
            installed_at: r.installed_at,
            uninstalled_at: r.uninstalled_at,
        })
    }
}

/// Records a new installation for the transaction's tenant.
pub async fn install(tx: &mut TenantTx, new: &NewShop) -> Result<Shop, DbError> {
    let tenant = tx.tenant_uuid();
    let row = sqlx::query_as!(
        ShopRow,
        r#"insert into shopify_shops
             (id, tenant_id, site_id, shop_domain, scopes, api_version, status, installed_at)
           values ($1, $2, $3, $4, $5, $6, 'installed', now())
           returning id, site_id, shop_domain, scopes, api_version, status, installed_at, uninstalled_at"#,
        ShopId::new().as_uuid(),
        tenant,
        new.site_id.as_uuid(),
        new.shop_domain,
        &new.scopes,
        new.api_version,
    )
    .fetch_one(tx.conn())
    .await?;
    row.try_into()
}

/// Marks an existing shop installed again with fresh scopes. `None` if it is not this
/// tenant's.
pub async fn reinstall(
    tx: &mut TenantTx,
    id: ShopId,
    scopes: &[String],
    api_version: &str,
) -> Result<Option<Shop>, DbError> {
    let tenant = tx.tenant_uuid();
    let row = sqlx::query_as!(
        ShopRow,
        r#"update shopify_shops
              set status = 'installed', scopes = $3, api_version = $4,
                  installed_at = case when status = 'installed' then installed_at else now() end,
                  uninstalled_at = null
            where tenant_id = $1 and id = $2
        returning id, site_id, shop_domain, scopes, api_version, status, installed_at, uninstalled_at"#,
        tenant,
        id.as_uuid(),
        scopes,
        api_version,
    )
    .fetch_optional(tx.conn())
    .await?;
    row.map(Shop::try_from).transpose()
}

/// One shop of the transaction's tenant.
pub async fn get(tx: &mut TenantTx, id: ShopId) -> Result<Option<Shop>, DbError> {
    let tenant = tx.tenant_uuid();
    let row = sqlx::query_as!(
        ShopRow,
        r#"select id, site_id, shop_domain, scopes, api_version, status, installed_at, uninstalled_at
             from shopify_shops where tenant_id = $1 and id = $2"#,
        tenant,
        id.as_uuid(),
    )
    .fetch_optional(tx.conn())
    .await?;
    row.map(Shop::try_from).transpose()
}

/// Sealed tokens and their expiry, as stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SealedTokens {
    /// The sealed access token.
    pub access_ct: Vec<u8>,
    /// The sealed refresh token.
    pub refresh_ct: Vec<u8>,
    /// The master key that wrapped both data keys.
    pub key_id: String,
    /// When the access token expires.
    pub access_expires_at: OffsetDateTime,
    /// When the refresh token expires.
    pub refresh_expires_at: OffsetDateTime,
}

/// A shop's token row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredTokens {
    /// The shop.
    pub shop_id: ShopId,
    /// The sealed values.
    pub tokens: SealedTokens,
    /// Incremented by every write; the compare-and-swap token for [`rotate`] and
    /// [`put_tokens`].
    pub version: i64,
}

/// Stores a shop's tokens after token exchange, if the row is still as the caller read it
/// (ADR-022, ADR-044): `expected_version` is `None` when the caller found no token row, and
/// `Some(version)` when it found one at that version.
///
/// `Some(new version)` on success (0 for a first row). `None` when the row is not as claimed
/// (another writer stored or changed it, or the shop is another tenant's) and nothing changed:
/// the caller re-reads, or fails. A `Some` claim is [`rotate`]; the `None` claim is an insert
/// that yields to any existing row.
pub async fn put_tokens(
    tx: &mut TenantTx,
    shop: ShopId,
    expected_version: Option<i64>,
    tokens: &SealedTokens,
) -> Result<Option<i64>, DbError> {
    let Some(expected_version) = expected_version else {
        return insert_tokens(tx, shop, tokens).await;
    };
    rotate(tx, shop, expected_version, tokens).await
}

/// Inserts the first token row of a shop; `None` when a row already exists.
async fn insert_tokens(
    tx: &mut TenantTx,
    shop: ShopId,
    tokens: &SealedTokens,
) -> Result<Option<i64>, DbError> {
    let tenant = tx.tenant_uuid();
    Ok(sqlx::query_scalar!(
        r#"insert into shopify_tokens
             (shop_id, tenant_id, access_ct, refresh_ct, key_id, access_expires_at, refresh_expires_at)
           values ($1, $2, $3, $4, $5, $6, $7)
           on conflict (shop_id) do nothing
        returning version"#,
        shop.as_uuid(),
        tenant,
        tokens.access_ct,
        tokens.refresh_ct,
        tokens.key_id,
        tokens.access_expires_at,
        tokens.refresh_expires_at,
    )
    .fetch_optional(tx.conn())
    .await?)
}

/// A shop's tokens, if any are stored.
pub async fn get_tokens(tx: &mut TenantTx, shop: ShopId) -> Result<Option<StoredTokens>, DbError> {
    let tenant = tx.tenant_uuid();
    let row = sqlx::query!(
        r#"select shop_id, access_ct, refresh_ct, key_id, access_expires_at, refresh_expires_at, version
             from shopify_tokens where tenant_id = $1 and shop_id = $2"#,
        tenant,
        shop.as_uuid(),
    )
    .fetch_optional(tx.conn())
    .await?;
    Ok(row.map(|r| StoredTokens {
        shop_id: ShopId::from_uuid(r.shop_id),
        tokens: SealedTokens {
            access_ct: r.access_ct,
            refresh_ct: r.refresh_ct,
            key_id: r.key_id,
            access_expires_at: r.access_expires_at,
            refresh_expires_at: r.refresh_expires_at,
        },
        version: r.version,
    }))
}

/// Replaces the tokens only if the row is still at `expected_version`. `Some(new version)`
/// on success; `None` when another writer rotated first, in which case re-read.
pub async fn rotate(
    tx: &mut TenantTx,
    shop: ShopId,
    expected_version: i64,
    tokens: &SealedTokens,
) -> Result<Option<i64>, DbError> {
    let tenant = tx.tenant_uuid();
    Ok(sqlx::query_scalar!(
        r#"update shopify_tokens
              set access_ct = $4, refresh_ct = $5, key_id = $6,
                  access_expires_at = $7, refresh_expires_at = $8,
                  version = version + 1
            where tenant_id = $1 and shop_id = $2 and version = $3
        returning version"#,
        tenant,
        shop.as_uuid(),
        expected_version,
        tokens.access_ct,
        tokens.refresh_ct,
        tokens.key_id,
        tokens.access_expires_at,
        tokens.refresh_expires_at,
    )
    .fetch_optional(tx.conn())
    .await?)
}

/// The two sealed tokens of a row, with their data keys wrapped under another master key
/// (audit L6, ADR-045). The tokens and their expiry are the same; only the wrapping changed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rewrapped {
    /// The sealed access token, re-wrapped.
    pub access_ct: Vec<u8>,
    /// The sealed refresh token, re-wrapped.
    pub refresh_ct: Vec<u8>,
    /// The master key that wraps both data keys now.
    pub key_id: String,
}

/// Swaps in a re-wrapped copy of a row's tokens, only if the row is still exactly as the caller
/// read it: the same version, master key id and ciphertexts (audit L6, ADR-045). Returns whether
/// it did. `false` means the row was rotated, re-wrapped by someone else, replaced or removed
/// since, and nothing changed.
///
/// The version is not incremented, on purpose. Re-wrapping changes how the same tokens are
/// stored, not which tokens they are. A token refresh that read the row before this swap and
/// stores new tokens after it must still win, and a bumped version would make it fail its
/// compare-and-swap for no reason. The ciphertexts are compared as well as the version because
/// a version alone can repeat: a row deleted and stored again starts at version 0, and an old
/// process may still seal under the key being retired.
pub async fn replace_wrapping(
    tx: &mut TenantTx,
    shop: ShopId,
    read: &StoredTokens,
    rewrapped: &Rewrapped,
) -> Result<bool, DbError> {
    let tenant = tx.tenant_uuid();
    let done = sqlx::query!(
        r#"update shopify_tokens
              set access_ct = $7, refresh_ct = $8, key_id = $9
            where tenant_id = $1 and shop_id = $2 and version = $3 and key_id = $4
              and access_ct = $5 and refresh_ct = $6"#,
        tenant,
        shop.as_uuid(),
        read.version,
        read.tokens.key_id,
        read.tokens.access_ct,
        read.tokens.refresh_ct,
        rewrapped.access_ct,
        rewrapped.refresh_ct,
        rewrapped.key_id,
    )
    .execute(tx.conn())
    .await?;
    Ok(done.rows_affected() > 0)
}

/// Deletes a shop's tokens, after Shopify revoked them or the app was uninstalled. Returns
/// whether a row was deleted.
pub async fn delete_tokens(tx: &mut TenantTx, shop: ShopId) -> Result<bool, DbError> {
    let tenant = tx.tenant_uuid();
    let done = sqlx::query!(
        "delete from shopify_tokens where tenant_id = $1 and shop_id = $2",
        tenant,
        shop.as_uuid(),
    )
    .execute(tx.conn())
    .await?;
    Ok(done.rows_affected() > 0)
}

/// Marks an installed shop uninstalled and starts the retention clock (`app/uninstalled`,
/// PLAN §19). Returns whether the shop was installed; an already uninstalled or redacted shop
/// is left as it is, which makes a repeated webhook harmless.
pub async fn mark_uninstalled(tx: &mut TenantTx, id: ShopId) -> Result<bool, DbError> {
    let tenant = tx.tenant_uuid();
    let done = sqlx::query!(
        r#"update shopify_shops set status = 'uninstalled', uninstalled_at = now()
            where tenant_id = $1 and id = $2 and status = 'installed'"#,
        tenant,
        id.as_uuid(),
    )
    .execute(tx.conn())
    .await?;
    Ok(done.rows_affected() > 0)
}

/// Records what `shopify.read_store` or `shop/update` learned about the shop.
pub async fn set_info(
    tx: &mut TenantTx,
    id: ShopId,
    primary_domain: Option<&str>,
    locales: &[String],
) -> Result<bool, DbError> {
    let tenant = tx.tenant_uuid();
    let done = sqlx::query!(
        r#"update shopify_shops set primary_domain = $3, locales = $4, synced_at = now()
            where tenant_id = $1 and id = $2 and status = 'installed'"#,
        tenant,
        id.as_uuid(),
        primary_domain,
        locales,
    )
    .execute(tx.conn())
    .await?;
    Ok(done.rows_affected() > 0)
}

/// What `shopify.read_store` and `shop/update` last stored about a shop.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShopInfo {
    /// The shop's primary domain host, if the shop has one.
    pub primary_domain: Option<String>,
    /// Its locales.
    pub locales: Vec<String>,
    /// When they were read.
    pub synced_at: Option<OffsetDateTime>,
}

/// The stored shop information of one shop.
pub async fn get_info(tx: &mut TenantTx, id: ShopId) -> Result<Option<ShopInfo>, DbError> {
    let tenant = tx.tenant_uuid();
    let row = sqlx::query!(
        r#"select primary_domain, locales, synced_at
             from shopify_shops where tenant_id = $1 and id = $2"#,
        tenant,
        id.as_uuid(),
    )
    .fetch_optional(tx.conn())
    .await?;
    Ok(row.map(|r| ShopInfo {
        primary_domain: r.primary_domain,
        locales: r.locales,
        synced_at: r.synced_at,
    }))
}

/// Records Shopify's own id for the shop, as the Admin API reported it. `false` when the shop
/// is not an installed shop of the tenant, or the id is not a shop GID.
pub async fn set_shop_gid(tx: &mut TenantTx, id: ShopId, gid: &str) -> Result<bool, DbError> {
    let tenant = tx.tenant_uuid();
    let done = sqlx::query!(
        r#"update shopify_shops set shop_gid = $3
            where tenant_id = $1 and id = $2 and status = 'installed'
              and $3 ~ '^gid://shopify/Shop/[0-9]{1,18}$'"#,
        tenant,
        id.as_uuid(),
        gid,
    )
    .execute(tx.conn())
    .await?;
    Ok(done.rows_affected() > 0)
}

/// Shopify's id for the shop, once `shopify.read_store` has recorded it.
pub async fn shop_gid(tx: &mut TenantTx, id: ShopId) -> Result<Option<String>, DbError> {
    let tenant = tx.tenant_uuid();
    Ok(sqlx::query_scalar!(
        r#"select shop_gid from shopify_shops where tenant_id = $1 and id = $2"#,
        tenant,
        id.as_uuid(),
    )
    .fetch_optional(tx.conn())
    .await?
    .flatten())
}
