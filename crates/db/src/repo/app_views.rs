//! What the embedded app's pages read and change (ADR-083): scans, findings, fixes, evidence,
//! settings and the accessibility statement of one site. Every function filters by the
//! transaction's tenant and by the site, on top of row-level security, so a guessed id of
//! another shop's row finds nothing.

use domain::SiteId;
use serde_json::Value;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::{DbError, TenantTx};

/// A scan as the app shows it.
#[derive(Debug, Clone, PartialEq)]
pub struct ScanRow {
    /// The scan's id.
    pub id: Uuid,
    /// `queued`, `running`, `succeeded`, `partial`, `failed` or `cancelled`.
    pub status: String,
    /// Why it ran.
    pub trigger: String,
    /// When it was queued.
    pub created_at: OffsetDateTime,
    /// When a worker started it.
    pub started_at: Option<OffsetDateTime>,
    /// When it finished.
    pub finished_at: Option<OffsetDateTime>,
    /// Pages and states planned.
    pub pages_planned: i32,
    /// Pages and states done.
    pub pages_done: i32,
    /// Checks run.
    pub checks_run: i32,
    /// Checks that passed.
    pub checks_passed: i32,
    /// A short code when it failed.
    pub error_code: Option<String>,
    /// The ruleset it used.
    pub ruleset_version: String,
    /// The coverage document the engine wrote at the end.
    pub coverage: Option<Value>,
}

/// The site's newest scan that is not a verification of one fix.
pub async fn latest_scan(tx: &mut TenantTx, site: SiteId) -> Result<Option<ScanRow>, DbError> {
    let tenant = tx.tenant_uuid();
    Ok(sqlx::query_as!(
        ScanRow,
        r#"select id, status, trigger, created_at, started_at, finished_at, pages_planned,
                  pages_done, checks_run, checks_passed, error_code, ruleset_version, coverage
             from scans
            where tenant_id = $1 and site_id = $2 and trigger <> 'verify'
            order by created_at desc limit 1"#,
        tenant,
        site.as_uuid(),
    )
    .fetch_optional(tx.conn())
    .await?)
}

/// One scan of the site.
pub async fn scan(tx: &mut TenantTx, site: SiteId, id: Uuid) -> Result<Option<ScanRow>, DbError> {
    let tenant = tx.tenant_uuid();
    Ok(sqlx::query_as!(
        ScanRow,
        r#"select id, status, trigger, created_at, started_at, finished_at, pages_planned,
                  pages_done, checks_run, checks_passed, error_code, ruleset_version, coverage
             from scans where tenant_id = $1 and site_id = $2 and id = $3"#,
        tenant,
        site.as_uuid(),
        id,
    )
    .fetch_optional(tx.conn())
    .await?)
}

/// Whether a scan is queued or running and was queued within `fresh_for_secs`; an older one is
/// stale (a crashed run) and must not block a new scan.
pub async fn has_live_scan(
    tx: &mut TenantTx,
    site: SiteId,
    fresh_for_secs: i64,
) -> Result<bool, DbError> {
    let tenant = tx.tenant_uuid();
    Ok(sqlx::query_scalar!(
        r#"select exists (select 1 from scans
                           where tenant_id = $1 and site_id = $2 and trigger <> 'verify'
                             and status in ('queued', 'running')
                             and created_at > now() - $3::bigint * interval '1 second') as "live!""#,
        tenant,
        site.as_uuid(),
        fresh_for_secs,
    )
    .fetch_one(tx.conn())
    .await?)
}

/// Counts for the overview.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Counts {
    /// Open findings of minor impact (best practices excluded).
    pub minor: i64,
    /// Open findings of moderate impact.
    pub moderate: i64,
    /// Open findings of serious impact.
    pub serious: i64,
    /// Open findings of critical impact.
    pub critical: i64,
    /// Data fixes waiting for the merchant.
    pub awaiting_approval: i64,
    /// Data fixes applied, verified or not.
    pub applied: i64,
}

