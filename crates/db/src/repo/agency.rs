//! Agency accounts and the store links merchants grant them (ADR-313, ADR-314).
//!
//! Two kinds of caller meet here and they never share a function. The dashboard side takes an
//! [`IdentityTx`]: organizations, members, link codes, and the cross-store overview, which comes
//! from a security-definer function that starts at the user's memberships and live links. The
//! App Home side takes a [`TenantTx`]: previewing a code, approving a link for the caller's own
//! shop, listing and revoking its links. An agency user has no path to a tenant's tables: with no
//! tenant set, row-level security hides every `store_links` row from an identity transaction.

use domain::{ShopId, UserId};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::{DbError, IdentityTx, TenantTx};

/// How many unused, unexpired codes one organization may hold at once.
pub const MAX_LIVE_CODES: i64 = 10;

/// An organization a user belongs to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Organization {
    /// The organization's id.
    pub id: Uuid,
    /// Its name, as the members and linked merchants see it.
    pub name: String,
    /// `owner` or `member`.
    pub role: String,
}

/// Creates an organization with `user` as its owner.
pub async fn create_organization(
    tx: &mut IdentityTx,
    id: Uuid,
    name: &str,
    user: UserId,
) -> Result<Organization, DbError> {
    sqlx::query!(
        "insert into organizations (id, name, created_by) values ($1, $2, $3)",
        id,
        name,
        user.as_uuid(),
    )
    .execute(tx.conn())
    .await?;
    sqlx::query!(
        "insert into organization_members (organization_id, user_id, role) values ($1, $2, 'owner')",
        id,
        user.as_uuid(),
    )
    .execute(tx.conn())
    .await?;
    Ok(Organization {
        id,
        name: name.to_owned(),
        role: "owner".to_owned(),
    })
}

/// The organizations `user` belongs to, by name.
pub async fn organizations_of(
    tx: &mut IdentityTx,
    user: UserId,
) -> Result<Vec<Organization>, DbError> {
    let rows = sqlx::query!(
        r#"select o.id, o.name, m.role
             from organization_members m join organizations o on o.id = m.organization_id
            where m.user_id = $1 order by o.name, o.id"#,
        user.as_uuid(),
    )
    .fetch_all(tx.conn())
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| Organization {
            id: r.id,
            name: r.name,
            role: r.role,
        })
        .collect())
}

/// Why a code could not be created.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodeRefused {
    /// The user is not a member of the organization (or it does not exist).
    NotMember,
    /// The organization already holds [`MAX_LIVE_CODES`] live codes.
    TooMany,
}

/// Stores the hash of a new link code for `organization`, when `user` is a member of it.
pub async fn create_code(
    tx: &mut IdentityTx,
    id: Uuid,
    organization: Uuid,
    user: UserId,
    code_hash: &[u8],
    expires_at: OffsetDateTime,
) -> Result<Result<(), CodeRefused>, DbError> {
    let member = sqlx::query_scalar!(
        r#"select exists (select 1 from organization_members
                           where organization_id = $1 and user_id = $2) as "member!""#,
        organization,
        user.as_uuid(),
    )
    .fetch_one(tx.conn())
    .await?;
    if !member {
        return Ok(Err(CodeRefused::NotMember));
    }
    let live = sqlx::query_scalar!(
        r#"select count(*) as "live!" from agency_link_codes
            where organization_id = $1 and used_at is null and expires_at > now()"#,
        organization,
    )
    .fetch_one(tx.conn())
    .await?;
    if live >= MAX_LIVE_CODES {
        return Ok(Err(CodeRefused::TooMany));
    }
    sqlx::query!(
        "insert into agency_link_codes (id, organization_id, code_hash, created_by, expires_at)
         values ($1, $2, $3, $4, $5)",
        id,
        organization,
        code_hash,
        user.as_uuid(),
        expires_at,
    )
    .execute(tx.conn())
    .await?;
    Ok(Ok(()))
}

/// One linked store in the cross-store overview: counts and dates only.
#[derive(Debug, Clone, PartialEq)]
pub struct LinkedStore {
    /// The link's id.
    pub link_id: Uuid,
    /// The organization it belongs to.
    pub organization_id: Uuid,
    /// That organization's name.
    pub organization_name: String,
    /// The store's `myshopify.com` domain.
    pub shop_domain: String,
    /// When the merchant approved the link.
    pub granted_at: OffsetDateTime,
    /// The status of the store's latest scan, when it has one.
    pub scan_status: Option<String>,
    /// What started that scan.
    pub scan_trigger: Option<String>,
    /// When it finished, or was queued.
    pub scan_at: Option<OffsetDateTime>,
    /// Checks it ran.
    pub checks_run: Option<i32>,
    /// Checks it passed.
    pub checks_passed: Option<i32>,
    /// Open findings, best practices left out.
    pub open_findings: i32,
    /// Of those, serious or critical.
    pub open_serious: i32,
    /// New findings in the latest undismissed regression of the last 30 days.
    pub regression_new: Option<i32>,
    /// Findings that came back in it.
    pub regression_reappeared: Option<i32>,
    /// When it was detected.
    pub regression_at: Option<OffsetDateTime>,
}

