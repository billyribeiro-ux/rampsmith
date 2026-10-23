//! The embedded app's routes (ADR-083): the overview, scans, findings, fixes, evidence,
//! settings and the accessibility statement of the shop that signed the request.
//!
//! Each handler opens one tenant transaction for the session's shop, so row-level security
//! confines every query to that shop, and every query also filters by the shop's site. An id
//! that belongs to another shop is a 404, the same answer as an id that does not exist.
//! Approving, undoing and starting a scan enqueue their jobs in the same transaction as the
//! change that causes them (PLAN §10).

use axum::Json;
use axum::extract::{FromRequest, Path, Query, Request, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use billing::entitlements::{Gate, feature_gates, image_fix_gate};
use billing::stored::{entitlements_of, state_of};
use billing::{DraftUsage, Entitlements, remaining_alt_text_drafts};
use contracts::{ShopifyApplyDataFix, ShopifyReadStore, ShopifyRevertDataFix};
use db::TenantTx;
use db::repo::app_views::{self, FindingFilter, FixRow, ScanRow};
use db::repo::{audit, jobs as job_repo, scans, shop_billing};
use domain::{ActorKind, ScanTrigger, ShopId, SiteId};
use http_kit::{ApiError, FieldError, ProblemCode};
use queue::NewJob;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Value, json};
use time::{Duration, OffsetDateTime};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::AppState;
use crate::rules;
use crate::shopify::ShopSession;

/// A scan queued or running for longer than this is stale (a crashed run) and does not block a
/// new scan.
const STALE_SCAN_SECONDS: i64 = 60 * 60;
/// Findings and fixes per page.
const PAGE: i64 = 25;
/// The most a page may ask for.
const PAGE_MAX: i64 = 100;
/// Occurrences shown on a finding's page.
const OCCURRENCES_SHOWN: i64 = 50;
/// The default longest alt text (PLAN §13).
const ALT_DEFAULT_CHARACTERS: i64 = 150;
const ALT_MIN_CHARACTERS: i64 = 40;
const ALT_MAX_CHARACTERS: i64 = 300;

// ---------------------------------------------------------------------------------------------
// Request plumbing

/// A JSON body whose rejection is a problem+json answer like every other error.
pub(crate) struct Body<T>(pub(crate) T);

impl<T: DeserializeOwned> FromRequest<AppState> for Body<T> {
    type Rejection = ApiError;

    async fn from_request(request: Request, state: &AppState) -> Result<Self, ApiError> {
        match Json::<T>::from_request(request, state).await {
            Ok(Json(value)) => Ok(Self(value)),
            Err(_) => Err(ApiError::new(ProblemCode::ValidationFailed)
                .detail("The request body is not valid for this operation.")),
        }
    }
}

fn invalid(field: &str, message: &str) -> ApiError {
    ApiError::new(ProblemCode::ValidationFailed).errors(vec![FieldError {
        field: field.to_owned(),
        message: message.to_owned(),
    }])
}

fn not_found() -> ApiError {
    ApiError::new(ProblemCode::NotFound)
}

fn uuid_of(text: &str) -> Result<Uuid, ApiError> {
    Uuid::parse_str(text).map_err(|_| not_found())
}

