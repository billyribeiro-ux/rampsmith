//! Which shops are due their weekly rescan (ADR-279). The function behind it runs for every
//! tenant and only the worker role may execute it; the leader then starts each scan in that
//! shop's own tenant transaction.

use domain::{ShopId, SiteId, TenantId};

use crate::{DbError, PublicTx};

/// A shop that has the weekly rescan switched on and has gone a week without a scan.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DueRescan {
    /// The shop's tenant.
    pub tenant: TenantId,
    /// The shop's site.
    pub site: SiteId,
    /// The shop.
    pub shop: ShopId,
}

/// Up to `limit` shops due a weekly rescan, in the order of their ids, after the shop `after`
/// (the last one of the previous page; `None` for the first page).
pub async fn due(
    tx: &mut PublicTx,
    after: Option<ShopId>,
    limit: i32,
) -> Result<Vec<DueRescan>, DbError> {
    let rows = sqlx::query!(
        r#"select tenant_id as "tenant_id!", site_id as "site_id!", shop_id as "shop_id!"
             from due_weekly_rescans($1, $2)"#,
        after.map(ShopId::as_uuid),
        limit,
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
