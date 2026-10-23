//! `shop/redact`: delete all of a shop's data (PLAN §19; ADR-080).
//!
//! Keeps what the law or the product's own integrity needs and nothing a merchant or a
//! shopper put into the store:
//!
//! - the tenant, site and shop rows, with the shop's token, scopes, primary domain and
//!   locales removed and its status `redacted` (so a repeated `shop/redact` is recognised and a
//!   later reinstall of the same domain starts clean through `reinstall`);
//! - the append-only audit log, which never holds tokens or personal data (and which the
//!   database refuses to change);
//! - the webhook digests, so a replay of this very request is recognised.

use domain::ShopId;
use serde::Serialize;

use crate::{DbError, TenantTx};

/// How many rows each step removed. Counts only, for the audit entry.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct Redacted {
    /// Applied-fix snapshots (the values before and after, which are store content).
    pub snapshots: u64,
    /// Fixes and their finding links.
    pub fixes: u64,
    /// Findings and their occurrences.
    pub findings: u64,
    /// Scans, their pages and the store data read for them.
    pub scans: u64,
    /// Evidence crops.
    pub evidence: u64,
    /// Statements, AI call records and budgets.
    pub other: u64,
    /// Stored webhook bodies of other events.
    pub webhooks: u64,
}

/// Deletes the tenant's data for `shop` and marks the shop `redacted`. Returns `None` when
/// the shop is not this tenant's. Idempotent: running it again removes nothing and returns
/// zero counts.
pub async fn shop(tx: &mut TenantTx, shop: ShopId) -> Result<Option<Redacted>, DbError> {
    let tenant = tx.tenant_uuid();
    let exists = sqlx::query_scalar!(
        r#"select exists (select 1 from shopify_shops where tenant_id = $1 and id = $2) as "e!""#,
        tenant,
        shop.as_uuid(),
    )
    .fetch_one(tx.conn())
    .await?;
    if !exists {
        return Ok(None);
    }
    let snapshots = sqlx::query!(
        "delete from data_fix_snapshots where tenant_id = $1",
        tenant
    )
    .execute(tx.conn())
    .await?
    .rows_affected();
    sqlx::query!("delete from fix_findings where tenant_id = $1", tenant)
        .execute(tx.conn())
        .await?;
    // Fixes point at each other (`reverts`) and at evidence; one statement removes them all.
    let fixes = sqlx::query!("delete from fixes where tenant_id = $1", tenant)
        .execute(tx.conn())
        .await?
        .rows_affected();
    let evidence = sqlx::query!("delete from evidence where tenant_id = $1", tenant)
        .execute(tx.conn())
        .await?
        .rows_affected();
    sqlx::query!(
        "delete from finding_occurrences where tenant_id = $1",
        tenant
    )
    .execute(tx.conn())
    .await?;
    let findings = sqlx::query!("delete from findings where tenant_id = $1", tenant)
        .execute(tx.conn())
        .await?
        .rows_affected();
    sqlx::query!("delete from scan_inputs where tenant_id = $1", tenant)
        .execute(tx.conn())
        .await?;
    sqlx::query!("delete from scan_pages where tenant_id = $1", tenant)
        .execute(tx.conn())
        .await?;
    let scans = sqlx::query!("delete from scans where tenant_id = $1", tenant)
        .execute(tx.conn())
        .await?
        .rows_affected();
    let other = sqlx::query!("delete from statements where tenant_id = $1", tenant)
        .execute(tx.conn())
        .await?
        .rows_affected()
        + sqlx::query!("delete from ai_reservations where tenant_id = $1", tenant)
            .execute(tx.conn())
            .await?
            .rows_affected()
        + sqlx::query!("delete from ai_budgets where tenant_id = $1", tenant)
            .execute(tx.conn())
            .await?
            .rows_affected()
        // Only `ctl`'s role may delete call records, and only through this function (audit L7).
        + u64::try_from(
            sqlx::query_scalar!(r#"select redact_ai_calls() as "n!""#)
                .fetch_one(tx.conn())
                .await?,
        )
        .unwrap_or(0);
    // Payloads can carry store content; the rows stay as the queue's own history.
    sqlx::query!(
        "update jobs set payload = '{}'::jsonb where tenant_id = $1 and payload <> '{}'::jsonb",
        tenant
    )
    .execute(tx.conn())
    .await?;
    // Other events' bodies can hold store content; their digests stay for replay detection.
    let webhooks = sqlx::query!(
        "update webhook_events set body = null where tenant_id = $1 and body is not null",
        tenant
    )
    .execute(tx.conn())
    .await?
    .rows_affected();
    close_shop(tx, tenant, shop).await?;
    Ok(Some(Redacted {
        snapshots,
        fixes,
        findings,
        scans,
        evidence,
        other,
        webhooks,
    }))
}

/// Removes the shop's credentials and settings and marks it `redacted`.
async fn close_shop(tx: &mut TenantTx, tenant: uuid::Uuid, shop: ShopId) -> Result<(), DbError> {
    sqlx::query!("delete from shopify_tokens where tenant_id = $1", tenant)
        .execute(tx.conn())
        .await?;
    sqlx::query!(
        r#"update sites set settings = '{}'::jsonb, storefront_password_ct = null,
                            storefront_password_key_id = null
            where tenant_id = $1"#,
        tenant
    )
    .execute(tx.conn())
    .await?;
    sqlx::query!(
        r#"update shopify_shops
              set status = 'redacted', scopes = '{}', primary_domain = null, locales = '{}',
                  shop_gid = null, synced_at = null, uninstalled_at = coalesce(uninstalled_at, now())
            where tenant_id = $1 and id = $2"#,
        tenant,
        shop.as_uuid(),
    )
    .execute(tx.conn())
    .await?;
    Ok(())
}
