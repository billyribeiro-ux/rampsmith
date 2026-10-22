//! The R1 embedded-app routes, as stubs (ADR-038).
//!
//! Phase 0 declares every route the R1 App Home calls, so the OpenAPI document and the router
//! carry them from the start and the three lanes do not all edit `lib.rs`. Each answers 503
//! until the fix-loop lane (A) replaces its body and documents its real request and response.
//! Lane A edits this file and `lib.rs` only to register a new route; the stubs are
//! authenticated, so no unauthenticated caller learns which ones exist.

use axum::extract::{Path, State};
use http_kit::{ApiError, ProblemCode};

use crate::AppState;
use crate::shopify::ShopSession;

fn not_yet(what: &str) -> ApiError {
    ApiError::new(ProblemCode::Unavailable)
        .detail(format!("{what} is not available in this build."))
}

/// The pass rate, open findings by impact, fixes awaiting approval, and the last and next scan.
#[utoipa::path(
    get,
    path = "/v1/shopify/overview",
    tag = "app",
    operation_id = "getOverview",
    security(("shopify_session" = [])),
    responses(
        (status = SERVICE_UNAVAILABLE, description = "Not available yet",
            body = http_kit::Problem, content_type = "application/problem+json")
    )
)]
pub(crate) async fn get_overview(
    State(_): State<AppState>,
    ShopSession(_): ShopSession,
) -> Result<(), ApiError> {
    Err(not_yet("getOverview"))
}

/// Starts a scan of the shop.
#[utoipa::path(
    post,
    path = "/v1/shopify/scans",
    tag = "app",
    operation_id = "startScan",
    security(("shopify_session" = [])),
    responses(
        (status = SERVICE_UNAVAILABLE, description = "Not available yet",
            body = http_kit::Problem, content_type = "application/problem+json")
    )
)]
pub(crate) async fn start_scan(
    State(_): State<AppState>,
    ShopSession(_): ShopSession,
) -> Result<(), ApiError> {
    Err(not_yet("startScan"))
}

/// One scan, with its progress and coverage.
#[utoipa::path(
    get,
    path = "/v1/shopify/scans/{scan_id}",
    tag = "app",
    operation_id = "getScan",
    security(("shopify_session" = [])),
    params(("scan_id" = String, Path, description = "The identifier in the path")),
    responses(
        (status = SERVICE_UNAVAILABLE, description = "Not available yet",
            body = http_kit::Problem, content_type = "application/problem+json")
    )
)]
pub(crate) async fn get_scan(
    State(_): State<AppState>,
    ShopSession(_): ShopSession,
    Path(_): Path<String>,
) -> Result<(), ApiError> {
    Err(not_yet("getScan"))
}

/// Open findings, ranked by priority score.
#[utoipa::path(
    get,
    path = "/v1/shopify/findings",
    tag = "app",
    operation_id = "listFindings",
    security(("shopify_session" = [])),
    responses(
        (status = SERVICE_UNAVAILABLE, description = "Not available yet",
            body = http_kit::Problem, content_type = "application/problem+json")
    )
)]
pub(crate) async fn list_findings(
    State(_): State<AppState>,
    ShopSession(_): ShopSession,
) -> Result<(), ApiError> {
    Err(not_yet("listFindings"))
}

/// One finding, with its evidence and affected templates.
#[utoipa::path(
    get,
    path = "/v1/shopify/findings/{finding_id}",
    tag = "app",
    operation_id = "getFinding",
    security(("shopify_session" = [])),
    params(("finding_id" = String, Path, description = "The identifier in the path")),
    responses(
        (status = SERVICE_UNAVAILABLE, description = "Not available yet",
            body = http_kit::Problem, content_type = "application/problem+json")
    )
)]
pub(crate) async fn get_finding(
    State(_): State<AppState>,
    ShopSession(_): ShopSession,
    Path(_): Path<String>,
) -> Result<(), ApiError> {
    Err(not_yet("getFinding"))
}

/// Fixes by state: the approval queue and the remediation log.
#[utoipa::path(
    get,
    path = "/v1/shopify/fixes",
    tag = "app",
    operation_id = "listFixes",
    security(("shopify_session" = [])),
    responses(
        (status = SERVICE_UNAVAILABLE, description = "Not available yet",
            body = http_kit::Problem, content_type = "application/problem+json")
    )
)]
pub(crate) async fn list_fixes(
    State(_): State<AppState>,
    ShopSession(_): ShopSession,
) -> Result<(), ApiError> {
    Err(not_yet("listFixes"))
}

/// Edits a proposed fix, such as an alt-text draft.
#[utoipa::path(
    put,
    path = "/v1/shopify/fixes/{fix_id}",
    tag = "app",
    operation_id = "editFix",
    security(("shopify_session" = [])),
    params(("fix_id" = String, Path, description = "The identifier in the path")),
    responses(
        (status = SERVICE_UNAVAILABLE, description = "Not available yet",
            body = http_kit::Problem, content_type = "application/problem+json")
    )
)]
pub(crate) async fn edit_fix(
    State(_): State<AppState>,
    ShopSession(_): ShopSession,
    Path(_): Path<String>,
) -> Result<(), ApiError> {
    Err(not_yet("editFix"))
}

