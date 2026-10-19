//! Fixes and the findings they resolve (PLAN §5 "what each fix must carry").

use domain::{FindingId, FixChannel, FixId, FixKind, FixOrigin, FixStatus, SiteId, UserId};
use serde_json::Value;
use time::OffsetDateTime;

use crate::error::parse;
use crate::{DbError, TenantTx};

/// Input for [`propose`].
#[derive(Debug, Clone)]
pub struct NewFix {
    /// The site the fix applies to.
    pub site_id: SiteId,
    /// Data or code.
    pub kind: FixKind,
    /// How it will reach the store; must carry `kind`.
    pub channel: FixChannel,
    /// Who wrote it.
    pub origin: FixOrigin,
    /// The model, required when `origin` is AI.
    pub model: Option<String>,
    /// The prompt version, required when `origin` is AI.
    pub prompt_version: Option<String>,
    /// Confidence between 0 and 1, stored to three decimals.
    pub confidence: Option<f64>,
    /// For data fixes: `{resource, field, before, after}`.
    pub diff: Option<Value>,
    /// The findings this fix resolves; each must belong to the tenant.
    pub finding_ids: Vec<FindingId>,
}

/// A fix owned by the transaction's tenant.
#[derive(Debug, Clone, PartialEq)]
pub struct Fix {
    /// The fix's id.
    pub id: FixId,
    /// Its site.
    pub site_id: SiteId,
    /// Data or code.
    pub kind: FixKind,
    /// Its channel.
    pub channel: FixChannel,
    /// Where it stands.
    pub status: FixStatus,
    /// Who wrote it.
    pub origin: FixOrigin,
    /// The model, for AI fixes.
    pub model: Option<String>,
    /// The prompt version, for AI fixes.
    pub prompt_version: Option<String>,
    /// Confidence between 0 and 1.
    pub confidence: Option<f64>,
    /// The data diff.
    pub diff: Option<Value>,
    /// R2 key of the code patch.
    pub patch_key: Option<String>,
    /// Who approved it.
    pub approved_by: Option<UserId>,
    /// When it was approved.
    pub approved_at: Option<OffsetDateTime>,
    /// When it was applied.
    pub applied_at: Option<OffsetDateTime>,
    /// When it was proposed.
    pub created_at: OffsetDateTime,
    /// The findings it resolves.
    pub finding_ids: Vec<FindingId>,
}

struct Row {
    id: uuid::Uuid,
    site_id: uuid::Uuid,
    kind: String,
    channel: String,
    status: String,
    origin: String,
    model: Option<String>,
    prompt_version: Option<String>,
    confidence: Option<f64>,
    diff: Option<Value>,
    patch_key: Option<String>,
    approved_by: Option<uuid::Uuid>,
    approved_at: Option<OffsetDateTime>,
    applied_at: Option<OffsetDateTime>,
    created_at: OffsetDateTime,
    finding_ids: Vec<uuid::Uuid>,
}

impl TryFrom<Row> for Fix {
    type Error = DbError;

    fn try_from(r: Row) -> Result<Self, DbError> {
        Ok(Self {
            id: FixId::from_uuid(r.id),
            site_id: SiteId::from_uuid(r.site_id),
            kind: parse(&r.kind, "fixes.kind")?,
            channel: parse(&r.channel, "fixes.channel")?,
            status: parse(&r.status, "fixes.status")?,
            origin: parse(&r.origin, "fixes.origin")?,
            model: r.model,
            prompt_version: r.prompt_version,
            confidence: r.confidence,
            diff: r.diff,
            patch_key: r.patch_key,
            approved_by: r.approved_by.map(UserId::from_uuid),
            approved_at: r.approved_at,
            applied_at: r.applied_at,
            created_at: r.created_at,
            finding_ids: r
                .finding_ids
                .into_iter()
                .map(FindingId::from_uuid)
                .collect(),
        })
    }
}

fn validate(new: &NewFix) -> Result<(), DbError> {
    if !new.channel.carries(new.kind) {
        return Err(DbError::Invalid(format!(
            "a {} fix cannot ship through {}",
            new.kind, new.channel
        )));
    }
    let names_model = new.model.is_some() && new.prompt_version.is_some();
    if (new.origin == FixOrigin::Ai) != names_model {
        return Err(DbError::Invalid(
            "an AI fix must name its model and prompt version, and only an AI fix may".to_owned(),
        ));
    }
    if new.confidence.is_some_and(|c| !(0.0..=1.0).contains(&c)) {
        return Err(DbError::Invalid(
            "confidence must be between 0 and 1".to_owned(),
        ));
    }
    Ok(())
}

