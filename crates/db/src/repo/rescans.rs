//! Which shops are due their scheduled rescan (ADR-279, ADR-312). The function behind it runs for every
//! tenant and only the worker role may execute it; the leader then starts each scan in that
//! shop's own tenant transaction.

use domain::{ShopId, SiteId, TenantId};

use crate::{DbError, PublicTx, TenantTx};

/// A shop that has scheduled rescans switched on and has gone its plan's interval without a scan.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DueRescan {
    /// The shop's tenant.
    pub tenant: TenantId,
    /// The shop's site.
    pub site: SiteId,
    /// The shop.
    pub shop: ShopId,
}

/// Up to `limit` shops due a scheduled rescan at their plan's cadence, fairly across tenants: no
/// tenant has more than `per_tenant` of them, and every tenant's most overdue shop comes before
/// any tenant's second (ADR-312).
pub async fn due(
    tx: &mut PublicTx,
    limit: i32,
    per_tenant: i32,
) -> Result<Vec<DueRescan>, DbError> {
    let rows = sqlx::query!(
        r#"select tenant_id as "tenant_id!", site_id as "site_id!", shop_id as "shop_id!"
             from due_scheduled_rescans($1, $2)"#,
        limit,
        per_tenant,
    )
    .fetch_all(tx.conn())
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| DueRescan {
            tenant: TenantId::from_uuid(row.tenant_id),
            site: SiteId::from_uuid(row.site_id),
            shop: ShopId::from_uuid(row.shop_id),
        })
        .collect())
}

/// Whether `shop` is still due, asked inside its own tenant transaction under the site's lock.
/// Two leaders that listed the shop in the same round both ask this; only the first, which
/// creates the scan, sees `true`, so a period gets one scheduled scan.
pub async fn still_due(tx: &mut TenantTx, shop: ShopId) -> Result<bool, DbError> {
    let tenant = tx.tenant_uuid();
    Ok(sqlx::query_scalar!(
        r#"select exists (select 1 from due_scheduled_rescans(1, 1, $2)
                           where tenant_id = $1) as "due!""#,
        tenant,
        shop.as_uuid(),
    )
    .fetch_one(tx.conn())
    .await?)
}
