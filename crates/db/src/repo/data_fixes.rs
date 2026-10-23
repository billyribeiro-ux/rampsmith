//! The data-fix lifecycle `ctl` runs after approval (ADR-082): snapshot, apply, undo.
//!
//! State machine of `fixes.status` for a data fix, and who moves it:
//!
//! ```text
//! proposed --approve (api)--> approved --begin_apply--> applying --finish_apply--> applied
//!    |                            |                         |                        |
//!    +--reject (api)             +------------ fail --------+                  finish_revert
//!                                             v                                      v
//!                                           failed                               reverted
//! ```
//!
//! `applied` becomes `verified` in the engine (`verify.scan`). Every move is a conditional
//! update, so two workers racing on one fix cannot both win.

use domain::{FixId, FixKind, FixStatus, SiteId};
use serde_json::Value;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::error::parse;
use crate::{DbError, TenantTx};

/// A data fix with what `ctl` needs to apply or undo it.
#[derive(Debug, Clone, PartialEq)]
pub struct DataFix {
    /// The fix's id.
    pub id: FixId,
    /// Its site.
    pub site_id: SiteId,
    /// Data or code; `ctl` refuses anything but data.
    pub kind: FixKind,
    /// Where it stands.
    pub status: FixStatus,
    /// The Rampsmith user who approved it, if a Rampsmith user did.
    pub approved_by: Option<Uuid>,
    /// The Shopify staff member who approved it in the embedded app, if one did.
    pub approved_by_ref: Option<String>,
    /// When it was approved.
    pub approved_at: Option<OffsetDateTime>,
    /// When it was applied.
    pub applied_at: Option<OffsetDateTime>,
    /// The diff the proposal stored.
    pub diff: Option<Value>,
    /// The resource that owns the field (a product for an image), from the first finding.
    pub owner: Option<String>,
}

/// The values around a data fix: what the field held when it was proposed and what it will hold.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    /// The GID of the resource that is changed.
    pub resource_gid: String,
    /// The field, such as `alt`.
    pub field: String,
    /// The value before: JSON `null` when the field was unset, else a string.
    pub before_value: Value,
    /// The value after: a string.
    pub after_value: Value,
}

struct Row {
    id: Uuid,
    site_id: Uuid,
    kind: String,
    status: String,
    approved_by: Option<Uuid>,
    approved_by_ref: Option<String>,
    approved_at: Option<OffsetDateTime>,
    applied_at: Option<OffsetDateTime>,
    diff: Option<Value>,
    owner: Option<String>,
}

/// One fix of the transaction's tenant.
pub async fn get(tx: &mut TenantTx, id: FixId) -> Result<Option<DataFix>, DbError> {
    let tenant = tx.tenant_uuid();
    let row = sqlx::query_as!(
        Row,
        r#"select f.id, f.site_id, f.kind, f.status, f.approved_by, f.approved_by_ref,
                  f.approved_at, f.applied_at, f.diff,
                  (select x.source_location ->> 'owner'
                     from fix_findings ff
                     join findings x on x.id = ff.finding_id and x.tenant_id = ff.tenant_id
                    where ff.tenant_id = f.tenant_id and ff.fix_id = f.id
                    order by ff.finding_id limit 1) as "owner"
             from fixes f where f.tenant_id = $1 and f.id = $2"#,
        tenant,
        id.as_uuid(),
    )
    .fetch_optional(tx.conn())
    .await?;
    row.map(|r| {
        Ok(DataFix {
            id: FixId::from_uuid(r.id),
            site_id: SiteId::from_uuid(r.site_id),
            kind: parse(&r.kind, "fixes.kind")?,
            status: parse(&r.status, "fixes.status")?,
            approved_by: r.approved_by,
            approved_by_ref: r.approved_by_ref,
            approved_at: r.approved_at,
            applied_at: r.applied_at,
            diff: r.diff,
            owner: r.owner,
        })
    })
    .transpose()
}

/// The snapshot of a fix.
pub async fn snapshot(tx: &mut TenantTx, id: FixId) -> Result<Option<Snapshot>, DbError> {
    let tenant = tx.tenant_uuid();
    let row = sqlx::query!(
        r#"select resource_gid, field, before_value, after_value
             from data_fix_snapshots where tenant_id = $1 and fix_id = $2"#,
        tenant,
        id.as_uuid(),
    )
    .fetch_optional(tx.conn())
    .await?;
    Ok(row.map(|r| Snapshot {
        resource_gid: r.resource_gid,
        field: r.field,
        before_value: r.before_value,
        after_value: r.after_value,
    }))
}

/// Stores the snapshot unless one exists (the proposal usually wrote it). Returns whether this
/// call wrote it. The fix must be the tenant's.
pub async fn put_snapshot(
    tx: &mut TenantTx,
    id: FixId,
    snapshot: &Snapshot,
) -> Result<bool, DbError> {
    let tenant = tx.tenant_uuid();
    let done = sqlx::query!(
        r#"insert into data_fix_snapshots (fix_id, tenant_id, resource_gid, field, before_value,
                                           after_value)
           select $2, $1, $3, $4, $5, $6
            where exists (select 1 from fixes where tenant_id = $1 and id = $2)
           on conflict (fix_id) do nothing"#,
        tenant,
        id.as_uuid(),
        snapshot.resource_gid,
        snapshot.field,
        snapshot.before_value,
        snapshot.after_value,
    )
    .execute(tx.conn())
    .await?;
    Ok(done.rows_affected() == 1)
}