fn ts(at: OffsetDateTime) -> String {
    at.format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

fn ts_opt(at: Option<OffsetDateTime>) -> Option<String> {
    at.map(ts)
}

fn job_error(error: &serde_json::Error) -> ApiError {
    tracing::error!(%error, "job payload did not serialize");
    ApiError::new(ProblemCode::Internal)
}

fn queue_error(error: &impl std::fmt::Display) -> ApiError {
    tracing::error!(%error, "could not enqueue");
    ApiError::new(ProblemCode::Internal)
}

/// The shop's site: a shop without one is not installed.
async fn site_of(tx: &mut TenantTx, shop: ShopId) -> Result<SiteId, ApiError> {
    app_views::site_of_shop(tx, shop)
        .await?
        .ok_or_else(not_found)
}

/// The staff member's `sub`, or a refusal for a token without one.
fn staff(session: &shopify_auth::ShopSession) -> Result<&str, ApiError> {
    session.user_id.as_deref().ok_or_else(|| {
        ApiError::new(ProblemCode::Forbidden)
            .detail("This action needs a signed-in Shopify staff member.")
    })
}

// ---------------------------------------------------------------------------------------------
// Entitlements and settings

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct FeatureGateDto {
    /// The feature's key.
    feature: String,
    /// `allowed`, `locked` or `unavailable`.
    gate: String,
    /// The lowest plan that unlocks it, when it is locked.
    unlocked_by: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct DraftsDto {
    /// The allowance.
    limit: u32,
    /// Drafts used in the current window (the shop's lifetime on Free).
    used: u64,
    /// When the window renews; null on Free.
    renews_at: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct EntitlementsDto {
    /// `free`, `starter`, `growth` or `pro`.
    plan: String,
    /// `monthly`, `weekly` or `daily`.
    scan_cadence: String,
    alt_text_drafts: DraftsDto,
    features: Vec<FeatureGateDto>,
}

/// Everything the plan allows the shop, with what it has used.
struct PlanView {
    entitlements: Entitlements,
    dto: EntitlementsDto,
}

async fn plan_view(
    tx: &mut TenantTx,
    shop: ShopId,
    now: OffsetDateTime,
) -> Result<PlanView, ApiError> {
    let stored = shop_billing::get(tx, shop).await?;
    let state = state_of(stored.as_ref());
    let granted = entitlements_of(&state);
    let usage: Vec<DraftUsage> = app_views::alt_text_drafts(tx)
        .await?
        .into_iter()
        .map(|at| DraftUsage { at, quantity: 1 })
        .collect();
    let quota = remaining_alt_text_drafts(granted.plan(), &usage, state.usage_anchor, now)
        .map_err(|error| queue_error(&error))?;
    let features = feature_gates(granted.plan())
        .into_iter()
        .map(|(feature, gate)| FeatureGateDto {
            feature: feature.key().to_owned(),
            gate: match gate {
                Gate::Allowed => "allowed",
                Gate::Locked { .. } => "locked",
                Gate::Unavailable => "unavailable",
            }
            .to_owned(),
            unlocked_by: match gate {
                Gate::Locked { unlocked_by } => Some(unlocked_by.handle().to_owned()),
                _ => None,
            },
        })
        .collect();
    Ok(PlanView {
        entitlements: granted,
        dto: EntitlementsDto {
            plan: granted.plan().handle().to_owned(),
            scan_cadence: granted.render_cadence().as_str().to_owned(),
            alt_text_drafts: DraftsDto {
                limit: quota.allowance.limit(),
                used: quota.used,
                renews_at: ts_opt(quota.renews_at()),
            },
            features,
        },
    })
}

/// The merchant's settings with their defaults.
struct SettingValues {
    weekly_rescan: bool,
    notification_email: Option<String>,
    alt_text_max_characters: i64,
    ai_budget_micro_usd: i64,
}

fn setting_values(document: &Value, ceiling: i64) -> SettingValues {
    SettingValues {
        weekly_rescan: document
            .get("weekly_rescan")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        notification_email: document
            .get("notification_email")
            .and_then(Value::as_str)
            .map(str::to_owned),
        alt_text_max_characters: document
            .get("alt_text_max_characters")
            .and_then(Value::as_i64)
            .filter(|n| (ALT_MIN_CHARACTERS..=ALT_MAX_CHARACTERS).contains(n))
            .unwrap_or(ALT_DEFAULT_CHARACTERS),
        ai_budget_micro_usd: document
            .get("ai_budget_micro_usd")
            .and_then(Value::as_i64)
            .map_or(ceiling, |n| n.clamp(0, ceiling)),
    }
}

fn ceiling_of(granted: &Entitlements) -> i64 {
    i64::try_from(granted.ai_budget_micro_usd()).unwrap_or(i64::MAX)
}

// ---------------------------------------------------------------------------------------------
// Scans and the overview

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct CoverageDto {
    /// WCAG success criteria the automated checks tested.
    automated: Vec<String>,
    /// Criteria tested only in part.
    partial: Vec<String>,
    /// Findings waiting for a person's review.
    review_queue: Option<i64>,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct ScanSummaryDto {
    id: String,
    /// `queued`, `running`, `succeeded`, `partial`, `failed` or `cancelled`.
    status: String,
    /// `manual`, `scheduled`, `webhook`, `verify` or `free`.
    trigger: String,
    created_at: String,
    started_at: Option<String>,
    finished_at: Option<String>,
    pages_planned: i32,
    pages_done: i32,
    checks_run: i32,
    checks_passed: i32,
    /// A short code such as `store_unreachable`; never store content.
    error_code: Option<String>,
    /// The axe-core version the scan ran with.
    ruleset_version: String,
    /// The coverage disclosure; null until the scan is finalised.
    coverage: Option<CoverageDto>,
}

fn strings(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

/// What `start_scan` writes until the engine records the real ruleset on the scan.
const PLACEHOLDER_RULESET: &str = "axe-core";

fn scan_dto(row: ScanRow) -> ScanSummaryDto {
    // The engine records the axe-core version and the custom rules' hash on the scan when it
    // plans and finalises it. Only a scan the engine has not reached yet, or one from before
    // that, carries the bare placeholder `start_scan` writes; those fall back to the coverage
    // document's axe-core version, when there is one.
    let ruleset_version = if row.ruleset_version == PLACEHOLDER_RULESET {
        row.coverage
            .as_ref()
            .and_then(|c| c.get("ruleset"))
            .and_then(|r| r.get("axe"))
            .and_then(Value::as_str)
            .map_or(row.ruleset_version, |axe| format!("axe-core {axe}"))
    } else {
        row.ruleset_version
    };
    let coverage = row.coverage.as_ref().map(|c| CoverageDto {
        automated: strings(c.get("criteria_tested")),
        partial: strings(c.get("criteria_partial")),
        review_queue: c.get("review_queue").and_then(Value::as_i64),
    });
    ScanSummaryDto {
        id: row.id.to_string(),
        status: row.status,
        trigger: row.trigger,
        created_at: ts(row.created_at),
        started_at: ts_opt(row.started_at),
        finished_at: ts_opt(row.finished_at),
        pages_planned: row.pages_planned,
        pages_done: row.pages_done,
        checks_run: row.checks_run,
        checks_passed: row.checks_passed,
        error_code: row.error_code,
        ruleset_version,
        coverage,
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct ShopDto {
    domain: String,
    /// The shop's name, once `shopify.read_store` has read it; null before the first scan.
    name: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct ImpactCountsDto {
    minor: i64,
    moderate: i64,
    serious: i64,
    critical: i64,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct OverviewDto {
    shop: ShopDto,
    entitlements: EntitlementsDto,
    latest_scan: Option<ScanSummaryDto>,
    /// When the next scheduled rescan runs, when weekly rescans are on.
    next_scan_at: Option<String>,
    /// Open findings by impact; best practices are not counted.
    open_by_impact: ImpactCountsDto,
    fixes_awaiting_approval: i64,
    fixes_applied: i64,
    /// When the first fix was applied.
    first_fix_at: Option<String>,
}

/// The pass rate, open findings by impact, fixes awaiting approval, and the last and next scan.
#[utoipa::path(
    get,
    path = "/v1/shopify/overview",
    tag = "app",
    operation_id = "getOverview",
    security(("shopify_session" = [])),
    responses(
        (status = OK, description = "The overview", body = OverviewDto),
        (status = UNAUTHORIZED, description = "Missing or invalid session token",
            body = http_kit::Problem, content_type = "application/problem+json")
    )
)]
pub(crate) async fn get_overview(
    State(state): State<AppState>,
    ShopSession(session): ShopSession,
) -> Result<Json<OverviewDto>, ApiError> {
    let now = OffsetDateTime::now_utc();
    if let Some(partner) = &state.partner {
        // A failed check leaves the stored plan in force; the overview still loads.
        if let Err(error) = partner
            .refresh(&state.db, session.tenant, session.shop_id, now)
            .await
        {
            tracing::warn!(%error, "plan refresh failed");
        }
    }
    let mut tx = state.db.tenant(session.tenant).await?;
    let site = site_of(&mut tx, session.shop_id).await?;
    let view = plan_view(&mut tx, session.shop_id, now).await?;
    let shop_name = db::repo::shopify::get_info(&mut tx, session.shop_id)
        .await?
        .and_then(|info| info.name);
    let latest = app_views::latest_scan(&mut tx, site).await?;
    let (counts, first_fix) = app_views::counts(&mut tx, site).await?;
    let (document, _) = app_views::settings(&mut tx, site)
        .await?
        .unwrap_or_default();
    let values = setting_values(&document, ceiling_of(&view.entitlements));
    let next_scan_at = latest
        .as_ref()
        .filter(|_| values.weekly_rescan)
        .map(|scan| ts(scan.created_at + Duration::days(7)));
    Ok(Json(OverviewDto {
        shop: ShopDto {
            domain: session.shop.as_str().to_owned(),
            name: shop_name,
        },
        entitlements: view.dto,
        latest_scan: latest.map(scan_dto),
        next_scan_at,
        open_by_impact: ImpactCountsDto {
            minor: counts.minor,
            moderate: counts.moderate,
            serious: counts.serious,
            critical: counts.critical,
        },
        fixes_awaiting_approval: counts.awaiting_approval,
        fixes_applied: counts.applied,
        first_fix_at: ts_opt(first_fix),
    }))
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct StartedScanDto {
    scan: ScanSummaryDto,
}

/// Starts a scan of the shop.
#[utoipa::path(
    post,
    path = "/v1/shopify/scans",
    tag = "app",
    operation_id = "startScan",
    security(("shopify_session" = [])),
    responses(
        (status = ACCEPTED, description = "The scan is queued", body = StartedScanDto),
        (status = CONFLICT, description = "A scan is already running",
            body = http_kit::Problem, content_type = "application/problem+json"),
        (status = UNAUTHORIZED, description = "Missing or invalid session token",
            body = http_kit::Problem, content_type = "application/problem+json")
    )
)]
pub(crate) async fn start_scan(
    State(state): State<AppState>,
    ShopSession(session): ShopSession,
) -> Result<(StatusCode, Json<StartedScanDto>), ApiError> {
    let mut tx = state.db.tenant(session.tenant).await?;
    let site = site_of(&mut tx, session.shop_id).await?;
    if app_views::has_live_scan(&mut tx, site, STALE_SCAN_SECONDS).await? {
        return Err(ApiError::new(ProblemCode::Conflict).detail("A scan is already running."));
    }
    let ruleset = db::repo::data_fixes::latest_ruleset(&mut tx, site)
        .await?
        .unwrap_or_else(|| PLACEHOLDER_RULESET.to_owned());
    let scan = scans::create(
        &mut tx,
        &scans::NewScan {
            site_id: site,
            trigger: ScanTrigger::Manual,
            ruleset_version: ruleset,
            theme_ref: None,
        },
    )
    .await?;
    let job = ShopifyReadStore {
        scan_id: scan.id.as_uuid(),
        site_id: site.as_uuid(),
        shop_id: session.shop_id.as_uuid(),
    };
    job_repo::enqueue(
        &mut tx,
        NewJob::new(
            ShopifyReadStore::QUEUE,
            ShopifyReadStore::SCHEMA,
            serde_json::to_value(job).map_err(|e| job_error(&e))?,
        )
        .idempotency_key(format!("{}:{}", ShopifyReadStore::QUEUE, scan.id)),
    )
    .await?;
    audit::append(
        &mut tx,
        &audit::NewEntry {
            actor_kind: ActorKind::User,
            actor_id: session.user_id.clone(),
            action: "scan.started".to_owned(),
            subject_type: "scan".to_owned(),
            subject_id: scan.id.as_uuid(),
            data: json!({"trigger": "manual"}),
        },
    )
    .await?;
    let row = app_views::scan(&mut tx, site, scan.id.as_uuid())
        .await?
        .ok_or_else(not_found)?;
    tx.commit().await?;
    Ok((
        StatusCode::ACCEPTED,
        Json(StartedScanDto {
            scan: scan_dto(row),
        }),
    ))
}

/// One scan, with its progress and coverage.
#[utoipa::path(
    get,
    path = "/v1/shopify/scans/{scan_id}",
    tag = "app",
    operation_id = "getScan",
    security(("shopify_session" = [])),
    params(("scan_id" = String, Path, description = "The scan's identifier")),
    responses(
        (status = OK, description = "The scan", body = ScanSummaryDto),
        (status = NOT_FOUND, description = "No such scan",
            body = http_kit::Problem, content_type = "application/problem+json"),
        (status = UNAUTHORIZED, description = "Missing or invalid session token",
            body = http_kit::Problem, content_type = "application/problem+json")
    )
)]
pub(crate) async fn get_scan(
    State(state): State<AppState>,
    ShopSession(session): ShopSession,
    Path(scan_id): Path<String>,
) -> Result<Json<ScanSummaryDto>, ApiError> {
    let id = uuid_of(&scan_id)?;
    let mut tx = state.db.tenant(session.tenant).await?;
    let site = site_of(&mut tx, session.shop_id).await?;
    let row = app_views::scan(&mut tx, site, id)
        .await?
        .ok_or_else(not_found)?;
    Ok(Json(scan_dto(row)))
}

// ---------------------------------------------------------------------------------------------
// Fixes (shared by findings and fixes)

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct AltTextChangeDto {
    /// Always `alt_text`.
    r#type: String,
    resource_gid: String,
    /// Always `alt`.
    field: String,
    before: Option<String>,
    after: String,
    language: String,
    contains_text: bool,
    escalated: bool,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct FixFindingDto {
    id: String,
    rule_id: String,
    title: String,
    criteria: Vec<String>,
    impact: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct FixDto {
    id: String,
    status: String,
    origin: String,
    kind: String,
    channel: String,
    model: Option<String>,
    confidence: Option<f64>,
    change: AltTextChangeDto,
    /// The product the image belongs to.
    product_title: String,
    /// The image on Shopify's CDN.
    image_url: Option<String>,
    findings: Vec<FixFindingDto>,
    edited: bool,
    proposed_at: String,
    approved_at: Option<String>,
    /// Shopify does not give the app the staff member's name.
    approver_name: Option<String>,
    applied_at: Option<String>,
    verified_at: Option<String>,
    verified_scan: Option<String>,
    reverts: Option<String>,
    error_code: Option<String>,
    before_evidence_id: Option<String>,
    after_evidence_id: Option<String>,
}

fn change_of(diff: Option<&Value>) -> AltTextChangeDto {
    let text = |key: &str| diff.and_then(|d| d.get(key)).and_then(Value::as_str);
    AltTextChangeDto {
        r#type: "alt_text".to_owned(),
        resource_gid: text("resource_gid")
            .or_else(|| text("resource"))
            .unwrap_or_default()
            .to_owned(),
        field: "alt".to_owned(),
        before: text("before").map(str::to_owned),
        after: text("after").unwrap_or_default().to_owned(),
        language: text("language").unwrap_or("en").to_owned(),
        contains_text: diff
            .and_then(|d| d.get("contains_text"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        escalated: diff
            .and_then(|d| d.get("escalated"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
    }
}

/// The review cards for these fixes: the change, the product it is on and the findings it
/// repairs.
async fn fix_dtos(
    tx: &mut TenantTx,
    site: SiteId,
    rows: Vec<FixRow>,
) -> Result<Vec<FixDto>, ApiError> {
    let ids: Vec<Uuid> = rows.iter().map(|row| row.id).collect();
    let owners: Vec<String> = rows.iter().filter_map(|row| row.owner.clone()).collect();
    let products = app_views::products(tx, site, &owners).await?;
    let repaired = app_views::findings_of_fixes(tx, &ids).await?;
    Ok(rows
        .into_iter()
        .map(|row| {
            let change = change_of(row.diff.as_ref());
            let product = row
                .owner
                .as_deref()
                .and_then(|owner| products.iter().find(|p| p.gid == owner));
            let image_url = product.and_then(|p| {
                p.media
                    .as_array()?
                    .iter()
                    .find(|m| m.get("id").and_then(Value::as_str) == Some(&change.resource_gid))
                    .and_then(|m| m.get("url").and_then(Value::as_str))
                    .map(str::to_owned)
            });
            FixDto {
                findings: repaired
                    .iter()
                    .filter(|f| f.fix_id == row.id)
                    .map(|f| FixFindingDto {
                        id: f.id.to_string(),
                        title: rules::text(&f.rule_id).title.to_owned(),
                        rule_id: f.rule_id.clone(),
                        criteria: f.criteria.clone(),
                        impact: f.impact.clone(),
                    })
                    .collect(),
                id: row.id.to_string(),
                status: row.status,
                origin: row.origin,
                kind: row.kind,
                channel: row.channel,
                model: row.model,
                confidence: row.confidence,
                product_title: product
                    .and_then(|p| p.title.clone())
                    .unwrap_or_else(|| "Product".to_owned()),
                image_url,
                change,
                edited: row.edited,
                proposed_at: ts(row.created_at),
                approved_at: ts_opt(row.approved_at),
                approver_name: None,
                applied_at: ts_opt(row.applied_at),
                verified_at: ts_opt(row.verified_at),
                verified_scan: row.verified_scan.map(|id| id.to_string()),
                reverts: row.reverts.map(|id| id.to_string()),
                error_code: row.error_code,
                before_evidence_id: row.before_evidence_id.map(|id| id.to_string()),
                after_evidence_id: row.after_evidence_id.map(|id| id.to_string()),
            }
        })
        .collect())
}

async fn one_fix(tx: &mut TenantTx, site: SiteId, id: Uuid) -> Result<FixDto, ApiError> {
    let row = app_views::fix(tx, site, id).await?.ok_or_else(not_found)?;
    fix_dtos(tx, site, vec![row])
        .await?
        .pop()
        .ok_or_else(not_found)
}

// ---------------------------------------------------------------------------------------------
// Findings

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct FindingFixDto {
    id: String,
    status: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct FindingSummaryDto {
    id: String,
    rule_id: String,
    /// One plain-language sentence naming the problem.
    title: String,
    criteria: Vec<String>,
    impact: String,
    status: String,
    origin: String,
    occurrence_count: i32,
    templates_affected: i32,
    on_purchase_path: bool,
    priority_score: Option<f64>,
    /// The newest fix for this finding, if any.
    fix: Option<FindingFixDto>,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct FindingListDto {
    items: Vec<FindingSummaryDto>,
    total: i64,
    next_cursor: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct OccurrenceDto {
    page_url: String,
    page_state: String,
    /// A scrubbed CSS selector.
    target: String,
    /// A scrubbed HTML excerpt of at most 512 characters.
    html_excerpt: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct EvidenceRefDto {
    id: String,
    /// `before` or `after`.
    kind: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct FindingDetailDto {
    #[serde(flatten)]
    summary: FindingSummaryDto,
    /// The rule's plain-language explanation.
    explanation: String,
    occurrences: Vec<OccurrenceDto>,
    /// The page types the finding appears on.
    templates: Vec<String>,
    evidence: Vec<EvidenceRefDto>,
    fixes: Vec<FixDto>,
}

fn finding_dto(row: app_views::FindingRow) -> FindingSummaryDto {
    FindingSummaryDto {
        title: rules::text(&row.rule_id).title.to_owned(),
        id: row.id.to_string(),
        rule_id: row.rule_id,
        criteria: row.criteria,
        impact: row.impact,
        status: row.status,
        origin: row.origin,
        occurrence_count: row.occurrence_count,
        templates_affected: row.templates_affected,
        on_purchase_path: row.on_purchase_path,
        priority_score: row.priority_score,
        fix: row
            .fix_id
            .zip(row.fix_status)
            .map(|(id, status)| FindingFixDto {
                id: id.to_string(),
                status,
            }),
    }
}

/// Filters and paging of the findings list.
#[derive(Debug, Deserialize, utoipa::IntoParams)]
pub(crate) struct FindingsQuery {
    /// `minor`, `moderate`, `serious` or `critical`.
    impact: Option<String>,
    /// `open`, `fixed`, `needs_review`, `accepted_risk` or `false_positive`.
    status: Option<String>,
    /// `render` or `data`.
    origin: Option<String>,
    /// A WCAG success criterion such as `1.1.1`.
    criterion: Option<String>,
    /// Only findings that have (true) or lack (false) a fix.
    has_fix: Option<bool>,
    /// The `next_cursor` of the previous page.
    cursor: Option<String>,
    /// Items per page (default 25, at most 100).
    limit: Option<i64>,
}

fn one_of(field: &str, value: Option<&String>, allowed: &[&str]) -> Result<(), ApiError> {
    match value {
        Some(v) if !allowed.contains(&v.as_str()) => Err(invalid(field, "not a known value")),
        _ => Ok(()),
    }
}

/// The offset a cursor names and the page size.
fn paging(cursor: Option<&String>, limit: Option<i64>) -> Result<(i64, i64), ApiError> {
    let offset = match cursor {
        None => 0,
        Some(text) => text
            .parse::<i64>()
            .ok()
            .filter(|n| *n >= 0)
            .ok_or_else(|| invalid("cursor", "not a cursor this API issued"))?,
    };
    let limit = limit.unwrap_or(PAGE);
    if !(1..=PAGE_MAX).contains(&limit) {
        return Err(invalid("limit", "must be between 1 and 100"));
    }
    Ok((offset, limit))
}

/// Open findings, ranked by priority score.
#[utoipa::path(
    get,
    path = "/v1/shopify/findings",
    tag = "app",
    operation_id = "listFindings",
    security(("shopify_session" = [])),
    params(FindingsQuery),
    responses(
        (status = OK, description = "A page of findings", body = FindingListDto),
        (status = UNPROCESSABLE_ENTITY, description = "A filter or the cursor is invalid",
            body = http_kit::Problem, content_type = "application/problem+json"),
        (status = UNAUTHORIZED, description = "Missing or invalid session token",
            body = http_kit::Problem, content_type = "application/problem+json")
    )
)]
pub(crate) async fn list_findings(
    State(state): State<AppState>,
    ShopSession(session): ShopSession,
    Query(query): Query<FindingsQuery>,
) -> Result<Json<FindingListDto>, ApiError> {
    one_of(
        "impact",
        query.impact.as_ref(),
        &["minor", "moderate", "serious", "critical"],
    )?;
    one_of(
        "status",
        query.status.as_ref(),
        &[
            "open",
            "fixed",
            "needs_review",
            "accepted_risk",
            "false_positive",
        ],
    )?;
    one_of("origin", query.origin.as_ref(), &["render", "data"])?;
    let (offset, limit) = paging(query.cursor.as_ref(), query.limit)?;
    let mut tx = state.db.tenant(session.tenant).await?;
    let site = site_of(&mut tx, session.shop_id).await?;
    let rows = app_views::findings(
        &mut tx,
        site,
        &FindingFilter {
            impact: query.impact,
            status: query.status,
            origin: query.origin,
            criterion: query.criterion,
            has_fix: query.has_fix,
            offset,
            limit,
        },
    )
    .await?;
    let total = rows.first().map_or(0, |row| row.total);
    let shown = i64::try_from(rows.len()).unwrap_or(0);
    let next_cursor = (offset + shown < total).then(|| (offset + shown).to_string());
    Ok(Json(FindingListDto {
        items: rows.into_iter().map(finding_dto).collect(),
        total,
        next_cursor,
    }))
}

/// One finding with its occurrences, evidence and fixes.
#[utoipa::path(
    get,
    path = "/v1/shopify/findings/{finding_id}",
    tag = "app",
    operation_id = "getFinding",
    security(("shopify_session" = [])),
    params(("finding_id" = String, Path, description = "The finding's identifier")),
    responses(
        (status = OK, description = "The finding", body = FindingDetailDto),
        (status = NOT_FOUND, description = "No such finding",
            body = http_kit::Problem, content_type = "application/problem+json"),
        (status = UNAUTHORIZED, description = "Missing or invalid session token",
            body = http_kit::Problem, content_type = "application/problem+json")
    )
)]
pub(crate) async fn get_finding(
    State(state): State<AppState>,
    ShopSession(session): ShopSession,
    Path(finding_id): Path<String>,
) -> Result<Json<FindingDetailDto>, ApiError> {
    let id = uuid_of(&finding_id)?;
    let mut tx = state.db.tenant(session.tenant).await?;
    let site = site_of(&mut tx, session.shop_id).await?;
    let row = app_views::finding(&mut tx, site, id)
        .await?
        .ok_or_else(not_found)?;
    let explanation = rules::text(&row.rule_id).explanation.to_owned();
    let (occurrences, templates) = app_views::occurrences(&mut tx, id, OCCURRENCES_SHOWN).await?;
    let fix_rows = app_views::fixes_of_finding(&mut tx, site, id).await?;
    let fix_ids: Vec<Uuid> = fix_rows.iter().map(|f| f.id).collect();
    let evidence = app_views::evidence_of_fixes(&mut tx, &fix_ids).await?;
    let fixes = fix_dtos(&mut tx, site, fix_rows).await?;
    Ok(Json(FindingDetailDto {
        summary: finding_dto(row),
        explanation,
        occurrences: occurrences
            .into_iter()
            .map(|o| OccurrenceDto {
                page_url: o.page_url,
                page_state: o.page_state,
                target: o.target,
                html_excerpt: o.html_excerpt,
            })
            .collect(),
        templates,
        evidence: evidence
            .into_iter()
            .map(|(id, kind)| EvidenceRefDto {
                id: id.to_string(),
                kind: kind.to_owned(),
            })
            .collect(),
        fixes,
    }))
}

// ---------------------------------------------------------------------------------------------
// Fixes

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct FixListDto {
    items: Vec<FixDto>,
    next_cursor: Option<String>,
}

/// Which fixes to list and the paging.
#[derive(Debug, Deserialize, utoipa::IntoParams)]
pub(crate) struct FixesQuery {
    /// `queue` (default): waiting, approved, applying or failed. `applied`: applied or verified.
    /// `all`.
    state: Option<String>,
    /// The `next_cursor` of the previous page.
    cursor: Option<String>,
    /// Items per page (default 25, at most 100).
    limit: Option<i64>,
}

/// Fixes: the review queue, or what was applied.
#[utoipa::path(
    get,
    path = "/v1/shopify/fixes",
    tag = "app",
    operation_id = "listFixes",
    security(("shopify_session" = [])),
    params(FixesQuery),
    responses(
        (status = OK, description = "A page of fixes", body = FixListDto),
        (status = UNPROCESSABLE_ENTITY, description = "A filter or the cursor is invalid",
            body = http_kit::Problem, content_type = "application/problem+json"),
        (status = UNAUTHORIZED, description = "Missing or invalid session token",
            body = http_kit::Problem, content_type = "application/problem+json")
    )
)]
pub(crate) async fn list_fixes(
    State(state): State<AppState>,
    ShopSession(session): ShopSession,
    Query(query): Query<FixesQuery>,
) -> Result<Json<FixListDto>, ApiError> {
    let statuses: &[&str] = match query.state.as_deref().unwrap_or("queue") {
        "queue" => &["proposed", "approved", "applying", "failed"],
        "applied" => &["applied", "verified"],
        "all" => &[
            "proposed", "approved", "applying", "applied", "verified", "failed", "reverted",
            "rejected",
        ],
        _ => return Err(invalid("state", "must be queue, applied or all")),
    };
    let (offset, limit) = paging(query.cursor.as_ref(), query.limit)?;
    let statuses: Vec<String> = statuses.iter().map(|s| (*s).to_owned()).collect();
    let mut tx = state.db.tenant(session.tenant).await?;
    let site = site_of(&mut tx, session.shop_id).await?;
    // One more than a page tells whether another page follows.
    let mut rows = app_views::fixes(&mut tx, site, &statuses, offset, limit + 1).await?;
    let more = i64::try_from(rows.len()).unwrap_or(0) > limit;
    rows.truncate(usize::try_from(limit).unwrap_or(0));
    let shown = i64::try_from(rows.len()).unwrap_or(0);
    let items = fix_dtos(&mut tx, site, rows).await?;
    Ok(Json(FixListDto {
        items,
        next_cursor: more.then(|| (offset + shown).to_string()),
    }))
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct EditFixBody {
    /// The new alt text.
    alt: String,
}

/// Edits the alt text of a fix that is waiting for review.
#[utoipa::path(
    put,
    path = "/v1/shopify/fixes/{fix_id}",
    tag = "app",
    operation_id = "editFix",
    security(("shopify_session" = [])),
    params(("fix_id" = String, Path, description = "The fix's identifier")),
    request_body = EditFixBody,
    responses(
        (status = OK, description = "The edited fix", body = FixDto),
        (status = NOT_FOUND, description = "No such fix",
            body = http_kit::Problem, content_type = "application/problem+json"),
        (status = CONFLICT, description = "The fix is no longer waiting for review",
            body = http_kit::Problem, content_type = "application/problem+json"),
        (status = UNPROCESSABLE_ENTITY, description = "The alt text is empty or too long",
            body = http_kit::Problem, content_type = "application/problem+json"),
        (status = UNAUTHORIZED, description = "Missing or invalid session token",
            body = http_kit::Problem, content_type = "application/problem+json")
    )
)]
pub(crate) async fn edit_fix(
    State(state): State<AppState>,
    ShopSession(session): ShopSession,
    Path(fix_id): Path<String>,
    Body(body): Body<EditFixBody>,
) -> Result<Json<FixDto>, ApiError> {
    let id = uuid_of(&fix_id)?;
    let mut tx = state.db.tenant(session.tenant).await?;
    let site = site_of(&mut tx, session.shop_id).await?;
    let fix = app_views::fix(&mut tx, site, id)
        .await?
        .ok_or_else(not_found)?;
    if fix.status != "proposed" {
        return Err(
            ApiError::new(ProblemCode::Conflict).detail("The fix is no longer waiting for review.")
        );
    }
    let view = plan_view(&mut tx, session.shop_id, OffsetDateTime::now_utc()).await?;
    let (document, _) = app_views::settings(&mut tx, site)
        .await?
        .unwrap_or_default();
    let values = setting_values(&document, ceiling_of(&view.entitlements));
    let alt = body.alt.trim();
    let length = i64::try_from(alt.chars().count()).unwrap_or(i64::MAX);
    if alt.is_empty() {
        return Err(invalid("alt", "must not be empty"));
    }
    if length > values.alt_text_max_characters {
        return Err(invalid("alt", "is longer than the limit in settings"));
    }
    if !app_views::edit_alt(&mut tx, site, id, alt).await? {
        return Err(
            ApiError::new(ProblemCode::Conflict).detail("The fix is no longer waiting for review.")
        );
    }
    let dto = one_fix(&mut tx, site, id).await?;
    tx.commit().await?;
    Ok(Json(dto))
}

/// Approves a fix: Rampsmith then changes the alt text in the shop.
#[utoipa::path(
    post,
    path = "/v1/shopify/fixes/{fix_id}/approve",
    tag = "app",
    operation_id = "approveFix",
    security(("shopify_session" = [])),
    params(("fix_id" = String, Path, description = "The fix's identifier")),
    responses(
        (status = OK, description = "The approved fix; it is applied shortly", body = FixDto),
        (status = NOT_FOUND, description = "No such fix",
            body = http_kit::Problem, content_type = "application/problem+json"),
        (status = CONFLICT, description = "The fix was already decided",
            body = http_kit::Problem, content_type = "application/problem+json"),
        (status = FORBIDDEN, description = "The plan does not cover another image fix",
            body = http_kit::Problem, content_type = "application/problem+json"),
        (status = UNAUTHORIZED, description = "Missing or invalid session token",
            body = http_kit::Problem, content_type = "application/problem+json")
    )
)]
pub(crate) async fn approve_fix(
    State(state): State<AppState>,
    ShopSession(session): ShopSession,
    Path(fix_id): Path<String>,
) -> Result<Json<FixDto>, ApiError> {
    let id = uuid_of(&fix_id)?;
    let approver = staff(&session)?.to_owned();
    let mut tx = state.db.tenant(session.tenant).await?;
    let site = site_of(&mut tx, session.shop_id).await?;
    let fix = app_views::fix(&mut tx, site, id)
        .await?
        .ok_or_else(not_found)?;
    if fix.status != "proposed" {
        return Err(ApiError::new(ProblemCode::Conflict).detail("The fix was already decided."));
    }
    let view = plan_view(&mut tx, session.shop_id, OffsetDateTime::now_utc()).await?;
    // One approval at a time per shop, so the allowance cannot be passed by a race.
    app_views::lock_site(&mut tx, site).await?;
    let already = app_views::images_fixed(&mut tx, site).await?;
    let gate = image_fix_gate(
        view.entitlements.plan(),
        u32::try_from(already).unwrap_or(u32::MAX),
    );
    if !gate.is_allowed() {
        return Err(ApiError::new(ProblemCode::Forbidden)
            .detail("The plan does not cover another image fix."));
    }
    let decided =
        db::repo::data_fixes::approve_by_ref(&mut tx, domain::FixId::from_uuid(id), &approver)
            .await?;
    if decided.is_none() {
        return Err(ApiError::new(ProblemCode::Conflict).detail("The fix was already decided."));
    }
    let job = ShopifyApplyDataFix {
        fix_id: id,
        shop_id: session.shop_id.as_uuid(),
    };
    job_repo::enqueue(
        &mut tx,
        NewJob::new(
            ShopifyApplyDataFix::QUEUE,
            ShopifyApplyDataFix::SCHEMA,
            serde_json::to_value(job).map_err(|e| job_error(&e))?,
        )
        .idempotency_key(format!("{}:{id}", ShopifyApplyDataFix::QUEUE)),
    )
    .await?;
    audit::append(
        &mut tx,
        &audit::NewEntry {
            actor_kind: ActorKind::User,
            actor_id: Some(approver),
            action: "fix.approved".to_owned(),
            subject_type: "fix".to_owned(),
            subject_id: id,
            data: json!({"channel": "admin_api"}),
        },
    )
    .await?;
    let dto = one_fix(&mut tx, site, id).await?;
    tx.commit().await?;
    Ok(Json(dto))
}

/// Rejects a fix that is waiting for review; nothing changes in the shop.
#[utoipa::path(
    post,
    path = "/v1/shopify/fixes/{fix_id}/reject",
    tag = "app",
    operation_id = "rejectFix",
    security(("shopify_session" = [])),
    params(("fix_id" = String, Path, description = "The fix's identifier")),
    responses(
        (status = OK, description = "The rejected fix", body = FixDto),
        (status = NOT_FOUND, description = "No such fix",
            body = http_kit::Problem, content_type = "application/problem+json"),
        (status = CONFLICT, description = "The fix was already decided",
            body = http_kit::Problem, content_type = "application/problem+json"),
        (status = UNAUTHORIZED, description = "Missing or invalid session token",
            body = http_kit::Problem, content_type = "application/problem+json")
    )
)]
pub(crate) async fn reject_fix(
    State(state): State<AppState>,
    ShopSession(session): ShopSession,
    Path(fix_id): Path<String>,
) -> Result<Json<FixDto>, ApiError> {
    let id = uuid_of(&fix_id)?;
    let mut tx = state.db.tenant(session.tenant).await?;
    let site = site_of(&mut tx, session.shop_id).await?;
    app_views::fix(&mut tx, site, id)
        .await?
        .ok_or_else(not_found)?;
    if !app_views::reject(&mut tx, site, id).await? {
        return Err(ApiError::new(ProblemCode::Conflict).detail("The fix was already decided."));
    }
    audit::append(
        &mut tx,
        &audit::NewEntry {
            actor_kind: ActorKind::User,
            actor_id: session.user_id.clone(),
            action: "fix.rejected".to_owned(),
            subject_type: "fix".to_owned(),
            subject_id: id,
            data: json!({}),
        },
    )
    .await?;
    let dto = one_fix(&mut tx, site, id).await?;
    tx.commit().await?;
    Ok(Json(dto))
}

/// Undoes an applied fix: Rampsmith puts the earlier alt text back if nobody changed it since.
#[utoipa::path(
    post,
    path = "/v1/shopify/fixes/{fix_id}/undo",
    tag = "app",
    operation_id = "undoFix",
    security(("shopify_session" = [])),
    params(("fix_id" = String, Path, description = "The fix's identifier")),
    responses(
        (status = ACCEPTED, description = "The undo is queued; the fix reads reverted when done",
            body = FixDto),
        (status = NOT_FOUND, description = "No such fix",
            body = http_kit::Problem, content_type = "application/problem+json"),
        (status = CONFLICT, description = "The fix is not applied, or an undo is already running",
            body = http_kit::Problem, content_type = "application/problem+json"),
        (status = UNAUTHORIZED, description = "Missing or invalid session token",
            body = http_kit::Problem, content_type = "application/problem+json")
    )
)]
pub(crate) async fn undo_fix(
    State(state): State<AppState>,
    ShopSession(session): ShopSession,
    Path(fix_id): Path<String>,
) -> Result<(StatusCode, Json<FixDto>), ApiError> {
    let id = uuid_of(&fix_id)?;
    let mut tx = state.db.tenant(session.tenant).await?;
    let site = site_of(&mut tx, session.shop_id).await?;
    let fix = app_views::fix(&mut tx, site, id)
        .await?
        .ok_or_else(not_found)?;
    if !matches!(fix.status.as_str(), "applied" | "verified") {
        return Err(ApiError::new(ProblemCode::Conflict).detail("The fix is not applied."));
    }
    if app_views::revert_pending(&mut tx, id).await? {
        return Err(ApiError::new(ProblemCode::Conflict).detail("An undo is already running."));
    }
    let job = ShopifyRevertDataFix {
        fix_id: id,
        shop_id: session.shop_id.as_uuid(),
    };
    let key = format!(
        "{}:{id}:{}",
        ShopifyRevertDataFix::QUEUE,
        OffsetDateTime::now_utc().unix_timestamp()
    );
    job_repo::enqueue(
        &mut tx,
        NewJob::new(
            ShopifyRevertDataFix::QUEUE,
            ShopifyRevertDataFix::SCHEMA,
            serde_json::to_value(job).map_err(|e| job_error(&e))?,
        )
        .idempotency_key(key),
    )
    .await?;
    audit::append(
        &mut tx,
        &audit::NewEntry {
            actor_kind: ActorKind::User,
            actor_id: session.user_id.clone(),
            action: "fix.undo_requested".to_owned(),
            subject_type: "fix".to_owned(),
            subject_id: id,
            data: json!({}),
        },
    )
    .await?;
    let dto = one_fix(&mut tx, site, id).await?;
    tx.commit().await?;
    Ok((StatusCode::ACCEPTED, Json(dto)))
}

/// A screenshot taken before or after a fix.
#[utoipa::path(
    get,
    path = "/v1/shopify/evidence/{evidence_id}",
    tag = "app",
    operation_id = "getEvidence",
    security(("shopify_session" = [])),
    params(("evidence_id" = String, Path, description = "The evidence's identifier")),
    responses(
        (status = OK, description = "The evidence bytes", content_type = "image/png"),
        (status = NOT_FOUND, description = "No such evidence",
            body = http_kit::Problem, content_type = "application/problem+json"),
        (status = UNAUTHORIZED, description = "Missing or invalid session token",
            body = http_kit::Problem, content_type = "application/problem+json")
    )
)]
pub(crate) async fn get_evidence(
    State(state): State<AppState>,
    ShopSession(session): ShopSession,
    Path(evidence_id): Path<String>,
) -> Result<Response, ApiError> {
    let id = uuid_of(&evidence_id)?;
    let mut tx = state.db.tenant(session.tenant).await?;
    let (content_type, bytes) = app_views::evidence(&mut tx, id)
        .await?
        .ok_or_else(not_found)?;
    let mut response = (StatusCode::OK, bytes).into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&content_type)
            .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("default-src 'none'; sandbox"),
    );
    Ok(response)
}