type LinkedRow = (
    Uuid,
    Uuid,
    String,
    String,
    OffsetDateTime,
    Option<String>,
    Option<String>,
    Option<OffsetDateTime>,
    Option<i32>,
    Option<i32>,
    i32,
    i32,
    Option<i32>,
    Option<i32>,
    Option<OffsetDateTime>,
);

/// Every store linked to an organization `user` belongs to, live links only.
pub async fn linked_stores(tx: &mut IdentityTx, user: UserId) -> Result<Vec<LinkedStore>, DbError> {
    let rows: Vec<LinkedRow> = sqlx::query_as("select * from agency_linked_stores($1)")
        .bind(user.as_uuid())
        .fetch_all(tx.conn())
        .await?;
    Ok(rows
        .into_iter()
        .map(|r| LinkedStore {
            link_id: r.0,
            organization_id: r.1,
            organization_name: r.2,
            shop_domain: r.3,
            granted_at: r.4,
            scan_status: r.5,
            scan_trigger: r.6,
            scan_at: r.7,
            checks_run: r.8,
            checks_passed: r.9,
            open_findings: r.10,
            open_serious: r.11,
            regression_new: r.12,
            regression_reappeared: r.13,
            regression_at: r.14,
        })
        .collect())
}

/// The agency ends a link. `false` when the user is not a member of its organization, or the
/// link is unknown or already ended; the caller cannot tell which.
pub async fn unlink(tx: &mut IdentityTx, user: UserId, link: Uuid) -> Result<bool, DbError> {
    let done: bool = sqlx::query_scalar("select agency_unlink($1, $2)")
        .bind(user.as_uuid())
        .bind(link)
        .fetch_one(tx.conn())
        .await?;
    Ok(done)
}

/// What a merchant sees of a code before approving it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodePreview {
    /// The organization that made the code.
    pub organization_name: String,
    /// When the code stops working.
    pub expires_at: OffsetDateTime,
}

/// The organization behind a live code, or none for an unknown, used or expired code.
pub async fn preview_code(
    tx: &mut TenantTx,
    code_hash: &[u8],
) -> Result<Option<CodePreview>, DbError> {
    let row: Option<(String, OffsetDateTime)> =
        sqlx::query_as("select organization_name, expires_at from agency_preview_code($1)")
            .bind(code_hash)
            .fetch_optional(tx.conn())
            .await?;
    Ok(row.map(|(organization_name, expires_at)| CodePreview {
        organization_name,
        expires_at,
    }))
}

/// Approves the link a code asks for, for the transaction's own shop. Returns the link's id, or
/// none when the code is unknown, used or expired.
pub async fn approve(
    tx: &mut TenantTx,
    shop: ShopId,
    code_hash: &[u8],
    link: Uuid,
) -> Result<Option<Uuid>, DbError> {
    let tenant = tx.tenant_uuid();
    let id: Option<Uuid> = sqlx::query_scalar("select agency_approve_link($1, $2, $3, $4)")
        .bind(tenant)
        .bind(shop.as_uuid())
        .bind(code_hash)
        .bind(link)
        .fetch_one(tx.conn())
        .await?;
    Ok(id)
}

/// A live link on the shop, as its merchant sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShopLink {
    /// The link's id.
    pub id: Uuid,
    /// The organization it grants.
    pub organization_name: String,
    /// When the merchant approved it.
    pub granted_at: OffsetDateTime,
}

/// The shop's live links, newest first.
pub async fn links_of_shop(tx: &mut TenantTx, shop: ShopId) -> Result<Vec<ShopLink>, DbError> {
    let tenant = tx.tenant_uuid();
    let rows = sqlx::query!(
        r#"select l.id, o.name as organization_name, l.granted_at
             from store_links l join organizations o on o.id = l.organization_id
            where l.tenant_id = $1 and l.shop_id = $2 and l.revoked_at is null
            order by l.granted_at desc, l.id"#,
        tenant,
        shop.as_uuid(),
    )
    .fetch_all(tx.conn())
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| ShopLink {
            id: r.id,
            organization_name: r.organization_name,
            granted_at: r.granted_at,
        })
        .collect())
}

/// The merchant revokes a link of its own shop, effective at once. `false` when the link is not
/// a live link of this shop.
pub async fn revoke(tx: &mut TenantTx, shop: ShopId, link: Uuid) -> Result<bool, DbError> {
    let tenant = tx.tenant_uuid();
    let done = sqlx::query!(
        "update store_links set revoked_at = now(), revoked_by = 'merchant'
          where tenant_id = $1 and shop_id = $2 and id = $3 and revoked_at is null",
        tenant,
        shop.as_uuid(),
        link,
    )
    .execute(tx.conn())
    .await?;
    Ok(done.rows_affected() == 1)
}

/// How many wrong or expired codes the shop's merchant tried since `since`: the audit entries
/// `agency.link_code_rejected` on this tenant. The api refuses further tries past its limit.
pub async fn rejected_since(tx: &mut TenantTx, since: OffsetDateTime) -> Result<i64, DbError> {
    let tenant = tx.tenant_uuid();
    Ok(sqlx::query_scalar!(
        r#"select count(*) as "n!" from audit_log
            where tenant_id = $1 and action = 'agency.link_code_rejected' and at > $2"#,
        tenant,
        since,
    )
    .fetch_one(tx.conn())
    .await?)
}