/// `approved` to `applying`. `false` when the fix was not `approved`.
pub async fn begin_apply(tx: &mut TenantTx, id: FixId) -> Result<bool, DbError> {
    let tenant = tx.tenant_uuid();
    let done = sqlx::query!(
        r#"update fixes set status = 'applying', error_code = null
            where tenant_id = $1 and id = $2 and kind = 'data' and status = 'approved'"#,
        tenant,
        id.as_uuid(),
    )
    .execute(tx.conn())
    .await?;
    Ok(done.rows_affected() == 1)
}

/// `approved` or `applying` to `applied`. `false` when it was neither.
pub async fn finish_apply(tx: &mut TenantTx, id: FixId) -> Result<bool, DbError> {
    let tenant = tx.tenant_uuid();
    let done = sqlx::query!(
        r#"update fixes set status = 'applied', applied_at = now(), error_code = null
            where tenant_id = $1 and id = $2 and status in ('approved', 'applying')"#,
        tenant,
        id.as_uuid(),
    )
    .execute(tx.conn())
    .await?;
    Ok(done.rows_affected() == 1)
}

/// `approved` or `applying` to `failed`, with a stable code. `false` when it was neither.
pub async fn fail(tx: &mut TenantTx, id: FixId, code: &str) -> Result<bool, DbError> {
    let tenant = tx.tenant_uuid();
    let done = sqlx::query!(
        r#"update fixes set status = 'failed', error_code = $3
            where tenant_id = $1 and id = $2 and status in ('approved', 'applying')"#,
        tenant,
        id.as_uuid(),
        code,
    )
    .execute(tx.conn())
    .await?;
    Ok(done.rows_affected() == 1)
}

/// Fails every fix of the tenant that was approved or being applied, with `code`, because the
/// shop is gone and nothing can write to it any more. Returns how many it ended (lane A audit
/// L2: such a fix would otherwise sit in `approved` or `applying` for ever).
pub async fn fail_in_flight(tx: &mut TenantTx, code: &str) -> Result<u64, DbError> {
    let tenant = tx.tenant_uuid();
    let done = sqlx::query!(
        r#"update fixes set status = 'failed', error_code = $2
            where tenant_id = $1 and status in ('approved', 'applying')"#,
        tenant,
        code,
    )
    .execute(tx.conn())
    .await?;
    Ok(done.rows_affected())
}

/// Cancels the fix's `verify.scan` job if it has not started. An undo calls this in its own
/// transaction so a verification queued after the apply does not run against a fix that is
/// no longer in the shop (lane A audit L3; the engine also refuses to close findings for a fix
/// that is not `applied`, which covers a verification already running). Returns how many jobs
/// it cancelled.
pub async fn cancel_verification(tx: &mut TenantTx, id: FixId) -> Result<u64, DbError> {
    let tenant = tx.tenant_uuid();
    let key = format!("verify.scan:{id}");
    let done = sqlx::query!(
        r#"update jobs set state = 'cancelled', finished_at = now()
            where tenant_id = $1 and idempotency_key = $2 and state = 'ready'"#,
        tenant,
        key,
    )
    .execute(tx.conn())
    .await?;
    Ok(done.rows_affected())
}

/// `applied` or `verified` to `reverted`. `false` when it was neither.
pub async fn finish_revert(tx: &mut TenantTx, id: FixId) -> Result<bool, DbError> {
    let tenant = tx.tenant_uuid();
    let done = sqlx::query!(
        r#"update fixes set status = 'reverted', reverted_at = now(), error_code = null
            where tenant_id = $1 and id = $2 and status in ('applied', 'verified')"#,
        tenant,
        id.as_uuid(),
    )
    .execute(tx.conn())
    .await?;
    Ok(done.rows_affected() == 1)
}

/// Opens again the findings the fix had closed. Returns how many.
pub async fn reopen_findings(tx: &mut TenantTx, id: FixId) -> Result<u64, DbError> {
    let tenant = tx.tenant_uuid();
    let done = sqlx::query!(
        r#"update findings set status = 'open'
            where tenant_id = $1 and status = 'fixed'
              and id in (select finding_id from fix_findings
                          where tenant_id = $1 and fix_id = $2)"#,
        tenant,
        id.as_uuid(),
    )
    .execute(tx.conn())
    .await?;
    Ok(done.rows_affected())
}

/// Approval from the embedded app: a Shopify staff member, recorded by their session `sub`
/// (ADR-082). `None` when the fix is not the tenant's or not `proposed`.
pub async fn approve_by_ref(
    tx: &mut TenantTx,
    id: FixId,
    approver_ref: &str,
) -> Result<Option<OffsetDateTime>, DbError> {
    let tenant = tx.tenant_uuid();
    let at = sqlx::query_scalar!(
        r#"update fixes set status = 'approved', approved_by_ref = $3, approved_at = now()
            where tenant_id = $1 and id = $2 and kind = 'data' and status = 'proposed'
        returning approved_at as "approved_at!""#,
        tenant,
        id.as_uuid(),
        approver_ref,
    )
    .fetch_optional(tx.conn())
    .await?;
    Ok(at)
}

/// The ruleset the site's latest scan used, for a verification scan to carry.
pub async fn latest_ruleset(tx: &mut TenantTx, site: SiteId) -> Result<Option<String>, DbError> {
    let tenant = tx.tenant_uuid();
    Ok(sqlx::query_scalar!(
        r#"select ruleset_version from scans
            where tenant_id = $1 and site_id = $2 order by created_at desc limit 1"#,
        tenant,
        site.as_uuid(),
    )
    .fetch_optional(tx.conn())
    .await?)
}