// ---------------------------------------------------------------------------------------------
// Settings

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct SettingsDto {
    weekly_rescan: bool,
    notification_email: Option<String>,
    /// 40 to 300; 150 unless changed.
    alt_text_max_characters: i64,
    ai_budget_micro_usd: i64,
    /// The plan's ceiling for the budget.
    ai_budget_max_micro_usd: i64,
    storefront_password_set: bool,
    entitlements: EntitlementsDto,
}

/// A member that may be left out, null, or given.
#[derive(Debug, Default)]
enum Field<T> {
    /// Left out: keep what is stored.
    #[default]
    Absent,
    /// `null`: clear it.
    Null,
    /// A new value.
    Value(T),
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Field<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(match Option::<T>::deserialize(deserializer)? {
            None => Self::Null,
            Some(value) => Self::Value(value),
        })
    }
}

/// Fields left out stay as they are; `storefront_password: null` clears the saved password.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct SettingsUpdateBody {
    weekly_rescan: Option<bool>,
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    notification_email: Field<String>,
    alt_text_max_characters: Option<i64>,
    ai_budget_micro_usd: Option<i64>,
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    storefront_password: Field<String>,
}

async fn settings_dto(
    tx: &mut TenantTx,
    shop: ShopId,
    site: SiteId,
) -> Result<SettingsDto, ApiError> {
    let view = plan_view(tx, shop, OffsetDateTime::now_utc()).await?;
    let (document, password_set) = app_views::settings(tx, site).await?.ok_or_else(not_found)?;
    let ceiling = ceiling_of(&view.entitlements);
    let values = setting_values(&document, ceiling);
    Ok(SettingsDto {
        weekly_rescan: values.weekly_rescan,
        notification_email: values.notification_email,
        alt_text_max_characters: values.alt_text_max_characters,
        ai_budget_micro_usd: values.ai_budget_micro_usd,
        ai_budget_max_micro_usd: ceiling,
        storefront_password_set: password_set,
        entitlements: view.dto,
    })
}

