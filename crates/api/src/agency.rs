//! Agency accounts and store links (ADR-313, ADR-314).
//!
//! The dashboard side (`/v1/agency/*`, a signed-in user) creates organizations, mints link codes
//! and reads the cross-store overview. The App Home side (`/v1/shopify/agency-links*`, a verified
//! Shopify session) previews a code, approves the link for its own shop and revokes it. The
//! agency never reads a store directly: the overview is `db::repo::agency::linked_stores`, which
//! starts from the user's memberships and live links.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use db::repo::agency::{self, CodeRefused, LinkedStore};
use domain::ActorKind;
use http_kit::{ApiError, ProblemCode};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use time::{Duration, OffsetDateTime};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::AppState;
use crate::auth::UserSession;
use crate::r1::{actor_id, not_found, ts, uuid_of};
use crate::shopify::ShopSession;

/// How long a link code works.
const CODE_TTL: Duration = Duration::days(1);
/// Wrong codes a shop may try in an hour before it is refused outright.
const MAX_REJECTED_PER_HOUR: i64 = 5;
/// Organizations one user may create.
const MAX_ORGANIZATIONS: usize = 5;

/// Crockford base32 without `I`, `L`, `O`, `U`: 32 symbols, so a masked random byte is uniform.
const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LEN: usize = 10;

/// A new link code, shown as `XXXXX-XXXXX`: 50 bits from the operating system's generator.
fn new_code() -> String {
    let raw: [u8; CODE_LEN] = rand::random();
    let symbols: Vec<char> = raw
        .iter()
        .filter_map(|b| ALPHABET.get(usize::from(b & 31)).copied().map(char::from))
        .collect();
    let (head, tail) = symbols.split_at(5);
    format!(
        "{}-{}",
        head.iter().collect::<String>(),
        tail.iter().collect::<String>()
    )
}

/// The canonical form of a code a person typed: upper case, no dashes or spaces, `O` read as `0`
/// and `I` or `L` as `1`. `None` for anything that is not ten symbols of the alphabet.
fn normalize(text: &str) -> Option<String> {
    let canonical: String = text
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .map(|c| match c.to_ascii_uppercase() {
            'O' => '0',
            'I' | 'L' => '1',
            other => other,
        })
        .collect();
    (canonical.len() == CODE_LEN && canonical.bytes().all(|b| ALPHABET.contains(&b)))
        .then_some(canonical)
}

fn hash_of(canonical: &str) -> Vec<u8> {
    Sha256::digest(canonical.as_bytes()).to_vec()
}

fn bad_code() -> ApiError {
    ApiError::new(ProblemCode::NotFound).detail("This code is not valid, or it has expired.")
}

// ---------------------------------------------------------------------------------------------
// Dashboard: organizations, codes, overview

/// An organization the signed-in user belongs to.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct OrganizationDto {
    id: String,
    name: String,
    /// `owner` or `member`.
    role: String,
}

impl From<agency::Organization> for OrganizationDto {
    fn from(o: agency::Organization) -> Self {
        Self {
            id: o.id.to_string(),
            name: o.name,
            role: o.role,
        }
    }
}

/// The user's organizations.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct OrganizationsDto {
    organizations: Vec<OrganizationDto>,
}

/// Lists the signed-in user's organizations.
#[utoipa::path(
    get,
    path = "/v1/agency/organizations",
    tag = "agency",
    operation_id = "listOrganizations",
    security(("dashboard_session" = [])),
    responses(
        (status = OK, body = OrganizationsDto),
        (status = UNAUTHORIZED, body = http_kit::Problem, content_type = "application/problem+json")
    )
)]
pub(crate) async fn list_organizations(
    State(state): State<AppState>,
    session: UserSession,
) -> Result<Json<OrganizationsDto>, ApiError> {
    let mut tx = state.db.identity().await?;
    let organizations = agency::organizations_of(&mut tx, session.user.id).await?;
    Ok(Json(OrganizationsDto {
        organizations: organizations.into_iter().map(Into::into).collect(),
    }))
}

/// What to call a new organization.
#[derive(Debug, Deserialize, ToSchema)]
pub(crate) struct NewOrganization {
    name: String,
}

