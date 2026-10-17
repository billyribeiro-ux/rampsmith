//! Deduplicated findings: one rule failing at one template location (PLAN §9, §11).

use domain::{FindingId, FindingStatus, Impact, ScanId, SiteId};

use crate::error::parse;
use crate::{DbError, TenantTx};

/// One scan's observation of a failure, merged into a finding by fingerprint.
#[derive(Debug, Clone)]
pub struct Observation {
    /// The site it was seen on.
    pub site_id: SiteId,
    /// The scan that saw it.
    pub scan_id: ScanId,
    /// SHA-256 of the rule, the normalized target and the template origin.
    pub fingerprint: [u8; 32],
    /// The axe-core or custom rule id.
    pub rule_id: String,
    /// WCAG success criteria, such as `1.1.1`.
    pub criteria: Vec<String>,
    /// Severity.
    pub impact: Impact,
    /// How many pages and states showed it in this scan.
    pub occurrence_count: i32,
}

/// A finding owned by the transaction's tenant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finding {
    /// The finding's id.
    pub id: FindingId,
    /// Its site.
    pub site_id: SiteId,
    /// Its fingerprint.
    pub fingerprint: Vec<u8>,
    /// The rule that failed.
    pub rule_id: String,
    /// WCAG success criteria.
    pub criteria: Vec<String>,
    /// Severity.
    pub impact: Impact,
    /// Where it stands.
    pub status: FindingStatus,
    /// The first scan that saw it.
    pub first_seen_scan: ScanId,
    /// The latest scan that saw it.
    pub last_seen_scan: ScanId,
    /// Occurrences in the latest scan.
    pub occurrence_count: i32,
}

struct Row {
    id: uuid::Uuid,
    site_id: uuid::Uuid,
    fingerprint: Vec<u8>,
    rule_id: String,
    criteria: Vec<String>,
    impact: String,
    status: String,
    first_seen_scan: uuid::Uuid,
    last_seen_scan: uuid::Uuid,
    occurrence_count: i32,
}

impl TryFrom<Row> for Finding {
    type Error = DbError;

    fn try_from(r: Row) -> Result<Self, DbError> {
        Ok(Self {
            id: FindingId::from_uuid(r.id),
            site_id: SiteId::from_uuid(r.site_id),
            fingerprint: r.fingerprint,
            rule_id: r.rule_id,
            criteria: r.criteria,
            impact: parse(&r.impact, "findings.impact")?,
            status: parse(&r.status, "findings.status")?,
            first_seen_scan: ScanId::from_uuid(r.first_seen_scan),
            last_seen_scan: ScanId::from_uuid(r.last_seen_scan),
            occurrence_count: r.occurrence_count,
        })
    }
}

/// Records an observation. A new fingerprint creates an open finding; a known one moves
/// its last-seen scan and count forward, and a fixed finding that reappears is reopened.
/// Statuses a person chose (accepted risk, false positive, needs review) are kept.
pub async fn record(tx: &mut TenantTx, o: &Observation) -> Result<Finding, DbError> {
    let tenant = tx.tenant_uuid();
    let row = sqlx::query_as!(
        Row,
        r#"insert into findings (id, tenant_id, site_id, fingerprint, rule_id, criteria, impact,
                                 status, first_seen_scan, last_seen_scan, occurrence_count)
           values ($1, $2, $3, $4, $5, $6, $7, 'open', $8, $8, $9)
           on conflict (site_id, fingerprint) do update
              set last_seen_scan = excluded.last_seen_scan,
                  occurrence_count = excluded.occurrence_count,
                  impact = excluded.impact,
                  criteria = excluded.criteria,
                  status = case when findings.status = 'fixed' then 'open' else findings.status end
            where findings.tenant_id = excluded.tenant_id
        returning id, site_id, fingerprint, rule_id, criteria, impact, status, first_seen_scan,
                  last_seen_scan, occurrence_count"#,
        FindingId::new().as_uuid(),
        tenant,
        o.site_id.as_uuid(),
        &o.fingerprint[..],
        o.rule_id,
        &o.criteria,
        o.impact.as_str(),
        o.scan_id.as_uuid(),
        o.occurrence_count,
    )
    .fetch_one(tx.conn())
    .await?;
    row.try_into()
}

/// One finding of the transaction's tenant.
pub async fn get(tx: &mut TenantTx, id: FindingId) -> Result<Option<Finding>, DbError> {
    let tenant = tx.tenant_uuid();
    let row = sqlx::query_as!(
        Row,
        r#"select id, site_id, fingerprint, rule_id, criteria, impact, status, first_seen_scan,
                  last_seen_scan, occurrence_count
             from findings where tenant_id = $1 and id = $2"#,
        tenant,
        id.as_uuid(),
    )
    .fetch_optional(tx.conn())
    .await?;
    row.map(Finding::try_from).transpose()
}

/// Findings of a site, optionally with one status, most severe first.
pub async fn list_for_site(
    tx: &mut TenantTx,
    site: SiteId,
    status: Option<FindingStatus>,
) -> Result<Vec<Finding>, DbError> {
    let tenant = tx.tenant_uuid();
    let rows = sqlx::query_as!(
        Row,
        r#"select id, site_id, fingerprint, rule_id, criteria, impact, status, first_seen_scan,
                  last_seen_scan, occurrence_count
             from findings
            where tenant_id = $1 and site_id = $2 and ($3::text is null or status = $3)
            order by array_position(array['critical', 'serious', 'moderate', 'minor'], impact),
                     occurrence_count desc, id"#,
        tenant,
        site.as_uuid(),
        status.map(FindingStatus::as_str),
    )
    .fetch_all(tx.conn())
    .await?;
    rows.into_iter().map(Finding::try_from).collect()
}

/// Sets a finding's status. Returns `None` when it does not exist for this tenant.
pub async fn set_status(
    tx: &mut TenantTx,
    id: FindingId,
    status: FindingStatus,
) -> Result<Option<Finding>, DbError> {
    let tenant = tx.tenant_uuid();
    let row = sqlx::query_as!(
        Row,
        r#"update findings set status = $3 where tenant_id = $1 and id = $2
        returning id, site_id, fingerprint, rule_id, criteria, impact, status, first_seen_scan,
                  last_seen_scan, occurrence_count"#,
        tenant,
        id.as_uuid(),
        status.as_str(),
    )
    .fetch_optional(tx.conn())
    .await?;
    row.map(Finding::try_from).transpose()
}
