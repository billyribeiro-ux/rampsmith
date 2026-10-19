//! Sites whose pages are scanned.

use domain::{Platform, SiteId};
use time::OffsetDateTime;

use crate::error::parse;
use crate::{DbError, TenantTx};

/// Input for [`create`].
#[derive(Debug, Clone)]
pub struct NewSite {
    /// The platform the site runs on.
    pub platform: Platform,
    /// The site's HTTPS origin, such as `https://example.myshopify.com`.
    pub base_url: String,
    /// The site's primary locale, such as `en` or `de`.
    pub primary_locale: String,
}

/// A site owned by the transaction's tenant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Site {
    /// The site's id.
    pub id: SiteId,
    /// The platform it runs on.
    pub platform: Platform,
    /// Its HTTPS origin.
    pub base_url: String,
    /// When ownership was proven, if it was.
    pub verified_at: Option<OffsetDateTime>,
    /// How ownership was proven.
    pub verification_method: Option<String>,
    /// Its primary locale.
    pub primary_locale: String,
    /// When it was added.
    pub created_at: OffsetDateTime,
}

struct Row {
    id: uuid::Uuid,
    platform: String,
    base_url: String,
    verified_at: Option<OffsetDateTime>,
    verification_method: Option<String>,
    primary_locale: String,
    created_at: OffsetDateTime,
}

impl TryFrom<Row> for Site {
    type Error = DbError;

    fn try_from(r: Row) -> Result<Self, DbError> {
        Ok(Self {
            id: SiteId::from_uuid(r.id),
            platform: parse(&r.platform, "sites.platform")?,
            base_url: r.base_url,
            verified_at: r.verified_at,
            verification_method: r.verification_method,
            primary_locale: r.primary_locale,
            created_at: r.created_at,
        })
    }
}

/// Adds a site for the transaction's tenant.
pub async fn create(tx: &mut TenantTx, new: &NewSite) -> Result<Site, DbError> {
    let tenant = tx.tenant_uuid();
    let row = sqlx::query_as!(
        Row,
        r#"insert into sites (id, tenant_id, platform, base_url, primary_locale)
           values ($1, $2, $3, $4, $5)
           returning id, platform, base_url, verified_at, verification_method, primary_locale, created_at"#,
        SiteId::new().as_uuid(),
        tenant,
        new.platform.as_str(),
        new.base_url,
        new.primary_locale,
    )
    .fetch_one(tx.conn())
    .await?;
    row.try_into()
}

/// One site of the transaction's tenant.
pub async fn get(tx: &mut TenantTx, id: SiteId) -> Result<Option<Site>, DbError> {
    let tenant = tx.tenant_uuid();
    let row = sqlx::query_as!(
        Row,
        r#"select id, platform, base_url, verified_at, verification_method, primary_locale, created_at
             from sites where tenant_id = $1 and id = $2"#,
        tenant,
        id.as_uuid(),
    )
    .fetch_optional(tx.conn())
    .await?;
    row.map(Site::try_from).transpose()
}

/// Every site of the transaction's tenant, oldest first.
pub async fn list(tx: &mut TenantTx) -> Result<Vec<Site>, DbError> {
    let tenant = tx.tenant_uuid();
    let rows = sqlx::query_as!(
        Row,
        r#"select id, platform, base_url, verified_at, verification_method, primary_locale, created_at
             from sites where tenant_id = $1 order by created_at, id"#,
        tenant,
    )
    .fetch_all(tx.conn())
    .await?;
    rows.into_iter().map(Site::try_from).collect()
}

/// Records how ownership of a site was proven, such as `shopify_install`. `None` if the site
/// is not this tenant's.
pub async fn mark_verified(
    tx: &mut TenantTx,
    id: SiteId,
    method: &str,
) -> Result<Option<Site>, DbError> {
    let tenant = tx.tenant_uuid();
    let row = sqlx::query_as!(
        Row,
        r#"update sites set verified_at = coalesce(verified_at, now()), verification_method = $3
            where tenant_id = $1 and id = $2
        returning id, platform, base_url, verified_at, verification_method, primary_locale, created_at"#,
        tenant,
        id.as_uuid(),
        method,
    )
    .fetch_optional(tx.conn())
    .await?;
    row.map(Site::try_from).transpose()
}