/// Creates an organization with the signed-in user as its owner.
#[utoipa::path(
    post,
    path = "/v1/agency/organizations",
    tag = "agency",
    operation_id = "createOrganization",
    security(("dashboard_session" = [])),
    request_body = NewOrganization,
    responses(
        (status = CREATED, body = OrganizationDto),
        (status = UNPROCESSABLE_ENTITY, body = http_kit::Problem, content_type = "application/problem+json"),
        (status = CONFLICT, description = "The user already has the most organizations allowed",
            body = http_kit::Problem, content_type = "application/problem+json"),
        (status = UNAUTHORIZED, body = http_kit::Problem, content_type = "application/problem+json")
    )
)]
pub(crate) async fn create_organization(
    State(state): State<AppState>,
    session: UserSession,
    Json(request): Json<NewOrganization>,
) -> Result<(StatusCode, Json<OrganizationDto>), ApiError> {
    let name = request.name.trim();
    let length = name.chars().count();
    if length == 0 || length > 100 || name.chars().any(char::is_control) {
        return Err(ApiError::new(ProblemCode::ValidationFailed)
            .detail("The name must be 1 to 100 characters."));
    }
    let mut tx = state.db.identity().await?;
    if agency::organizations_of(&mut tx, session.user.id)
        .await?
        .len()
        >= MAX_ORGANIZATIONS
    {
        return Err(ApiError::new(ProblemCode::Conflict).detail(format!(
            "An account can hold {MAX_ORGANIZATIONS} organizations."
        )));
    }
    let created =
        agency::create_organization(&mut tx, Uuid::now_v7(), name, session.user.id).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(created.into())))
}

/// A link code, shown once.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct LinkCodeDto {
    /// `XXXXX-XXXXX`. The merchant types it into the app; it is not stored and cannot be shown again.
    code: String,
    expires_at: String,
}

/// Makes a code a merchant can use to link a store to this organization.
#[utoipa::path(
    post,
    path = "/v1/agency/organizations/{organization_id}/link-codes",
    tag = "agency",
    operation_id = "createLinkCode",
    security(("dashboard_session" = [])),
    params(("organization_id" = String, Path, description = "The organization's identifier")),
    responses(
        (status = CREATED, body = LinkCodeDto),
        (status = NOT_FOUND, description = "No such organization, or the user is not a member",
            body = http_kit::Problem, content_type = "application/problem+json"),
        (status = TOO_MANY_REQUESTS, description = "The organization already holds the most live codes",
            body = http_kit::Problem, content_type = "application/problem+json"),
        (status = UNAUTHORIZED, body = http_kit::Problem, content_type = "application/problem+json")
    )
)]
pub(crate) async fn create_link_code(
    State(state): State<AppState>,
    session: UserSession,
    Path(organization_id): Path<String>,
) -> Result<(StatusCode, Json<LinkCodeDto>), ApiError> {
    let organization = uuid_of(&organization_id)?;
    let code = new_code();
    let canonical = normalize(&code).ok_or_else(|| ApiError::new(ProblemCode::Internal))?;
    let expires_at = OffsetDateTime::now_utc() + CODE_TTL;
    let mut tx = state.db.identity().await?;
    match agency::create_code(
        &mut tx,
        Uuid::now_v7(),
        organization,
        session.user.id,
        &hash_of(&canonical),
        expires_at,
    )
    .await?
    {
        Ok(()) => {}
        Err(CodeRefused::NotMember) => return Err(not_found()),
        Err(CodeRefused::TooMany) => {
            return Err(ApiError::new(ProblemCode::RateLimited).detail(format!(
                "{} codes are waiting to be used. Wait for one to expire.",
                agency::MAX_LIVE_CODES
            )));
        }
    }
    tx.commit().await?;
    Ok((
        StatusCode::CREATED,
        Json(LinkCodeDto {
            code,
            expires_at: ts(expires_at),
        }),
    ))
}