/// Approves a proposed fix and applies it.
#[utoipa::path(
    post,
    path = "/v1/shopify/fixes/{fix_id}/approve",
    tag = "app",
    operation_id = "approveFix",
    security(("shopify_session" = [])),
    params(("fix_id" = String, Path, description = "The identifier in the path")),
    responses(
        (status = SERVICE_UNAVAILABLE, description = "Not available yet",
            body = http_kit::Problem, content_type = "application/problem+json")
    )
)]
pub(crate) async fn approve_fix(
    State(_): State<AppState>,
    ShopSession(_): ShopSession,
    Path(_): Path<String>,
) -> Result<(), ApiError> {
    Err(not_yet("approveFix"))
}

/// Rejects a proposed fix.
#[utoipa::path(
    post,
    path = "/v1/shopify/fixes/{fix_id}/reject",
    tag = "app",
    operation_id = "rejectFix",
    security(("shopify_session" = [])),
    params(("fix_id" = String, Path, description = "The identifier in the path")),
    responses(
        (status = SERVICE_UNAVAILABLE, description = "Not available yet",
            body = http_kit::Problem, content_type = "application/problem+json")
    )
)]
pub(crate) async fn reject_fix(
    State(_): State<AppState>,
    ShopSession(_): ShopSession,
    Path(_): Path<String>,
) -> Result<(), ApiError> {
    Err(not_yet("rejectFix"))
}

/// Reverts an applied fix.
#[utoipa::path(
    post,
    path = "/v1/shopify/fixes/{fix_id}/undo",
    tag = "app",
    operation_id = "undoFix",
    security(("shopify_session" = [])),
    params(("fix_id" = String, Path, description = "The identifier in the path")),
    responses(
        (status = SERVICE_UNAVAILABLE, description = "Not available yet",
            body = http_kit::Problem, content_type = "application/problem+json")
    )
)]
pub(crate) async fn undo_fix(
    State(_): State<AppState>,
    ShopSession(_): ShopSession,
    Path(_): Path<String>,
) -> Result<(), ApiError> {
    Err(not_yet("undoFix"))
}

/// An evidence crop (PNG or WebP), served from the database (ADR-035).
#[utoipa::path(
    get,
    path = "/v1/shopify/evidence/{evidence_id}",
    tag = "app",
    operation_id = "getEvidence",
    security(("shopify_session" = [])),
    params(("evidence_id" = String, Path, description = "The identifier in the path")),
    responses(
        (status = SERVICE_UNAVAILABLE, description = "Not available yet",
            body = http_kit::Problem, content_type = "application/problem+json")
    )
)]
pub(crate) async fn get_evidence(
    State(_): State<AppState>,
    ShopSession(_): ShopSession,
    Path(_): Path<String>,
) -> Result<(), ApiError> {
    Err(not_yet("getEvidence"))
}

/// Scan schedule, storefront password state, AI budget and notification email.
#[utoipa::path(
    get,
    path = "/v1/shopify/settings",
    tag = "app",
    operation_id = "getSettings",
    security(("shopify_session" = [])),
    responses(
        (status = SERVICE_UNAVAILABLE, description = "Not available yet",
            body = http_kit::Problem, content_type = "application/problem+json")
    )
)]
pub(crate) async fn get_settings(
    State(_): State<AppState>,
    ShopSession(_): ShopSession,
) -> Result<(), ApiError> {
    Err(not_yet("getSettings"))
}

/// Changes the shop's settings.
#[utoipa::path(
    put,
    path = "/v1/shopify/settings",
    tag = "app",
    operation_id = "updateSettings",
    security(("shopify_session" = [])),
    responses(
        (status = SERVICE_UNAVAILABLE, description = "Not available yet",
            body = http_kit::Problem, content_type = "application/problem+json")
    )
)]
pub(crate) async fn update_settings(
    State(_): State<AppState>,
    ShopSession(_): ShopSession,
) -> Result<(), ApiError> {
    Err(not_yet("updateSettings"))
}

/// The accessibility statement versions.
#[utoipa::path(
    get,
    path = "/v1/shopify/statement",
    tag = "app",
    operation_id = "getStatement",
    security(("shopify_session" = [])),
    responses(
        (status = SERVICE_UNAVAILABLE, description = "Not available yet",
            body = http_kit::Problem, content_type = "application/problem+json")
    )
)]
pub(crate) async fn get_statement(
    State(_): State<AppState>,
    ShopSession(_): ShopSession,
) -> Result<(), ApiError> {
    Err(not_yet("getStatement"))
}

/// Saves a draft of the accessibility statement.
#[utoipa::path(
    put,
    path = "/v1/shopify/statement",
    tag = "app",
    operation_id = "saveStatement",
    security(("shopify_session" = [])),
    responses(
        (status = SERVICE_UNAVAILABLE, description = "Not available yet",
            body = http_kit::Problem, content_type = "application/problem+json")
    )
)]
pub(crate) async fn save_statement(
    State(_): State<AppState>,
    ShopSession(_): ShopSession,
) -> Result<(), ApiError> {
    Err(not_yet("saveStatement"))
}