/// The overview's counts, and when the first fix was applied.
pub async fn counts(
    tx: &mut TenantTx,
    site: SiteId,
) -> Result<(Counts, Option<OffsetDateTime>), DbError> {
    let tenant = tx.tenant_uuid();
    let f = sqlx::query!(
        r#"select count(*) filter (where impact = 'minor') as "minor!",
                  count(*) filter (where impact = 'moderate') as "moderate!",
                  count(*) filter (where impact = 'serious') as "serious!",
                  count(*) filter (where impact = 'critical') as "critical!"
             from findings
            where tenant_id = $1 and site_id = $2 and status = 'open' and not best_practice"#,
        tenant,
        site.as_uuid(),
    )
    .fetch_one(tx.conn())
    .await?;
    let x = sqlx::query!(
        r#"select count(*) filter (where status = 'proposed') as "awaiting!",
                  count(*) filter (where status in ('applied', 'verified')) as "applied!",
                  min(applied_at) as first_fix_at
             from fixes where tenant_id = $1 and site_id = $2 and kind = 'data'"#,
        tenant,
        site.as_uuid(),
    )
    .fetch_one(tx.conn())
    .await?;
    Ok((
        Counts {
            minor: f.minor,
            moderate: f.moderate,
            serious: f.serious,
            critical: f.critical,
            awaiting_approval: x.awaiting,
            applied: x.applied,
        },
        x.first_fix_at,
    ))
}

/// Filters of the findings list.
#[derive(Debug, Clone, Default)]
pub struct FindingFilter {
    /// `minor` to `critical`.
    pub impact: Option<String>,
    /// A finding status.
    pub status: Option<String>,
    /// `render` or `data`.
    pub origin: Option<String>,
    /// A WCAG success criterion such as `1.1.1`.
    pub criterion: Option<String>,
    /// Whether the finding has a fix, or has none.
    pub has_fix: Option<bool>,
    /// Rows to skip.
    pub offset: i64,
    /// Rows to return.
    pub limit: i64,
}

/// A finding with its newest fix.
#[derive(Debug, Clone, PartialEq)]
pub struct FindingRow {
    /// The finding's id.
    pub id: Uuid,
    /// The rule that found it.
    pub rule_id: String,
    /// The success criteria it fails.
    pub criteria: Vec<String>,
    /// Its impact.
    pub impact: String,
    /// Its status.
    pub status: String,
    /// `render` or `data`.
    pub origin: String,
    /// How many places it was found.
    pub occurrence_count: i32,
    /// How many templates it affects.
    pub templates_affected: i32,
    /// Whether it is on a purchase path.
    pub on_purchase_path: bool,
    /// Its priority score.
    pub priority_score: Option<f64>,
    /// The newest fix, if any.
    pub fix_id: Option<Uuid>,
    /// That fix's status.
    pub fix_status: Option<String>,
    /// The number of rows matching the filter, before paging.
    pub total: i64,
}

/// Findings of the site, highest priority first.
pub async fn findings(
    tx: &mut TenantTx,
    site: SiteId,
    filter: &FindingFilter,
) -> Result<Vec<FindingRow>, DbError> {
    let tenant = tx.tenant_uuid();
    Ok(sqlx::query_as!(
        FindingRow,
        r#"select f.id, f.rule_id, f.criteria, f.impact, f.status, f.origin, f.occurrence_count,
                  f.templates_affected, f.on_purchase_path,
                  f.priority_score::float8 as priority_score,
                  nf.id as "fix_id?", nf.status as "fix_status?",
                  count(*) over () as "total!"
             from findings f
             left join lateral (
                  select x.id, x.status
                    from fix_findings ff
                    join fixes x on x.id = ff.fix_id and x.tenant_id = ff.tenant_id
                   where ff.tenant_id = f.tenant_id and ff.finding_id = f.id
                   order by x.created_at desc limit 1) nf on true
            where f.tenant_id = $1 and f.site_id = $2
              and ($3::text is null or f.impact = $3)
              and ($4::text is null or f.status = $4)
              and ($5::text is null or f.origin = $5)
              and ($6::text is null or $6 = any (f.criteria))
              and ($7::bool is null or ($7 = (nf.id is not null)))
            order by f.priority_score desc nulls last, f.id
            offset $8 limit $9"#,
        tenant,
        site.as_uuid(),
        filter.impact,
        filter.status,
        filter.origin,
        filter.criterion,
        filter.has_fix,
        filter.offset,
        filter.limit,
    )
    .fetch_all(tx.conn())
    .await?)
}