/// One linked store in the overview.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct LinkedStoreDto {
    link_id: String,
    organization_id: String,
    organization_name: String,
    shop_domain: String,
    granted_at: String,
    /// The latest scan's status, when the store has been scanned.
    scan_status: Option<String>,
    /// What started it: `manual`, `scheduled` or `webhook`.
    scan_trigger: Option<String>,
    scan_at: Option<String>,
    /// Checks passed over checks run in the latest finished scan, as a percentage.
    pass_rate: Option<f64>,
    open_findings: i32,
    /// Of those, serious or critical.
    open_serious: i32,
    /// New findings in the latest regression of the last 30 days that the merchant has not dismissed.
    regression_new: Option<i32>,
    regression_reappeared: Option<i32>,
    regression_at: Option<String>,
}

fn store_dto(s: LinkedStore) -> LinkedStoreDto {
    let finished = matches!(s.scan_status.as_deref(), Some("succeeded" | "partial"));
    let pass_rate = match (finished, s.checks_run, s.checks_passed) {
        (true, Some(run), Some(passed)) if run > 0 => {
            Some((f64::from(passed) * 1000.0 / f64::from(run)).round() / 10.0)
        }
        _ => None,
    };
    LinkedStoreDto {
        link_id: s.link_id.to_string(),
        organization_id: s.organization_id.to_string(),
        organization_name: s.organization_name,
        shop_domain: s.shop_domain,
        granted_at: ts(s.granted_at),
        scan_status: s.scan_status,
        scan_trigger: s.scan_trigger,
        scan_at: s.scan_at.map(ts),
        pass_rate,
        open_findings: s.open_findings,
        open_serious: s.open_serious,
        regression_new: s.regression_new,
        regression_reappeared: s.regression_reappeared,
        regression_at: s.regression_at.map(ts),
    }
}

/// The stores that granted a link to one of the user's organizations.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct LinkedStoresDto {
    stores: Vec<LinkedStoreDto>,
}

/// The cross-store overview: only stores whose merchant approved a link, and only until it is revoked.
#[utoipa::path(
    get,
    path = "/v1/agency/stores",
    tag = "agency",
    operation_id = "listLinkedStores",
    security(("dashboard_session" = [])),
    responses(
        (status = OK, body = LinkedStoresDto),
        (status = UNAUTHORIZED, body = http_kit::Problem, content_type = "application/problem+json")
    )
)]
pub(crate) async fn list_linked_stores(
    State(state): State<AppState>,
    session: UserSession,
) -> Result<Json<LinkedStoresDto>, ApiError> {
    let mut tx = state.db.identity().await?;
    let stores = agency::linked_stores(&mut tx, session.user.id).await?;
    Ok(Json(LinkedStoresDto {
        stores: stores.into_iter().map(store_dto).collect(),
    }))
}

/// Ends a link from the agency's side.
#[utoipa::path(
    delete,
    path = "/v1/agency/links/{link_id}",
    tag = "agency",
    operation_id = "unlinkStore",
    security(("dashboard_session" = [])),
    params(("link_id" = String, Path, description = "The link's identifier")),
    responses(
        (status = NO_CONTENT, description = "The link ended"),
        (status = NOT_FOUND, description = "No such live link in one of the user's organizations",
            body = http_kit::Problem, content_type = "application/problem+json"),
        (status = UNAUTHORIZED, body = http_kit::Problem, content_type = "application/problem+json")
    )
)]
pub(crate) async fn unlink_store(
    State(state): State<AppState>,
    session: UserSession,
    Path(link_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let link = uuid_of(&link_id)?;
    let mut tx = state.db.identity().await?;
    if !agency::unlink(&mut tx, session.user.id, link).await? {
        return Err(not_found());
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------------------------
// App Home: the merchant approves and revokes

/// A live link on the shop.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct ShopLinkDto {
    id: String,
    organization_name: String,
    granted_at: String,
}

/// The shop's live agency links.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct ShopLinksDto {
    links: Vec<ShopLinkDto>,
}

fn link_dto(l: agency::ShopLink) -> ShopLinkDto {
    ShopLinkDto {
        id: l.id.to_string(),
        organization_name: l.organization_name,
        granted_at: ts(l.granted_at),
    }
}

/// Lists the agencies that can see this store.
#[utoipa::path(
    get,
    path = "/v1/shopify/agency-links",
    tag = "app",
    operation_id = "listAgencyLinks",
    security(("shopify_session" = [])),
    responses(
        (status = OK, body = ShopLinksDto),
        (status = UNAUTHORIZED, body = http_kit::Problem, content_type = "application/problem+json")
    )
)]
pub(crate) async fn list_agency_links(
    State(state): State<AppState>,
    ShopSession(session): ShopSession,
) -> Result<Json<ShopLinksDto>, ApiError> {
    let mut tx = state.db.tenant(session.tenant).await?;
    let links = agency::links_of_shop(&mut tx, session.shop_id).await?;
    Ok(Json(ShopLinksDto {
        links: links.into_iter().map(link_dto).collect(),
    }))
}

