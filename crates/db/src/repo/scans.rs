//! Scans of a site.

use domain::{ScanId, ScanStatus, ScanTrigger, SiteId};
use time::OffsetDateTime;

use crate::error::parse;
use crate::{DbError, TenantTx};

/// Input for [`create`].
#[derive(Debug, Clone)]
pub struct NewScan {
    /// The site to scan; must belong to the transaction's tenant.
    pub site_id: SiteId,
    /// Why the scan runs.
    pub trigger: ScanTrigger,
    /// axe-core version plus the custom-rules hash.
    pub ruleset_version: String,
    /// The live theme or a preview theme id.
    pub theme_ref: Option<String>,
}

/// A scan owned by the transaction's tenant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Scan {
    /// The scan's id.
    pub id: ScanId,
    /// The scanned site.
    pub site_id: SiteId,
    /// The theme scanned, if not the live one.
    pub theme_ref: Option<String>,
    /// Why it ran.
    pub trigger: ScanTrigger,
    /// Where it stands.
    pub status: ScanStatus,
    /// The ruleset it used.
    pub ruleset_version: String,
    /// Pages and states planned.
    pub pages_planned: i32,
    /// Pages and states done.
    pub pages_done: i32,
    /// When it was queued.
    pub created_at: OffsetDateTime,
    /// When a worker started it.
    pub started_at: Option<OffsetDateTime>,
    /// When it finished.
    pub finished_at: Option<OffsetDateTime>,
    /// Why it failed, if it did.
    pub error_code: Option<String>,
}

struct Row {
    id: uuid::Uuid,
    site_id: uuid::Uuid,
    theme_ref: Option<String>,
    trigger: String,
    status: String,
    ruleset_version: String,
    pages_planned: i32,
    pages_done: i32,
    created_at: OffsetDateTime,
    started_at: Option<OffsetDateTime>,
    finished_at: Option<OffsetDateTime>,
    error_code: Option<String>,
}

impl TryFrom<Row> for Scan {
    type Error = DbError;

    fn try_from(r: Row) -> Result<Self, DbError> {
        Ok(Self {
            id: ScanId::from_uuid(r.id),
            site_id: SiteId::from_uuid(r.site_id),
            theme_ref: r.theme_ref,
            trigger: parse(&r.trigger, "scans.trigger")?,
            status: parse(&r.status, "scans.status")?,
            ruleset_version: r.ruleset_version,
            pages_planned: r.pages_planned,
            pages_done: r.pages_done,
            created_at: r.created_at,
            started_at: r.started_at,
            finished_at: r.finished_at,
            error_code: r.error_code,
        })
    }
}

/// Queues a scan.
pub async fn create(tx: &mut TenantTx, new: &NewScan) -> Result<Scan, DbError> {
    let tenant = tx.tenant_uuid();
    let row = sqlx::query_as!(
        Row,
        r#"insert into scans (id, tenant_id, site_id, theme_ref, trigger, status, ruleset_version)
           values ($1, $2, $3, $4, $5, 'queued', $6)
           returning id, site_id, theme_ref, trigger, status, ruleset_version, pages_planned,
                     pages_done, created_at, started_at, finished_at, error_code"#,
        ScanId::new().as_uuid(),
        tenant,
        new.site_id.as_uuid(),
        new.theme_ref,
        new.trigger.as_str(),
        new.ruleset_version,
    )
    .fetch_one(tx.conn())
    .await?;
    row.try_into()
}

/// One scan of the transaction's tenant.
pub async fn get(tx: &mut TenantTx, id: ScanId) -> Result<Option<Scan>, DbError> {
    let tenant = tx.tenant_uuid();
    let row = sqlx::query_as!(
        Row,
        r#"select id, site_id, theme_ref, trigger, status, ruleset_version, pages_planned,
                  pages_done, created_at, started_at, finished_at, error_code
             from scans where tenant_id = $1 and id = $2"#,
        tenant,
        id.as_uuid(),
    )
    .fetch_optional(tx.conn())
    .await?;
    row.map(Scan::try_from).transpose()
}

/// The latest scans of a site, newest first.
pub async fn list_for_site(
    tx: &mut TenantTx,
    site: SiteId,
    limit: i64,
) -> Result<Vec<Scan>, DbError> {
    let tenant = tx.tenant_uuid();
    let rows = sqlx::query_as!(
        Row,
        r#"select id, site_id, theme_ref, trigger, status, ruleset_version, pages_planned,
                  pages_done, created_at, started_at, finished_at, error_code
             from scans where tenant_id = $1 and site_id = $2
            order by created_at desc, id desc
            limit $3"#,
        tenant,
        site.as_uuid(),
        limit,
    )
    .fetch_all(tx.conn())
    .await?;
    rows.into_iter().map(Scan::try_from).collect()
}

/// Moves a queued scan to running with its page plan. Returns `None` when the scan does
/// not exist for this tenant or is no longer queued.
pub async fn mark_started(
    tx: &mut TenantTx,
    id: ScanId,
    pages_planned: i32,
) -> Result<Option<Scan>, DbError> {
    let tenant = tx.tenant_uuid();
    let row = sqlx::query_as!(
        Row,
        r#"update scans set status = 'running', started_at = now(), pages_planned = $3
            where tenant_id = $1 and id = $2 and status = 'queued'
        returning id, site_id, theme_ref, trigger, status, ruleset_version, pages_planned,
                  pages_done, created_at, started_at, finished_at, error_code"#,
        tenant,
        id.as_uuid(),
        pages_planned,
    )
    .fetch_optional(tx.conn())
    .await?;
    row.map(Scan::try_from).transpose()
}

/// Ends a scan that cannot continue, with a stable code. Only a scan that has not finished is
/// changed; `None` when it had, or is not the tenant's.
pub async fn fail(
    tx: &mut TenantTx,
    id: ScanId,
    error_code: &str,
) -> Result<Option<Scan>, DbError> {
    let tenant = tx.tenant_uuid();
    let row = sqlx::query_as!(
        Row,
        r#"update scans set status = 'failed', finished_at = now(), error_code = $3
            where tenant_id = $1 and id = $2 and status in ('queued', 'running')
        returning id, site_id, theme_ref, trigger, status, ruleset_version, pages_planned,
                  pages_done, created_at, started_at, finished_at, error_code"#,
        tenant,
        id.as_uuid(),
        error_code,
    )
    .fetch_optional(tx.conn())
    .await?;
    row.map(Scan::try_from).transpose()
}

/// Sets how many pages a scan will load, for a verification scan whose pages are known when it
/// is created. Only a scan that has not finished.
pub async fn set_planned(tx: &mut TenantTx, id: ScanId, pages: i32) -> Result<bool, DbError> {
    let tenant = tx.tenant_uuid();
    let done = sqlx::query!(
        r#"update scans set pages_planned = $3
            where tenant_id = $1 and id = $2 and status in ('queued', 'running')"#,
        tenant,
        id.as_uuid(),
        pages,
    )
    .execute(tx.conn())
    .await?;
    Ok(done.rows_affected() == 1)
}