/// One finding with its newest fix.
pub async fn finding(
    tx: &mut TenantTx,
    site: SiteId,
    id: Uuid,
) -> Result<Option<FindingRow>, DbError> {
    let tenant = tx.tenant_uuid();
    Ok(sqlx::query_as!(
        FindingRow,
        r#"select f.id, f.rule_id, f.criteria, f.impact, f.status, f.origin, f.occurrence_count,
                  f.templates_affected, f.on_purchase_path,
                  f.priority_score::float8 as priority_score,
                  nf.id as "fix_id?", nf.status as "fix_status?",
                  1::bigint as "total!"
             from findings f
             left join lateral (
                  select x.id, x.status
                    from fix_findings ff
                    join fixes x on x.id = ff.fix_id and x.tenant_id = ff.tenant_id
                   where ff.tenant_id = f.tenant_id and ff.finding_id = f.id
                   order by x.created_at desc limit 1) nf on true
            where f.tenant_id = $1 and f.site_id = $2 and f.id = $3"#,
        tenant,
        site.as_uuid(),
        id,
    )
    .fetch_optional(tx.conn())
    .await?)
}

/// One place a finding was seen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OccurrenceRow {
    /// The page's URL.
    pub page_url: String,
    /// The page state it was seen in.
    pub page_state: String,
    /// The scrubbed selector.
    pub target: String,
    /// The scrubbed HTML excerpt.
    pub html_excerpt: String,
}

/// The newest occurrences of a finding (at most `limit`), and the distinct page types.
pub async fn occurrences(
    tx: &mut TenantTx,
    finding: Uuid,
    limit: i64,
) -> Result<(Vec<OccurrenceRow>, Vec<String>), DbError> {
    let tenant = tx.tenant_uuid();
    let rows = sqlx::query_as!(
        OccurrenceRow,
        r#"select page_url, page_state, target, html_excerpt
             from finding_occurrences
            where tenant_id = $1 and finding_id = $2
            order by captured_at desc, page_url, target limit $3"#,
        tenant,
        finding,
        limit,
    )
    .fetch_all(tx.conn())
    .await?;
    let templates = sqlx::query_scalar!(
        r#"select distinct page_type as "page_type!"
             from finding_occurrences
            where tenant_id = $1 and finding_id = $2 and page_type is not null
            order by 1"#,
        tenant,
        finding,
    )
    .fetch_all(tx.conn())
    .await?;
    Ok((rows, templates))
}

/// A data fix as the app shows it.
#[derive(Debug, Clone, PartialEq)]
pub struct FixRow {
    /// The fix's id.
    pub id: Uuid,
    /// Its status.
    pub status: String,
    /// `rule`, `ai` or `human`.
    pub origin: String,
    /// `data` or `code`.
    pub kind: String,
    /// `admin_api`, `github_pr` or `theme_package`.
    pub channel: String,
    /// The model, for an AI fix.
    pub model: Option<String>,
    /// The model's confidence.
    pub confidence: Option<f64>,
    /// The proposed change.
    pub diff: Option<Value>,
    /// Whether the merchant edited it.
    pub edited: bool,
    /// When it was proposed.
    pub created_at: OffsetDateTime,
    /// When it was approved.
    pub approved_at: Option<OffsetDateTime>,
    /// When it was applied.
    pub applied_at: Option<OffsetDateTime>,
    /// When a scan verified it.
    pub verified_at: Option<OffsetDateTime>,
    /// The verification scan.
    pub verified_scan: Option<Uuid>,
    /// The fix this one undoes.
    pub reverts: Option<Uuid>,
    /// Why it failed.
    pub error_code: Option<String>,
    /// Evidence from before the change.
    pub before_evidence_id: Option<Uuid>,
    /// Evidence from after it.
    pub after_evidence_id: Option<Uuid>,
    /// The GID of the resource that owns the field (a product for an image), from the first
    /// finding.
    pub owner: Option<String>,
}