/// A link code a merchant typed.
#[derive(Debug, Deserialize, ToSchema)]
pub(crate) struct CodeRequest {
    code: String,
}

/// Who asked to link.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct CodePreviewDto {
    organization_name: String,
    expires_at: String,
}

/// Counts a wrong code against the shop and answers "not valid", or refuses once the shop has
/// tried too many. Both outcomes commit the audit entry first.
async fn reject(mut tx: db::TenantTx, session: &shopify_auth::ShopSession) -> ApiError {
    match record_rejection(&mut tx, session).await {
        Ok(()) => match tx.commit().await {
            Ok(()) => bad_code(),
            Err(e) => e.into(),
        },
        Err(e) => e,
    }
}

async fn record_rejection(
    tx: &mut db::TenantTx,
    session: &shopify_auth::ShopSession,
) -> Result<(), ApiError> {
    db::repo::audit::append(
        tx,
        &db::repo::audit::NewEntry {
            actor_kind: ActorKind::User,
            actor_id: actor_id(session),
            action: "agency.link_code_rejected".to_owned(),
            subject_type: "shop".to_owned(),
            subject_id: session.shop_id.as_uuid(),
            data: json!({}),
        },
    )
    .await?;
    Ok(())
}

async fn check_attempts(tx: &mut db::TenantTx, now: OffsetDateTime) -> Result<(), ApiError> {
    if agency::rejected_since(tx, now - Duration::hours(1)).await? >= MAX_REJECTED_PER_HOUR {
        return Err(ApiError::new(ProblemCode::RateLimited)
            .detail("Too many codes were not valid. Try again in an hour."));
    }
    Ok(())
}

/// Shows which organization a code belongs to, before the merchant approves it.
#[utoipa::path(
    post,
    path = "/v1/shopify/agency-links/preview",
    tag = "app",
    operation_id = "previewAgencyLink",
    security(("shopify_session" = [])),
    request_body = CodeRequest,
    responses(
        (status = OK, body = CodePreviewDto),
        (status = NOT_FOUND, description = "The code is not valid, is used or has expired",
            body = http_kit::Problem, content_type = "application/problem+json"),
        (status = TOO_MANY_REQUESTS, description = "Too many codes were not valid",
            body = http_kit::Problem, content_type = "application/problem+json"),
        (status = UNAUTHORIZED, body = http_kit::Problem, content_type = "application/problem+json")
    )
)]
pub(crate) async fn preview_agency_link(
    State(state): State<AppState>,
    ShopSession(session): ShopSession,
    Json(request): Json<CodeRequest>,
) -> Result<Json<CodePreviewDto>, ApiError> {
    let mut tx = state.db.tenant(session.tenant).await?;
    check_attempts(&mut tx, OffsetDateTime::now_utc()).await?;
    let Some(canonical) = normalize(&request.code) else {
        return Err(reject(tx, &session).await);
    };
    match agency::preview_code(&mut tx, &hash_of(&canonical)).await? {
        Some(found) => Ok(Json(CodePreviewDto {
            organization_name: found.organization_name,
            expires_at: ts(found.expires_at),
        })),
        None => Err(reject(tx, &session).await),
    }
}

