//! Where a finding was seen: one row per page, state and scan, partitioned by month.

use domain::{FindingId, PageState, ScanId};
use time::OffsetDateTime;

use crate::error::parse;
use crate::{DbError, TenantTx};

/// One sighting of a finding. `html_excerpt` must already be truncated to 512 characters
/// and scrubbed of personal data by the engine (PLAN §9).
#[derive(Debug, Clone)]
pub struct NewOccurrence {
    /// The finding seen.
    pub finding_id: FindingId,
    /// The scan that saw it.
    pub scan_id: ScanId,
    /// The page URL.
    pub page_url: String,
    /// The interactive state the page was in.
    pub page_state: PageState,
    /// CSS selector path from axe.
    pub target: String,
    /// Scrubbed HTML, at most 512 characters.
    pub html_excerpt: String,
    /// When it was captured; selects the monthly partition.
    pub captured_at: OffsetDateTime,
}

/// A stored sighting.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Occurrence {
    /// The finding seen.
    pub finding_id: FindingId,
    /// The scan that saw it.
    pub scan_id: ScanId,
    /// The page URL.
    pub page_url: String,
    /// The interactive state.
    pub page_state: PageState,
    /// CSS selector path.
    pub target: String,
    /// Scrubbed HTML excerpt.
    pub html_excerpt: String,
    /// When it was captured.
    pub captured_at: OffsetDateTime,
}

/// Inserts sightings in one statement. Returns how many rows were written.
pub async fn insert(tx: &mut TenantTx, rows: &[NewOccurrence]) -> Result<u64, DbError> {
    let tenant = tx.tenant_uuid();
    let finding_ids: Vec<uuid::Uuid> = rows.iter().map(|r| r.finding_id.as_uuid()).collect();
    let scan_ids: Vec<uuid::Uuid> = rows.iter().map(|r| r.scan_id.as_uuid()).collect();
    let urls: Vec<&str> = rows.iter().map(|r| r.page_url.as_str()).collect();
    let states: Vec<&str> = rows.iter().map(|r| r.page_state.as_str()).collect();
    let targets: Vec<&str> = rows.iter().map(|r| r.target.as_str()).collect();
    let excerpts: Vec<&str> = rows.iter().map(|r| r.html_excerpt.as_str()).collect();
    let captured: Vec<OffsetDateTime> = rows.iter().map(|r| r.captured_at).collect();
    let result = sqlx::query!(
        r#"insert into finding_occurrences
             (finding_id, scan_id, tenant_id, page_url, page_state, target, html_excerpt, captured_at)
           select f, s, $1, u, st, t, e, c
             from unnest($2::uuid[], $3::uuid[], $4::text[], $5::text[], $6::text[], $7::text[],
                         $8::timestamptz[]) as x(f, s, u, st, t, e, c)"#,
        tenant,
        &finding_ids,
        &scan_ids,
        &urls as &[&str],
        &states as &[&str],
        &targets as &[&str],
        &excerpts as &[&str],
        &captured,
    )
    .execute(tx.conn())
    .await?;
    Ok(result.rows_affected())
}

/// The latest sightings of a finding, newest first.
pub async fn list_for_finding(
    tx: &mut TenantTx,
    finding: FindingId,
    limit: i64,
) -> Result<Vec<Occurrence>, DbError> {
    let tenant = tx.tenant_uuid();
    let rows = sqlx::query!(
        r#"select finding_id, scan_id, page_url, page_state, target, html_excerpt, captured_at
             from finding_occurrences
            where tenant_id = $1 and finding_id = $2
            order by captured_at desc
            limit $3"#,
        tenant,
        finding.as_uuid(),
        limit,
    )
    .fetch_all(tx.conn())
    .await?;
    rows.into_iter()
        .map(|r| {
            Ok(Occurrence {
                finding_id: FindingId::from_uuid(r.finding_id),
                scan_id: ScanId::from_uuid(r.scan_id),
                page_url: r.page_url,
                page_state: parse(&r.page_state, "finding_occurrences.page_state")?,
                target: r.target,
                html_excerpt: r.html_excerpt,
                captured_at: r.captured_at,
            })
        })
        .collect()
}