/// Fixes of the site in the given statuses, newest first.
pub async fn fixes(
    tx: &mut TenantTx,
    site: SiteId,
    statuses: &[String],
    offset: i64,
    limit: i64,
) -> Result<Vec<FixRow>, DbError> {
    let tenant = tx.tenant_uuid();
    Ok(sqlx::query_as!(
        FixRow,
        r#"select x.id, x.status, x.origin, x.kind, x.channel, x.model,
                  x.confidence::float8 as confidence, x.diff, x.edited, x.created_at,
                  x.approved_at, x.applied_at, x.verified_at, x.verified_scan, x.reverts,
                  x.error_code, x.before_evidence_id, x.after_evidence_id,
                  (select g.source_location ->> 'owner'
                     from fix_findings ff
                     join findings g on g.id = ff.finding_id and g.tenant_id = ff.tenant_id
                    where ff.tenant_id = x.tenant_id and ff.fix_id = x.id
                    order by ff.finding_id limit 1) as owner
             from fixes x
            where x.tenant_id = $1 and x.site_id = $2 and x.kind = 'data'
              and x.status = any ($3)
            order by x.created_at desc, x.id
            offset $4 limit $5"#,
        tenant,
        site.as_uuid(),
        statuses,
        offset,
        limit,
    )
    .fetch_all(tx.conn())
    .await?)
}

/// One fix of the site.
pub async fn fix(tx: &mut TenantTx, site: SiteId, id: Uuid) -> Result<Option<FixRow>, DbError> {
    let tenant = tx.tenant_uuid();
    Ok(sqlx::query_as!(
        FixRow,
        r#"select x.id, x.status, x.origin, x.kind, x.channel, x.model,
                  x.confidence::float8 as confidence, x.diff, x.edited, x.created_at,
                  x.approved_at, x.applied_at, x.verified_at, x.verified_scan, x.reverts,
                  x.error_code, x.before_evidence_id, x.after_evidence_id,
                  (select g.source_location ->> 'owner'
                     from fix_findings ff
                     join findings g on g.id = ff.finding_id and g.tenant_id = ff.tenant_id
                    where ff.tenant_id = x.tenant_id and ff.fix_id = x.id
                    order by ff.finding_id limit 1) as owner
             from fixes x
            where x.tenant_id = $1 and x.site_id = $2 and x.id = $3"#,
        tenant,
        site.as_uuid(),
        id,
    )
    .fetch_optional(tx.conn())
    .await?)
}

/// The fixes that belong to a finding, newest first.
pub async fn fixes_of_finding(
    tx: &mut TenantTx,
    site: SiteId,
    finding: Uuid,
) -> Result<Vec<FixRow>, DbError> {
    let tenant = tx.tenant_uuid();
    Ok(sqlx::query_as!(
        FixRow,
        r#"select x.id, x.status, x.origin, x.kind, x.channel, x.model,
                  x.confidence::float8 as confidence, x.diff, x.edited, x.created_at,
                  x.approved_at, x.applied_at, x.verified_at, x.verified_scan, x.reverts,
                  x.error_code, x.before_evidence_id, x.after_evidence_id,
                  (select g.source_location ->> 'owner' from findings g
                    where g.tenant_id = x.tenant_id and g.id = $3) as owner
             from fixes x
             join fix_findings ff on ff.fix_id = x.id and ff.tenant_id = x.tenant_id
            where x.tenant_id = $1 and x.site_id = $2 and ff.finding_id = $3 and x.kind = 'data'
            order by x.created_at desc, x.id"#,
        tenant,
        site.as_uuid(),
        finding,
    )
    .fetch_all(tx.conn())
    .await?)
}

