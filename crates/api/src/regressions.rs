//! The embedded app's regression routes (ADR-310, ADR-311): the records the engine writes after
//! each scheduled scan is compared with the scan before it. Regression alerts are a Growth
//! feature (PLAN §20): on a plan without them the list is empty and the answer names the plan
//! that unlocks it, so the screen can show the locked state Built for Shopify asks for (4.3.7).

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use billing::entitlements::{Feature, Gate, feature_gate};
use db::TenantTx;
use db::repo::regressions::{self, RegressionRow};
use domain::{ActorKind, ShopId, SiteId};
use http_kit::ApiError;
use serde::Serialize;
use serde_json::{Value, json};
use time::OffsetDateTime;
use utoipa::ToSchema;

use crate::AppState;
use crate::r1::{self, actor_id, not_found, site_of, ts};
use crate::shopify::ShopSession;

/// Records shown in the list.
const LIST_LIMIT: i64 = 50;
/// How long a record stays in the overview's banner.
pub(crate) const BANNER_DAYS: i32 = 7;

/// One finding on a regression record.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct RegressionItemDto {
    /// The finding's id; its page is `/app/findings/<id>`.
    finding_id: String,
    /// The rule that failed.
    rule_id: String,
    /// One plain-language sentence naming the problem.
    title: String,
    /// `minor`, `moderate`, `serious` or `critical`.
    impact: String,
    /// WCAG success criteria.
    criteria: Vec<String>,
    /// `new` or `reappeared`.
    kind: String,
}

/// A scheduled scan compared with the one before it.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct RegressionDto {
    id: String,
    scan_id: String,
    previous_scan_id: Option<String>,
    /// Open findings never seen before this scan.
    new_count: i32,
    /// Findings seen earlier, absent from the previous scan, open again.
    reappeared_count: i32,
    /// Findings this scan recorded (best practices left out).
    findings_seen: i32,
    previous_findings_seen: Option<i32>,
    /// Checks passed over checks run, as a percentage.
    pass_rate: Option<f64>,
    previous_pass_rate: Option<f64>,
    /// The most severe findings; the counts above are the totals.
    items: Vec<RegressionItemDto>,
    detected_at: String,
    dismissed: bool,
}

pub(crate) fn dto(row: RegressionRow) -> RegressionDto {
    let text = |item: &Value, key: &str| {
        item.get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    let items = row
        .items
        .as_array()
        .map(|list| {
            list.iter()
                .map(|item| RegressionItemDto {
                    finding_id: text(item, "finding_id"),
                    rule_id: text(item, "rule_id"),
                    title: crate::rules::text(&text(item, "rule_id")).title.to_owned(),
                    impact: text(item, "impact"),
                    criteria: item
                        .get("criteria")
                        .and_then(Value::as_array)
                        .map(|c| {
                            c.iter()
                                .filter_map(Value::as_str)
                                .map(str::to_owned)
                                .collect()
                        })
                        .unwrap_or_default(),
                    kind: text(item, "kind"),
                })
                .collect()
        })
        .unwrap_or_default();
    RegressionDto {
        id: row.id.to_string(),
        scan_id: row.scan_id.to_string(),
        previous_scan_id: row.previous_scan_id.map(|id| id.to_string()),
        new_count: row.new_count,
        reappeared_count: row.reappeared_count,
        findings_seen: row.findings_seen,
        previous_findings_seen: row.previous_findings_seen,
        pass_rate: row.pass_rate,
        previous_pass_rate: row.previous_pass_rate,
        items,
        detected_at: ts(row.detected_at),
        dismissed: row.dismissed_at.is_some(),
    }
}

/// The regressions list and whether the plan includes it.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct RegressionListDto {
    /// `allowed`, or `locked` when the plan has no regression alerts.
    gate: String,
    /// The lowest plan that unlocks regression alerts, when locked.
    unlocked_by: Option<String>,
    /// Records that found something, newest first; empty when locked.
    items: Vec<RegressionDto>,
}