/// Proposes a fix and links it to the findings it resolves.
pub async fn propose(tx: &mut TenantTx, new: &NewFix) -> Result<Fix, DbError> {
    validate(new)?;
    let tenant = tx.tenant_uuid();
    let id = FixId::new().as_uuid();
    sqlx::query!(
        r#"insert into fixes (id, tenant_id, site_id, kind, channel, status, origin, model,
                              prompt_version, confidence, diff)
           values ($1, $2, $3, $4, $5, 'proposed', $6, $7, $8, $9::float8::numeric(4, 3), $10)"#,
        id,
        tenant,
        new.site_id.as_uuid(),
        new.kind.as_str(),
        new.channel.as_str(),
        new.origin.as_str(),
        new.model,
        new.prompt_version,
        new.confidence,
        new.diff,
    )
    .execute(tx.conn())
    .await?;
    let finding_ids: Vec<uuid::Uuid> = new.finding_ids.iter().map(|f| f.as_uuid()).collect();
    sqlx::query!(
        r#"insert into fix_findings (fix_id, finding_id, tenant_id)
           select $1, f, $2 from unnest($3::uuid[]) as f"#,
        id,
        tenant,
        &finding_ids,
    )
    .execute(tx.conn())
    .await?;
    get(tx, FixId::from_uuid(id))
        .await?
        .ok_or(DbError::Corrupt {
            what: "fixes row after insert",
        })
}

/// One fix of the transaction's tenant, with its findings.
pub async fn get(tx: &mut TenantTx, id: FixId) -> Result<Option<Fix>, DbError> {
    let tenant = tx.tenant_uuid();
    let row = sqlx::query_as!(
        Row,
        r#"select f.id, f.site_id, f.kind, f.channel, f.status, f.origin, f.model, f.prompt_version,
                  f.confidence::float8 as "confidence", f.diff, f.patch_key, f.approved_by,
                  f.approved_at, f.applied_at, f.created_at,
                  array(select ff.finding_id from fix_findings ff
                         where ff.tenant_id = f.tenant_id and ff.fix_id = f.id
                         order by ff.finding_id) as "finding_ids!"
             from fixes f where f.tenant_id = $1 and f.id = $2"#,
        tenant,
        id.as_uuid(),
    )
    .fetch_optional(tx.conn())
    .await?;
    row.map(Fix::try_from).transpose()
}

/// Fixes linked to a finding, newest first.
pub async fn list_for_finding(tx: &mut TenantTx, finding: FindingId) -> Result<Vec<Fix>, DbError> {
    let tenant = tx.tenant_uuid();
    let rows = sqlx::query_as!(
        Row,
        r#"select f.id, f.site_id, f.kind, f.channel, f.status, f.origin, f.model, f.prompt_version,
                  f.confidence::float8 as "confidence", f.diff, f.patch_key, f.approved_by,
                  f.approved_at, f.applied_at, f.created_at,
                  array(select ff.finding_id from fix_findings ff
                         where ff.tenant_id = f.tenant_id and ff.fix_id = f.id
                         order by ff.finding_id) as "finding_ids!"
             from fixes f
            where f.tenant_id = $1
              and exists (select 1 from fix_findings l
                           where l.tenant_id = f.tenant_id and l.fix_id = f.id and l.finding_id = $2)
            order by f.created_at desc, f.id desc"#,
        tenant,
        finding.as_uuid(),
    )
    .fetch_all(tx.conn())
    .await?;
    rows.into_iter().map(Fix::try_from).collect()
}

/// Approves a proposed fix. Returns `None` when it does not exist for this tenant or is
/// not in `proposed`.
pub async fn approve(
    tx: &mut TenantTx,
    id: FixId,
    approver: UserId,
) -> Result<Option<Fix>, DbError> {
    let tenant = tx.tenant_uuid();
    let updated = sqlx::query!(
        r#"update fixes set status = 'approved', approved_by = $3, approved_at = now()
            where tenant_id = $1 and id = $2 and status = 'proposed'"#,
        tenant,
        id.as_uuid(),
        approver.as_uuid(),
    )
    .execute(tx.conn())
    .await?;
    if updated.rows_affected() == 0 {
        return Ok(None);
    }
    get(tx, id).await
}