/// A finding a fix repairs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FixFindingRow {
    /// The fix.
    pub fix_id: Uuid,
    /// The finding's id.
    pub id: Uuid,
    /// Its rule.
    pub rule_id: String,
    /// Its criteria.
    pub criteria: Vec<String>,
    /// Its impact.
    pub impact: String,
}

/// The findings each of these fixes repairs.
pub async fn findings_of_fixes(
    tx: &mut TenantTx,
    fix_ids: &[Uuid],
) -> Result<Vec<FixFindingRow>, DbError> {
    let tenant = tx.tenant_uuid();
    Ok(sqlx::query_as!(
        FixFindingRow,
        r#"select ff.fix_id, g.id, g.rule_id, g.criteria, g.impact
             from fix_findings ff
             join findings g on g.id = ff.finding_id and g.tenant_id = ff.tenant_id
            where ff.tenant_id = $1 and ff.fix_id = any ($2)
            order by ff.fix_id, g.id"#,
        tenant,
        fix_ids,
    )
    .fetch_all(tx.conn())
    .await?)
}

/// A product in the latest read of the store.
#[derive(Debug, Clone, PartialEq)]
pub struct ProductInfo {
    /// The product's GID.
    pub gid: String,
    /// Its title.
    pub title: Option<String>,
    /// Its media: `id`, `url` and more.
    pub media: Value,
}

/// The products with these GIDs in the site's latest read of the store.
pub async fn products(
    tx: &mut TenantTx,
    site: SiteId,
    gids: &[String],
) -> Result<Vec<ProductInfo>, DbError> {
    let tenant = tx.tenant_uuid();
    let rows = sqlx::query!(
        r#"select e ->> 'id' as "gid!", e ->> 'title' as title, coalesce(e -> 'media', '[]'::jsonb) as "media!"
             from scan_inputs i, jsonb_array_elements(i.payload -> 'items') e
            where i.tenant_id = $1 and i.site_id = $2 and i.kind = 'products'
              and i.scan_id = (select scan_id from scan_inputs
                                where tenant_id = $1 and site_id = $2 and kind = 'products'
                                order by created_at desc limit 1)
              and e ->> 'id' = any ($3)"#,
        tenant,
        site.as_uuid(),
        gids,
    )
    .fetch_all(tx.conn())
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| ProductInfo {
            gid: r.gid,
            title: r.title,
            media: r.media,
        })
        .collect())
}

/// What an edit changed: the fix was `proposed` and now says `after`.
/// `false` when the fix is not the site's or not `proposed`.
pub async fn edit_alt(
    tx: &mut TenantTx,
    site: SiteId,
    id: Uuid,
    after: &str,
) -> Result<bool, DbError> {
    let tenant = tx.tenant_uuid();
    let done = sqlx::query!(
        r#"update fixes set diff = jsonb_set(diff, '{after}', to_jsonb($4::text)), edited = true
            where tenant_id = $1 and site_id = $2 and id = $3 and kind = 'data'
              and status = 'proposed' and diff is not null"#,
        tenant,
        site.as_uuid(),
        id,
        after,
    )
    .execute(tx.conn())
    .await?;
    if done.rows_affected() == 0 {
        return Ok(false);
    }
    sqlx::query!(
        r#"update data_fix_snapshots set after_value = to_jsonb($3::text)
            where tenant_id = $1 and fix_id = $2"#,
        tenant,
        id,
        after,
    )
    .execute(tx.conn())
    .await?;
    Ok(true)
}

