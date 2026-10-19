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