/// The shop's settings.
#[utoipa::path(
    get,
    path = "/v1/shopify/settings",
    tag = "app",
    operation_id = "getSettings",
    security(("shopify_session" = [])),
    responses(
        (status = OK, description = "The settings", body = SettingsDto),
        (status = UNAUTHORIZED, description = "Missing or invalid session token",
            body = http_kit::Problem, content_type = "application/problem+json")
    )
)]
pub(crate) async fn get_settings(
    State(state): State<AppState>,
    ShopSession(session): ShopSession,
) -> Result<Json<SettingsDto>, ApiError> {
    let mut tx = state.db.tenant(session.tenant).await?;
    let site = site_of(&mut tx, session.shop_id).await?;
    Ok(Json(settings_dto(&mut tx, session.shop_id, site).await?))
}

/// A plausible address: one `@`, text either side, a dot in the domain, no spaces.
fn email_ok(email: &str) -> bool {
    let Some((local, domain)) = email.split_once('@') else {
        return false;
    };
    email.len() <= 254
        && !email.chars().any(char::is_whitespace)
        && !local.is_empty()
        && !domain.contains('@')
        && domain.split('.').count() >= 2
        && domain.split('.').all(|part| !part.is_empty())
}

/// Changes the shop's settings. Fields left out stay as they are.
#[utoipa::path(
    put,
    path = "/v1/shopify/settings",
    tag = "app",
    operation_id = "updateSettings",
    security(("shopify_session" = [])),
    request_body = SettingsUpdateBody,
    responses(
        (status = OK, description = "The settings after the change", body = SettingsDto),
        (status = FORBIDDEN, description = "The plan does not include weekly rescans",
            body = http_kit::Problem, content_type = "application/problem+json"),
        (status = UNPROCESSABLE_ENTITY, description = "A value is invalid",
            body = http_kit::Problem, content_type = "application/problem+json"),
        (status = SERVICE_UNAVAILABLE, description = "Saving a password is not configured",
            body = http_kit::Problem, content_type = "application/problem+json"),
        (status = UNAUTHORIZED, description = "Missing or invalid session token",
            body = http_kit::Problem, content_type = "application/problem+json")
    )
)]
pub(crate) async fn update_settings(
    State(state): State<AppState>,
    ShopSession(session): ShopSession,
    Body(body): Body<SettingsUpdateBody>,
) -> Result<Json<SettingsDto>, ApiError> {
    let mut tx = state.db.tenant(session.tenant).await?;
    let site = site_of(&mut tx, session.shop_id).await?;
    let view = plan_view(&mut tx, session.shop_id, OffsetDateTime::now_utc()).await?;
    let mut patch = validated_patch(&body, ceiling_of(&view.entitlements))?;
    if let Some(weekly) = body.weekly_rescan {
        if weekly
            && view.entitlements.render_cadence() == billing::entitlements::ScanCadence::Monthly
        {
            return Err(
                ApiError::new(ProblemCode::Forbidden).detail("Weekly rescans need a higher plan.")
            );
        }
        patch.insert("weekly_rescan".to_owned(), json!(weekly));
    }
    match &body.storefront_password {
        Field::Absent => {}
        Field::Null => {
            app_views::set_storefront_password(&mut tx, site, None).await?;
        }
        Field::Value(password) => {
            let keys = state.keys.as_ref().ok_or_else(|| {
                ApiError::new(ProblemCode::Unavailable)
                    .detail("Saving a storefront password is not configured.")
            })?;
            let sealed = keys
                .seal(
                    password.as_bytes(),
                    format!("sites/storefront_password/{}", site.as_uuid()).as_bytes(),
                )
                .map_err(|error| queue_error(&error))?;
            app_views::set_storefront_password(
                &mut tx,
                site,
                Some((sealed.bytes(), sealed.key_id().as_str())),
            )
            .await?;
        }
    }
    if !patch.is_empty() {
        app_views::merge_settings(&mut tx, site, &Value::Object(patch)).await?;
    }
    if !matches!(body.storefront_password, Field::Absent) || body.weekly_rescan.is_some() {
        let password = match &body.storefront_password {
            Field::Absent => None,
            Field::Null => Some("cleared"),
            Field::Value(_) => Some("set"),
        };
        audit::append(
            &mut tx,
            &audit::NewEntry {
                actor_kind: ActorKind::User,
                actor_id: session.user_id.clone(),
                action: "settings.updated".to_owned(),
                subject_type: "site".to_owned(),
                subject_id: site.as_uuid(),
                // Which settings changed, never the password or the address.
                data: json!({"storefront_password": password, "weekly_rescan": body.weekly_rescan}),
            },
        )
        .await?;
    }
    let dto = settings_dto(&mut tx, session.shop_id, site).await?;
    tx.commit().await?;
    Ok(Json(dto))
}