/// `proposed` to `rejected`. `false` when the fix is not the site's or not `proposed`.
pub async fn reject(tx: &mut TenantTx, site: SiteId, id: Uuid) -> Result<bool, DbError> {
    let tenant = tx.tenant_uuid();
    let done = sqlx::query!(
        r#"update fixes set status = 'rejected'
            where tenant_id = $1 and site_id = $2 and id = $3 and kind = 'data'
              and status = 'proposed'"#,
        tenant,
        site.as_uuid(),
        id,
    )
    .execute(tx.conn())
    .await?;
    Ok(done.rows_affected() == 1)
}

/// Whether a revert job for the fix is waiting or running.
pub async fn revert_pending(tx: &mut TenantTx, id: Uuid) -> Result<bool, DbError> {
    let tenant = tx.tenant_uuid();
    Ok(sqlx::query_scalar!(
        r#"select exists (select 1 from jobs
                           where tenant_id = $1 and queue = 'shopify.revert_data_fix'
                             and state in ('ready', 'running')
                             and payload ->> 'fix_id' = $2::text) as "pending!""#,
        tenant,
        id.to_string(),
    )
    .fetch_one(tx.conn())
    .await?)
}

/// Evidence: its type and bytes.
pub async fn evidence(tx: &mut TenantTx, id: Uuid) -> Result<Option<(String, Vec<u8>)>, DbError> {
    let tenant = tx.tenant_uuid();
    Ok(sqlx::query!(
        r#"select content_type, bytes from evidence where tenant_id = $1 and id = $2"#,
        tenant,
        id,
    )
    .fetch_optional(tx.conn())
    .await?
    .map(|r| (r.content_type, r.bytes)))
}

/// Evidence attached to a finding's fixes, as `(id, kind)`: `before` or `after`.
pub async fn evidence_of_fixes(
    tx: &mut TenantTx,
    fix_ids: &[Uuid],
) -> Result<Vec<(Uuid, &'static str)>, DbError> {
    let tenant = tx.tenant_uuid();
    let rows = sqlx::query!(
        r#"select before_evidence_id, after_evidence_id from fixes
            where tenant_id = $1 and id = any ($2)"#,
        tenant,
        fix_ids,
    )
    .fetch_all(tx.conn())
    .await?;
    let mut out = Vec::new();
    for row in rows {
        if let Some(id) = row.before_evidence_id {
            out.push((id, "before"));
        }
        if let Some(id) = row.after_evidence_id {
            out.push((id, "after"));
        }
    }
    Ok(out)
}

/// The site's settings document.
pub async fn settings(tx: &mut TenantTx, site: SiteId) -> Result<Option<(Value, bool)>, DbError> {
    let tenant = tx.tenant_uuid();
    Ok(sqlx::query!(
        r#"select settings, (storefront_password_ct is not null) as "password_set!"
             from sites where tenant_id = $1 and id = $2"#,
        tenant,
        site.as_uuid(),
    )
    .fetch_optional(tx.conn())
    .await?
    .map(|r| (r.settings, r.password_set)))
}

/// Merges `patch` into the site's settings document (top-level keys; `null` removes a key).
pub async fn merge_settings(
    tx: &mut TenantTx,
    site: SiteId,
    patch: &Value,
) -> Result<bool, DbError> {
    let tenant = tx.tenant_uuid();
    let done = sqlx::query!(
        r#"update sites set settings = jsonb_strip_nulls(settings || $3)
            where tenant_id = $1 and id = $2"#,
        tenant,
        site.as_uuid(),
        patch,
    )
    .execute(tx.conn())
    .await?;
    Ok(done.rows_affected() == 1)
}

/// Stores the sealed storefront password, or clears it with `None`.
pub async fn set_storefront_password(
    tx: &mut TenantTx,
    site: SiteId,
    sealed: Option<(&[u8], &str)>,
) -> Result<bool, DbError> {
    let tenant = tx.tenant_uuid();
    let (bytes, key) = sealed.map_or((None, None), |(b, k)| (Some(b), Some(k)));
    let done = sqlx::query!(
        r#"update sites set storefront_password_ct = $3, storefront_password_key_id = $4
            where tenant_id = $1 and id = $2"#,
        tenant,
        site.as_uuid(),
        bytes,
        key,
    )
    .execute(tx.conn())
    .await?;
    Ok(done.rows_affected() == 1)
}