/// Approves the link: from now on the organization sees this store's scores and findings counts.
#[utoipa::path(
    post,
    path = "/v1/shopify/agency-links",
    tag = "app",
    operation_id = "approveAgencyLink",
    security(("shopify_session" = [])),
    request_body = CodeRequest,
    responses(
        (status = CREATED, body = ShopLinkDto),
        (status = NOT_FOUND, description = "The code is not valid, is used or has expired",
            body = http_kit::Problem, content_type = "application/problem+json"),
        (status = TOO_MANY_REQUESTS, description = "Too many codes were not valid",
            body = http_kit::Problem, content_type = "application/problem+json"),
        (status = UNAUTHORIZED, body = http_kit::Problem, content_type = "application/problem+json")
    )
)]
pub(crate) async fn approve_agency_link(
    State(state): State<AppState>,
    ShopSession(session): ShopSession,
    Json(request): Json<CodeRequest>,
) -> Result<(StatusCode, Json<ShopLinkDto>), ApiError> {
    let mut tx = state.db.tenant(session.tenant).await?;
    check_attempts(&mut tx, OffsetDateTime::now_utc()).await?;
    let Some(canonical) = normalize(&request.code) else {
        return Err(reject(tx, &session).await);
    };
    let Some(link) = agency::approve(
        &mut tx,
        session.shop_id,
        &hash_of(&canonical),
        Uuid::now_v7(),
    )
    .await?
    else {
        return Err(reject(tx, &session).await);
    };
    db::repo::audit::append(
        &mut tx,
        &db::repo::audit::NewEntry {
            actor_kind: ActorKind::User,
            actor_id: actor_id(&session),
            action: "agency.link_approved".to_owned(),
            subject_type: "store_link".to_owned(),
            subject_id: link,
            data: json!({}),
        },
    )
    .await?;
    let created = agency::links_of_shop(&mut tx, session.shop_id)
        .await?
        .into_iter()
        .find(|l| l.id == link)
        .ok_or_else(|| ApiError::new(ProblemCode::Internal))?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(link_dto(created))))
}

/// Revokes a link: the organization stops seeing this store at once.
#[utoipa::path(
    delete,
    path = "/v1/shopify/agency-links/{link_id}",
    tag = "app",
    operation_id = "revokeAgencyLink",
    security(("shopify_session" = [])),
    params(("link_id" = String, Path, description = "The link's identifier")),
    responses(
        (status = NO_CONTENT, description = "The link is revoked"),
        (status = NOT_FOUND, description = "No such live link on this store",
            body = http_kit::Problem, content_type = "application/problem+json"),
        (status = UNAUTHORIZED, body = http_kit::Problem, content_type = "application/problem+json")
    )
)]
pub(crate) async fn revoke_agency_link(
    State(state): State<AppState>,
    ShopSession(session): ShopSession,
    Path(link_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let link = uuid_of(&link_id)?;
    let mut tx = state.db.tenant(session.tenant).await?;
    if !agency::revoke(&mut tx, session.shop_id, link).await? {
        return Err(not_found());
    }
    db::repo::audit::append(
        &mut tx,
        &db::repo::audit::NewEntry {
            actor_kind: ActorKind::User,
            actor_id: actor_id(&session),
            action: "agency.link_revoked".to_owned(),
            subject_type: "store_link".to_owned(),
            subject_id: link,
            data: json!({}),
        },
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_code_is_ten_symbols_in_two_groups_and_survives_being_typed_back() {
        for _ in 0..50 {
            let code = new_code();
            assert_eq!(code.len(), 11, "{code}");
            assert_eq!(code.as_bytes()[5], b'-', "{code}");
            let canonical = normalize(&code).expect("a made code normalizes");
            assert_eq!(canonical.len(), CODE_LEN);
            assert_eq!(normalize(&code.to_lowercase()), Some(canonical));
        }
    }

    #[test]
    fn typing_slips_are_forgiven_and_anything_else_is_refused() {
        assert_eq!(normalize("abcde 12345"), Some("ABCDE12345".to_owned()));
        assert_eq!(normalize("OIL00-11111"), Some("0110011111".to_owned()));
        for bad in [
            "",
            "ABCDE-1234",
            "ABCDE-123456",
            "ABCDE-1234U",
            "ABCDE-12 4!",
            "ÄBCDE-12345",
        ] {
            assert_eq!(normalize(bad), None, "{bad:?} was accepted");
        }
    }

    #[test]
    fn the_stored_hash_is_a_sha256_of_the_canonical_code() {
        assert_eq!(hash_of("ABCDE12345").len(), 32);
        assert_ne!(hash_of("ABCDE12345"), hash_of("ABCDE12346"));
    }
}