/// The settings document changes the request asks for, or every field that is invalid.
fn validated_patch(
    body: &SettingsUpdateBody,
    ceiling: i64,
) -> Result<serde_json::Map<String, Value>, ApiError> {
    let mut errors = Vec::new();
    let mut patch = serde_json::Map::new();
    match &body.notification_email {
        Field::Absent => {}
        Field::Null => {
            patch.insert("notification_email".to_owned(), Value::Null);
        }
        Field::Value(email) => match email.trim() {
            "" => {
                patch.insert("notification_email".to_owned(), Value::Null);
            }
            address if email_ok(address) => {
                patch.insert("notification_email".to_owned(), json!(address));
            }
            _ => errors.push(("notification_email", "is not an email address")),
        },
    }
    if let Some(characters) = body.alt_text_max_characters {
        if (ALT_MIN_CHARACTERS..=ALT_MAX_CHARACTERS).contains(&characters) {
            patch.insert("alt_text_max_characters".to_owned(), json!(characters));
        } else {
            errors.push(("alt_text_max_characters", "must be between 40 and 300"));
        }
    }
    if let Some(budget) = body.ai_budget_micro_usd {
        if (0..=ceiling).contains(&budget) {
            patch.insert("ai_budget_micro_usd".to_owned(), json!(budget));
        } else {
            errors.push(("ai_budget_micro_usd", "is outside what the plan allows"));
        }
    }
    if let Field::Value(password) = &body.storefront_password
        && (password.is_empty() || password.len() > 256)
    {
        errors.push(("storefront_password", "must be 1 to 256 characters"));
    }
    if errors.is_empty() {
        return Ok(patch);
    }
    Err(ApiError::new(ProblemCode::ValidationFailed).errors(
        errors
            .into_iter()
            .map(|(field, message)| FieldError {
                field: field.to_owned(),
                message: message.to_owned(),
            })
            .collect(),
    ))
}

