//! What the app shows about regressions (ADR-310, ADR-311): the records the engine writes after
//! each scheduled scan is compared with the one before. Every function filters by the
//! transaction's tenant and by the site, on top of row-level security. The engine writes the
//! rows; the api reads them and records a dismissal.

use domain::SiteId;
use serde_json::Value;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::{DbError, TenantTx};

/// One regression record: the comparison of a scheduled scan with the scan before it.
#[derive(Debug, Clone, PartialEq)]
pub struct RegressionRow {
    /// The record's id.
    pub id: Uuid,
    /// The scan that was compared.
    pub scan_id: Uuid,
    /// The scan it was compared with, when there was one.
    pub previous_scan_id: Option<Uuid>,
    /// Open findings never seen before this scan.
    pub new_count: i32,
    /// Findings that were seen earlier, absent from the previous scan and are open again.
    pub reappeared_count: i32,
    /// Findings this scan recorded.
    pub findings_seen: i32,
    /// Findings the previous scan recorded.
    pub previous_findings_seen: Option<i32>,
    /// Checks passed over checks run in this scan, as a percentage.
    pub pass_rate: Option<f64>,
    /// The same for the previous scan.
    pub previous_pass_rate: Option<f64>,
    /// The first findings, most severe first (`finding_id`, `rule_id`, `impact`, `criteria`,
    /// `kind`).
    pub items: Value,
    /// When the comparison ran.
    pub detected_at: OffsetDateTime,
    /// When the merchant dismissed the banner.
    pub dismissed_at: Option<OffsetDateTime>,
}

const SELECT: &str = r#"select id, scan_id, previous_scan_id, new_count, reappeared_count,
       findings_seen, previous_findings_seen, pass_rate::float8 as pass_rate,
       previous_pass_rate::float8 as previous_pass_rate, items, detected_at, dismissed_at
  from regressions"#;

type Row = (
    Uuid,
    Uuid,
    Option<Uuid>,
    i32,
    i32,
    i32,
    Option<i32>,
    Option<f64>,
    Option<f64>,
    Value,
    OffsetDateTime,
    Option<OffsetDateTime>,
);

fn row(r: Row) -> RegressionRow {
    RegressionRow {
        id: r.0,
        scan_id: r.1,
        previous_scan_id: r.2,
        new_count: r.3,
        reappeared_count: r.4,
        findings_seen: r.5,
        previous_findings_seen: r.6,
        pass_rate: r.7,
        previous_pass_rate: r.8,
        items: r.9,
        detected_at: r.10,
        dismissed_at: r.11,
    }
}

/// The site's regression records that found something, newest first.
pub async fn list(
    tx: &mut TenantTx,
    site: SiteId,
    limit: i64,
) -> Result<Vec<RegressionRow>, DbError> {
    let tenant = tx.tenant_uuid();
    let sql = format!(
        "{SELECT} where tenant_id = $1 and site_id = $2 and new_count + reappeared_count > 0
          order by detected_at desc, id desc limit $3"
    );
    let rows: Vec<Row> = sqlx::query_as(sqlx::AssertSqlSafe(sql))
        .bind(tenant)
        .bind(site.as_uuid())
        .bind(limit)
        .fetch_all(tx.conn())
        .await?;
    Ok(rows.into_iter().map(row).collect())
}

/// One record of the site.
pub async fn get(
    tx: &mut TenantTx,
    site: SiteId,
    id: Uuid,
) -> Result<Option<RegressionRow>, DbError> {
    let tenant = tx.tenant_uuid();
    let sql = format!("{SELECT} where tenant_id = $1 and site_id = $2 and id = $3");
    let found: Option<Row> = sqlx::query_as(sqlx::AssertSqlSafe(sql))
        .bind(tenant)
        .bind(site.as_uuid())
        .bind(id)
        .fetch_optional(tx.conn())
        .await?;
    Ok(found.map(row))
}

/// The newest record of the site that found something, when it is still undismissed and was
/// detected within `within_days`: what the overview's banner shows.
pub async fn banner(
    tx: &mut TenantTx,
    site: SiteId,
    within_days: i32,
) -> Result<Option<RegressionRow>, DbError> {
    let tenant = tx.tenant_uuid();
    let sql = format!(
        "{SELECT} where tenant_id = $1 and site_id = $2 and new_count + reappeared_count > 0
            and dismissed_at is null and detected_at > now() - make_interval(days => $3)
          order by detected_at desc, id desc limit 1"
    );
    let found: Option<Row> = sqlx::query_as(sqlx::AssertSqlSafe(sql))
        .bind(tenant)
        .bind(site.as_uuid())
        .bind(within_days)
        .fetch_optional(tx.conn())
        .await?;
    Ok(found.map(row))
}

/// Hides the banner for a record. `false` when the record is not the site's.
pub async fn dismiss(tx: &mut TenantTx, site: SiteId, id: Uuid) -> Result<bool, DbError> {
    let tenant = tx.tenant_uuid();
    let done = sqlx::query!(
        r#"update regressions set dismissed_at = coalesce(dismissed_at, now())
            where tenant_id = $1 and site_id = $2 and id = $3"#,
        tenant,
        site.as_uuid(),
        id,
    )
    .execute(tx.conn())
    .await?;
    Ok(done.rows_affected() == 1)
}