/// AI alt-text drafts the site has used: one per successful draft call, with the time. The
/// entitlements function turns them into the remaining allowance (ADR-133).
pub async fn alt_text_drafts(tx: &mut TenantTx) -> Result<Vec<OffsetDateTime>, DbError> {
    let tenant = tx.tenant_uuid();
    Ok(sqlx::query_scalar!(
        r#"select started_at from ai_calls
            where tenant_id = $1 and task in ('alt_text', 'alt_text_escalated')
              and outcome in ('ok', 'needs_review')
            order by started_at"#,
        tenant,
    )
    .fetch_all(tx.conn())
    .await?)
}

/// Data fixes applied or verified, to count against a plan's image allowance.
pub async fn images_fixed(tx: &mut TenantTx, site: SiteId) -> Result<i64, DbError> {
    let tenant = tx.tenant_uuid();
    Ok(sqlx::query_scalar!(
        r#"select count(*) as "n!" from fixes
            where tenant_id = $1 and site_id = $2 and kind = 'data'
              and status in ('approved', 'applying', 'applied', 'verified')"#,
        tenant,
        site.as_uuid(),
    )
    .fetch_one(tx.conn())
    .await?)
}

/// A statement version.
#[derive(Debug, Clone, PartialEq)]
pub struct StatementRow {
    /// Its id.
    pub id: Uuid,
    /// Its version number.
    pub version: i32,
    /// `draft` or `published`.
    pub status: String,
    /// The statement's content.
    pub content: Value,
    /// When it was saved.
    pub created_at: OffsetDateTime,
    /// When it was published.
    pub published_at: Option<OffsetDateTime>,
}

/// The site's statement versions, newest first.
pub async fn statements(tx: &mut TenantTx, site: SiteId) -> Result<Vec<StatementRow>, DbError> {
    let tenant = tx.tenant_uuid();
    Ok(sqlx::query_as!(
        StatementRow,
        r#"select id, version, status, content, created_at, published_at
             from statements where tenant_id = $1 and site_id = $2
            order by version desc"#,
        tenant,
        site.as_uuid(),
    )
    .fetch_all(tx.conn())
    .await?)
}

/// Saves the statement as the draft: updates the open draft in place, or adds the next version.
pub async fn save_draft(tx: &mut TenantTx, site: SiteId, content: &Value) -> Result<(), DbError> {
    let tenant = tx.tenant_uuid();
    let done = sqlx::query!(
        r#"update statements set content = $3
            where tenant_id = $1 and site_id = $2 and status = 'draft'"#,
        tenant,
        site.as_uuid(),
        content,
    )
    .execute(tx.conn())
    .await?;
    if done.rows_affected() == 0 {
        sqlx::query!(
            r#"insert into statements (id, tenant_id, site_id, version, status, content)
               select gen_random_uuid(), $1, $2,
                      coalesce((select max(version) from statements
                                 where tenant_id = $1 and site_id = $2), 0) + 1,
                      'draft', $3"#,
            tenant,
            site.as_uuid(),
            content,
        )
        .execute(tx.conn())
        .await?;
    }
    Ok(())
}

/// The site the shop belongs to.
pub async fn site_of_shop(
    tx: &mut TenantTx,
    shop: domain::ShopId,
) -> Result<Option<SiteId>, DbError> {
    let tenant = tx.tenant_uuid();
    Ok(sqlx::query_scalar!(
        r#"select site_id from shopify_shops where tenant_id = $1 and id = $2"#,
        tenant,
        shop.as_uuid(),
    )
    .fetch_optional(tx.conn())
    .await?
    .map(SiteId::from_uuid))
}
