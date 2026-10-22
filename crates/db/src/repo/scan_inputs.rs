//! Store data `ctl` read for the engine (ADR-035, ADR-081).

use domain::{ScanId, SiteId};
use serde_json::Value;
use uuid::Uuid;

use crate::{DbError, TenantTx};

/// The kinds the table accepts.
pub const KINDS: [&str; 7] = [
    "shop",
    "products",
    "collections",
    "pages",
    "articles",
    "menus",
    "verify",
];

/// Stores one batch for `scan` and returns its id. Storing the same `(scan, kind, seq)` again
/// replaces the payload and keeps the id, so a retried read creates no second row and the
/// `audit.data` job keyed on the id stays one job. `None` when the scan or site is not the
/// tenant's.
pub async fn put(
    tx: &mut TenantTx,
    scan: ScanId,
    site: SiteId,
    kind: &str,
    seq: i32,
    payload: &Value,
) -> Result<Option<Uuid>, DbError> {
    let tenant = tx.tenant_uuid();
    let belongs = sqlx::query_scalar!(
        r#"select exists (select 1 from scans
                           where tenant_id = $1 and id = $2 and site_id = $3) as "e!""#,
        tenant,
        scan.as_uuid(),
        site.as_uuid(),
    )
    .fetch_one(tx.conn())
    .await?;
    if !belongs {
        return Ok(None);
    }
    let id = sqlx::query_scalar!(
        r#"insert into scan_inputs (id, tenant_id, scan_id, site_id, kind, seq, payload)
           values ($1, $2, $3, $4, $5, $6, $7)
           on conflict (scan_id, kind, seq) do update set payload = excluded.payload
        returning id"#,
        Uuid::now_v7(),
        tenant,
        scan.as_uuid(),
        site.as_uuid(),
        kind,
        seq,
        payload,
    )
    .fetch_one(tx.conn())
    .await?;
    Ok(Some(id))
}

/// How many batches of `kind` the scan has stored.
pub async fn count(tx: &mut TenantTx, scan: ScanId, kind: &str) -> Result<i64, DbError> {
    let tenant = tx.tenant_uuid();
    Ok(sqlx::query_scalar!(
        r#"select count(*) as "n!" from scan_inputs
            where tenant_id = $1 and scan_id = $2 and kind = $3"#,
        tenant,
        scan.as_uuid(),
        kind,
    )
    .fetch_one(tx.conn())
    .await?)
}
