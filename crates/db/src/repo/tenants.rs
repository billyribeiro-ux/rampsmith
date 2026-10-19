//! The tenant row itself.

use domain::{TenantId, TenantKind};
use time::OffsetDateTime;

use crate::error::parse;
use crate::{DbError, TenantTx};

/// A tenant: one Shopify store or one organization.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tenant {
    /// The tenant's id, equal to the transaction's tenant.
    pub id: TenantId,
    /// What kind of tenant this is.
    pub kind: TenantKind,
    /// When it was created.
    pub created_at: OffsetDateTime,
}

/// Creates the transaction's own tenant row.
pub async fn create(tx: &mut TenantTx, kind: TenantKind) -> Result<Tenant, DbError> {
    let id = tx.tenant_uuid();
    let row = sqlx::query!(
        r#"insert into tenants (id, kind) values ($1, $2) returning id, kind, created_at"#,
        id,
        kind.as_str(),
    )
    .fetch_one(tx.conn())
    .await?;
    Ok(Tenant {
        id: TenantId::from_uuid(row.id),
        kind: parse(&row.kind, "tenants.kind")?,
        created_at: row.created_at,
    })
}

/// The transaction's own tenant, if it exists.
pub async fn get(tx: &mut TenantTx) -> Result<Option<Tenant>, DbError> {
    let id = tx.tenant_uuid();
    let row = sqlx::query!(
        r#"select id, kind, created_at from tenants where id = $1"#,
        id
    )
    .fetch_optional(tx.conn())
    .await?;
    row.map(|r| {
        Ok(Tenant {
            id: TenantId::from_uuid(r.id),
            kind: parse(&r.kind, "tenants.kind")?,
            created_at: r.created_at,
        })
    })
    .transpose()
}
