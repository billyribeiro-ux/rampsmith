//! Lookups for the GitHub channel that start before the tenant is known (ADR-290, ADR-291),
//! like [`Db::shop_by_domain`] does for Shopify.

use domain::{SiteId, TenantId};
use uuid::Uuid;

use crate::{Db, DbError};

/// The store an install state was issued to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StateOwner {
    /// The tenant.
    pub tenant: TenantId,
    /// The store's site.
    pub site: SiteId,
    /// The Shopify staff member who pressed "Connect GitHub".
    pub created_by_ref: Option<String>,
}

/// The store a GitHub installation is linked to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InstallationOwner {
    /// The tenant.
    pub tenant: TenantId,
    /// The `github_installations` row.
    pub row: Uuid,
}

impl Db {
    /// Spends an install state: the store it was issued to, or `None` when it is unknown,
    /// already spent or expired. One atomic statement, so a state works once (audit L7).
    pub async fn github_consume_state(
        &self,
        state_sha256: &[u8; 32],
    ) -> Result<Option<StateOwner>, DbError> {
        let row = sqlx::query!(
            r#"select tenant_id as "tenant_id!", site_id as "site_id!", created_by_ref
                 from app_github_consume_state($1)"#,
            state_sha256.as_slice()
        )
        .fetch_optional(self.pool())
        .await?;
        Ok(row.map(|r| StateOwner {
            tenant: TenantId::from_uuid(r.tenant_id),
            site: SiteId::from_uuid(r.site_id),
            created_by_ref: r.created_by_ref,
        }))
    }

    /// The store a GitHub installation id is linked to, across tenants. Call it only after
    /// verifying a webhook signature.
    pub async fn github_installation(
        &self,
        installation_id: i64,
    ) -> Result<Option<InstallationOwner>, DbError> {
        let row = sqlx::query!(
            r#"select tenant_id as "tenant_id!", id as "id!" from app_github_installation($1)"#,
            installation_id
        )
        .fetch_optional(self.pool())
        .await?;
        Ok(row.map(|r| InstallationOwner {
            tenant: TenantId::from_uuid(r.tenant_id),
            row: r.id,
        }))
    }
}