// ---------------------------------------------------------------------------------------------
// Accessibility statement

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct StatementContact {
    email: String,
    phone: String,
    postal_address: String,
    form_url: String,
    response_time: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct StatementLimitation {
    description: String,
    reason: String,
    alternative: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct StatementContent {
    organization: String,
    contact: StatementContact,
    measures: Vec<String>,
    limitations: Vec<StatementLimitation>,
    compatibility: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct StatementVersionDto {
    id: String,
    version: i32,
    /// `draft` or `published`.
    status: String,
    created_at: String,
    published_at: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct StatementStateDto {
    /// The open draft, if there is one.
    draft: Option<StatementContent>,
    versions: Vec<StatementVersionDto>,
}

const STATEMENT_TEXT_MAX: usize = 2_000;
const STATEMENT_LIST_MAX: usize = 50;

fn check_statement(content: &StatementContent) -> Vec<FieldError> {
    let mut errors = Vec::new();
    let mut bad = |field: String, message: &str| {
        errors.push(FieldError {
            field,
            message: message.to_owned(),
        });
    };
    let long = |text: &str| text.chars().count() > STATEMENT_TEXT_MAX;
    if long(&content.organization) {
        bad("organization".to_owned(), "is too long");
    }
    let contact = &content.contact;
    if !contact.email.is_empty() && !email_ok(&contact.email) {
        bad("contact.email".to_owned(), "is not an email address");
    }
    if !contact.form_url.is_empty() {
        let https = url::Url::parse(&contact.form_url)
            .is_ok_and(|url| url.scheme() == "https" && url.host_str().is_some());
        if !https {
            bad("contact.form_url".to_owned(), "must be an https address");
        }
    }
    for (name, text) in [
        ("contact.phone", &contact.phone),
        ("contact.postal_address", &contact.postal_address),
        ("contact.response_time", &contact.response_time),
        ("compatibility", &content.compatibility),
    ] {
        if long(text) {
            bad(name.to_owned(), "is too long");
        }
    }
    if content.measures.len() > STATEMENT_LIST_MAX {
        bad("measures".to_owned(), "has too many items");
    }
    for (index, measure) in content.measures.iter().enumerate() {
        if long(measure) {
            bad(format!("measures.{index}"), "is too long");
        }
    }
    if content.limitations.len() > STATEMENT_LIST_MAX {
        bad("limitations".to_owned(), "has too many items");
    }
    for (index, item) in content.limitations.iter().enumerate() {
        for (name, text) in [
            ("description", &item.description),
            ("reason", &item.reason),
            ("alternative", &item.alternative),
        ] {
            if long(text) {
                bad(format!("limitations.{index}.{name}"), "is too long");
            }
        }
    }
    errors
}

async fn statement_state(tx: &mut TenantTx, site: SiteId) -> Result<StatementStateDto, ApiError> {
    let rows = app_views::statements(tx, site).await?;
    let draft = rows
        .iter()
        .find(|row| row.status == "draft")
        .and_then(|row| serde_json::from_value(row.content.clone()).ok());
    Ok(StatementStateDto {
        draft,
        versions: rows
            .into_iter()
            .map(|row| StatementVersionDto {
                id: row.id.to_string(),
                version: row.version,
                status: row.status,
                created_at: ts(row.created_at),
                published_at: ts_opt(row.published_at),
            })
            .collect(),
    })
}

/// The accessibility statement: the open draft and the saved versions.
#[utoipa::path(
    get,
    path = "/v1/shopify/statement",
    tag = "app",
    operation_id = "getStatement",
    security(("shopify_session" = [])),
    responses(
        (status = OK, description = "The statement", body = StatementStateDto),
        (status = UNAUTHORIZED, description = "Missing or invalid session token",
            body = http_kit::Problem, content_type = "application/problem+json")
    )
)]
pub(crate) async fn get_statement(
    State(state): State<AppState>,
    ShopSession(session): ShopSession,
) -> Result<Json<StatementStateDto>, ApiError> {
    let mut tx = state.db.tenant(session.tenant).await?;
    let site = site_of(&mut tx, session.shop_id).await?;
    Ok(Json(statement_state(&mut tx, site).await?))
}

/// Saves the statement as the draft.
#[utoipa::path(
    put,
    path = "/v1/shopify/statement",
    tag = "app",
    operation_id = "saveStatement",
    security(("shopify_session" = [])),
    request_body = StatementContent,
    responses(
        (status = OK, description = "The statement after saving", body = StatementStateDto),
        (status = UNPROCESSABLE_ENTITY, description = "A field is invalid",
            body = http_kit::Problem, content_type = "application/problem+json"),
        (status = UNAUTHORIZED, description = "Missing or invalid session token",
            body = http_kit::Problem, content_type = "application/problem+json")
    )
)]
pub(crate) async fn save_statement(
    State(state): State<AppState>,
    ShopSession(session): ShopSession,
    Body(content): Body<StatementContent>,
) -> Result<Json<StatementStateDto>, ApiError> {
    let errors = check_statement(&content);
    if !errors.is_empty() {
        return Err(ApiError::new(ProblemCode::ValidationFailed).errors(errors));
    }
    let mut tx = state.db.tenant(session.tenant).await?;
    let site = site_of(&mut tx, session.shop_id).await?;
    let value = serde_json::to_value(&content).map_err(|e| job_error(&e))?;
    app_views::save_draft(&mut tx, site, &value).await?;
    let dto = statement_state(&mut tx, site).await?;
    tx.commit().await?;
    Ok(Json(dto))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emails_need_an_at_and_a_dotted_domain() {
        assert!(email_ok("owner@shop.example"));
        assert!(!email_ok("owner@shop"));
        assert!(!email_ok("@shop.example"));
        assert!(!email_ok("a b@shop.example"));
        assert!(!email_ok("a@@shop.example"));
    }

    #[test]
    fn a_setting_outside_its_range_falls_back_to_the_default() {
        let values = setting_values(
            &json!({"alt_text_max_characters": 9, "ai_budget_micro_usd": 99}),
            50,
        );
        assert_eq!(values.alt_text_max_characters, ALT_DEFAULT_CHARACTERS);
        assert_eq!(
            values.ai_budget_micro_usd, 50,
            "clamped to the plan's ceiling"
        );
        assert!(!values.weekly_rescan);
    }

    #[test]
    fn a_cursor_is_an_offset() {
        assert_eq!(paging(None, None).ok(), Some((0, PAGE)));
        assert_eq!(
            paging(Some(&"50".to_owned()), Some(10)).ok(),
            Some((50, 10))
        );
        assert!(paging(Some(&"-1".to_owned()), None).is_err());
        assert!(paging(Some(&"abc".to_owned()), None).is_err());
        assert!(paging(None, Some(0)).is_err());
        assert!(paging(None, Some(101)).is_err());
    }
}
