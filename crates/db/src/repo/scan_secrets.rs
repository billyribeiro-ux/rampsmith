//! The storefront password for one scan, sealed to the scan key (ADR-264).
//!
//! `ctl` reads the site's password (sealed under the master keys), re-seals it under the scan
//! key and stores it on the scan. The engine opens and clears it with plain SQL, because it is
//! TypeScript. Nothing here ever sees a plaintext: both ends are ciphertext and a key id.

use domain::{ScanId, SiteId};

use crate::{DbError, TenantTx};

/// A sealed value and the id of the key ring entry that wrapped it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SealedSecret {
    /// The key id to open it with.
    pub key_id: String,
    /// The sealed bytes (`crypto::Sealed::bytes`).
    pub bytes: Vec<u8>,
}

/// The site's saved storefront password, sealed under the master keys, when it has one.
pub async fn site_password(
    tx: &mut TenantTx,
    site: SiteId,
) -> Result<Option<SealedSecret>, DbError> {
    let tenant = tx.tenant_uuid();
    let row = sqlx::query!(
        r#"select storefront_password_ct, storefront_password_key_id
             from sites where tenant_id = $1 and id = $2"#,
        tenant,
        site.as_uuid(),
    )
    .fetch_optional(tx.conn())
    .await?;
    Ok(row.and_then(
        |r| match (r.storefront_password_ct, r.storefront_password_key_id) {
            (Some(bytes), Some(key_id)) => Some(SealedSecret { key_id, bytes }),
            _ => None,
        },
    ))
}

/// Stores the scan's sealed password, or clears it with `None`. Only a scan that has not ended
/// takes one; `false` when the scan is not the tenant's, is over, or (for clearing) does not
/// exist.
pub async fn set_scan_password(
    tx: &mut TenantTx,
    scan: ScanId,
    sealed: Option<&SealedSecret>,
) -> Result<bool, DbError> {
    let tenant = tx.tenant_uuid();
    let bytes = sealed.map(|s| s.bytes.as_slice());
    let key_id = sealed.map(|s| s.key_id.as_str());
    let done = sqlx::query!(
        r#"update scans set storefront_password_ct = $3, storefront_password_key_id = $4
            where tenant_id = $1 and id = $2
              and ($3::bytea is null or status in ('queued', 'running'))"#,
        tenant,
        scan.as_uuid(),
        bytes,
        key_id,
    )
    .execute(tx.conn())
    .await?;
    Ok(done.rows_affected() == 1)
}

/// The scan's sealed password, for tests of the hand-off. The engine reads it in SQL.
pub async fn scan_password(
    tx: &mut TenantTx,
    scan: ScanId,
) -> Result<Option<SealedSecret>, DbError> {
    let tenant = tx.tenant_uuid();
    let row = sqlx::query!(
        r#"select storefront_password_ct, storefront_password_key_id
             from scans where tenant_id = $1 and id = $2"#,
        tenant,
        scan.as_uuid(),
    )
    .fetch_optional(tx.conn())
    .await?;
    Ok(row.and_then(
        |r| match (r.storefront_password_ct, r.storefront_password_key_id) {
            (Some(bytes), Some(key_id)) => Some(SealedSecret { key_id, bytes }),
            _ => None,
        },
    ))
}