/// Whether the shop's plan includes regression alerts: `None` when it does, else the plan that
/// unlocks them.
pub(crate) async fn locked_by(
    tx: &mut TenantTx,
    shop: ShopId,
    now: OffsetDateTime,
) -> Result<Option<String>, ApiError> {
    let view = r1::plan_view(tx, shop, now).await?;
    Ok(
        match feature_gate(view.entitlements.plan(), Feature::RegressionAlerts) {
            Gate::Allowed => None,
            Gate::Locked { unlocked_by } => Some(unlocked_by.handle().to_owned()),
            Gate::Unavailable => Some("pro".to_owned()),
        },
    )
}

/// The newest record that found something and is neither dismissed nor older than a week; null
/// on a plan without regression alerts.
pub(crate) async fn banner(
    tx: &mut TenantTx,
    shop: ShopId,
    site: SiteId,
    now: OffsetDateTime,
) -> Result<Option<RegressionDto>, ApiError> {
    if locked_by(tx, shop, now).await?.is_some() {
        return Ok(None);
    }
    Ok(regressions::banner(tx, site, BANNER_DAYS).await?.map(dto))
}

/// The scheduled scans that found new or returning failures.
#[utoipa::path(
    get,
    path = "/v1/shopify/regressions",
    tag = "app",
    operation_id = "listRegressions",
    security(("shopify_session" = [])),
    responses(
        (status = OK, description = "The regressions, or the plan that unlocks them",
            body = RegressionListDto),
        (status = UNAUTHORIZED, description = "Missing or invalid session token",
            body = http_kit::Problem, content_type = "application/problem+json")
    )
)]
pub(crate) async fn list_regressions(
    State(state): State<AppState>,
    ShopSession(session): ShopSession,
) -> Result<Json<RegressionListDto>, ApiError> {
    let mut tx = state.db.tenant(session.tenant).await?;
    let site = site_of(&mut tx, session.shop_id).await?;
    let locked = locked_by(&mut tx, session.shop_id, OffsetDateTime::now_utc()).await?;
    let items = if locked.is_some() {
        Vec::new()
    } else {
        regressions::list(&mut tx, site, LIST_LIMIT)
            .await?
            .into_iter()
            .map(dto)
            .collect()
    };
    Ok(Json(RegressionListDto {
        gate: if locked.is_some() {
            "locked"
        } else {
            "allowed"
        }
        .to_owned(),
        unlocked_by: locked,
        items,
    }))
}

/// Hides the overview banner for a record.
#[utoipa::path(
    post,
    path = "/v1/shopify/regressions/{regression_id}/dismiss",
    tag = "app",
    operation_id = "dismissRegression",
    security(("shopify_session" = [])),
    params(("regression_id" = String, Path, description = "The record's identifier")),
    responses(
        (status = NO_CONTENT, description = "The banner is hidden"),
        (status = NOT_FOUND, description = "No such record",
            body = http_kit::Problem, content_type = "application/problem+json"),
        (status = UNAUTHORIZED, description = "Missing or invalid session token",
            body = http_kit::Problem, content_type = "application/problem+json")
    )
)]
pub(crate) async fn dismiss_regression(
    State(state): State<AppState>,
    ShopSession(session): ShopSession,
    Path(regression_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let id = r1::uuid_of(&regression_id)?;
    let mut tx = state.db.tenant(session.tenant).await?;
    let site = site_of(&mut tx, session.shop_id).await?;
    if !regressions::dismiss(&mut tx, site, id).await? {
        return Err(not_found());
    }
    db::repo::audit::append(
        &mut tx,
        &db::repo::audit::NewEntry {
            actor_kind: ActorKind::User,
            actor_id: actor_id(&session),
            action: "regression.dismissed".to_owned(),
            subject_type: "regression".to_owned(),
            subject_id: id,
            data: json!({}),
        },
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
