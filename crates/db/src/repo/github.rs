//! The GitHub channel's rows: install states, installations, repositories and webhook
//! deliveries (PLAN §15, ADR-290 to ADR-294).
//!
//! Everything here is scoped to the transaction's tenant, in SQL and by row-level security. The
//! two lookups that must run before a tenant is known (a callback's state, a webhook's
//! installation) are on [`crate::Db`], not here.

use domain::SiteId;
use serde_json::Value;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::{DbError, TenantTx};

/// How long an install state stays valid.
pub const STATE_TTL_SECONDS: i64 = 10 * 60;

/// An installation linked to the store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallationRow {
    /// The row.
    pub id: Uuid,
    /// GitHub's installation id.
    pub installation_id: i64,
    /// The account's login.
    pub account_login: String,
    /// `User`, `Organization` or `Enterprise`.
    pub account_type: String,
    /// `all` or `selected`.
    pub repository_selection: String,
    /// `active`, `suspended` or `deleted`.
    pub status: String,
    /// The GitHub login that authorised the App when it was connected.
    pub connected_by_github: Option<String>,
    /// When it was linked.
    pub linked_at: OffsetDateTime,
    /// When its state was last read from the GitHub API.
    pub state_read_at: Option<OffsetDateTime>,
}

/// Whether a repository is private.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Visibility {
    /// Visible only to those it is shared with.
    Private,
    /// Visible to everyone.
    Public,
}

impl Visibility {
    /// Whether this is [`Visibility::Private`].
    #[must_use]
    pub const fn is_private(self) -> bool {
        matches!(self, Self::Private)
    }
}

/// Builds a [`RepoRow`] from the anonymous record of a `select` over the repository columns.
macro_rules! repo_row {
    ($r:expr) => {{
        let r = $r;
        RepoRow {
            id: r.id,
            repo_id: r.repo_id,
            full_name: r.full_name,
            default_branch: r.default_branch,
            visibility: if r.is_private {
                Visibility::Private
            } else {
                Visibility::Public
            },
            archived: r.archived,
            user_can_push: r.user_can_push,
            status: r.status,
            selected: r.selected,
            connected_branch: r.connected_branch,
            theme_state: r.theme_state,
            theme_checked_at: r.theme_checked_at,
        }
    }};
}

/// A repository an installation can reach.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoRow {
    /// The row.
    pub id: Uuid,
    /// GitHub's repository id.
    pub repo_id: i64,
    /// `owner/name` as last read.
    pub full_name: String,
    /// The default branch.
    pub default_branch: String,
    /// Whether it is private.
    pub visibility: Visibility,
    /// Whether it is archived.
    pub archived: bool,
    /// Whether the installer could push to it when they connected.
    pub user_can_push: bool,
    /// `available` or `removed`.
    pub status: String,
    /// Whether it is the store's theme repository.
    pub selected: bool,
    /// The branch connected to the live theme.
    pub connected_branch: Option<String>,
    /// `unchecked`, `ok`, `not_a_theme` or `unreachable`.
    pub theme_state: String,
    /// When the theme structure was last checked.
    pub theme_checked_at: Option<OffsetDateTime>,
}

/// A repository as GitHub lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoUpsert {
    /// GitHub's repository id.
    pub repo_id: i64,
    /// `owner/name`.
    pub full_name: String,
    /// The default branch.
    pub default_branch: String,
    /// Whether it is private.
    pub is_private: bool,
    /// Whether it is archived.
    pub archived: bool,
    /// Whether the installer could push, when known: `None` leaves the stored value.
    pub user_can_push: Option<bool>,
}

/// An installation to link.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewInstallation {
    /// The store's site.
    pub site: SiteId,
    /// GitHub's installation id.
    pub installation_id: i64,
    /// The account's login.
    pub account_login: String,
    /// `User`, `Organization` or `Enterprise`.
    pub account_type: String,
    /// `all` or `selected`.
    pub repository_selection: String,
    /// The Shopify staff member who connected it (`shopify:<sub>`).
    pub connected_by_ref: Option<String>,
    /// The GitHub login that authorised the App.
    pub connected_by_github: String,
}

/// What linking an installation did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Linked {
    /// Newly linked, or the store's own link refreshed.
    Linked(Uuid),
    /// The installation is linked to another store.
    TakenByAnotherStore,
    /// This store is linked to a different installation; disconnect it first.
    StoreHasAnother,
}

/// Records a new install state for the site. Only the digest of the random state is stored.
pub async fn create_install_state(
    tx: &mut TenantTx,
    site: SiteId,
    created_by_ref: Option<&str>,
    state_sha256: &[u8; 32],
) -> Result<(), DbError> {
    let tenant = tx.tenant_uuid();
    sqlx::query!(
        "insert into github_install_states
           (state_sha256, tenant_id, site_id, created_by_ref, expires_at)
         values ($1, $2, $3, $4, now() + make_interval(secs => $5))",
        state_sha256.as_slice(),
        tenant,
        site.as_uuid(),
        created_by_ref,
        f64::from(i32::try_from(STATE_TTL_SECONDS).unwrap_or(600)),
    )
    .execute(tx.conn())
    .await?;
    Ok(())
}

/// Links an installation to the store, or refreshes the store's own link to it.
pub async fn link_installation(
    tx: &mut TenantTx,
    new: &NewInstallation,
) -> Result<Linked, DbError> {
    let tenant = tx.tenant_uuid();
    let existing = sqlx::query!(
        "select id, installation_id from github_installations
          where tenant_id = $1 and status <> 'deleted'",
        tenant
    )
    .fetch_optional(tx.conn())
    .await?;
    if let Some(row) = existing {
        if row.installation_id != new.installation_id {
            return Ok(Linked::StoreHasAnother);
        }
        sqlx::query!(
            "update github_installations
                set account_login = $3, account_type = $4, repository_selection = $5,
                    status = 'active', connected_by_ref = $6, connected_by_github = $7
              where tenant_id = $1 and id = $2",
            tenant,
            row.id,
            new.account_login,
            new.account_type,
            new.repository_selection,
            new.connected_by_ref,
            new.connected_by_github,
        )
        .execute(tx.conn())
        .await?;
        return Ok(Linked::Linked(row.id));
    }
    // The unique index on live installations makes the claim atomic: two stores racing for the
    // same installation cannot both win.
    let id = Uuid::now_v7();
    let inserted = sqlx::query!(
        "insert into github_installations
           (id, tenant_id, site_id, installation_id, account_login, account_type,
            repository_selection, status, connected_by_ref, connected_by_github)
         values ($1, $2, $3, $4, $5, $6, $7, 'active', $8, $9)
         on conflict do nothing
         returning id",
        id,
        tenant,
        new.site.as_uuid(),
        new.installation_id,
        new.account_login,
        new.account_type,
        new.repository_selection,
        new.connected_by_ref,
        new.connected_by_github,
    )
    .fetch_optional(tx.conn())
    .await?;
    Ok(match inserted {
        Some(row) => Linked::Linked(row.id),
        None => Linked::TakenByAnotherStore,
    })
}

/// The store's live installation, if it has one.
pub async fn live_installation(tx: &mut TenantTx) -> Result<Option<InstallationRow>, DbError> {
    let tenant = tx.tenant_uuid();
    Ok(sqlx::query_as!(
        InstallationRow,
        "select id, installation_id, account_login, account_type, repository_selection, status,
                connected_by_github, linked_at, state_read_at
           from github_installations
          where tenant_id = $1 and status <> 'deleted'",
        tenant
    )
    .fetch_optional(tx.conn())
    .await?)
}

/// One installation row by id.
pub async fn installation(tx: &mut TenantTx, id: Uuid) -> Result<Option<InstallationRow>, DbError> {
    let tenant = tx.tenant_uuid();
    Ok(sqlx::query_as!(
        InstallationRow,
        "select id, installation_id, account_login, account_type, repository_selection, status,
                connected_by_github, linked_at, state_read_at
           from github_installations
          where tenant_id = $1 and id = $2",
        tenant,
        id
    )
    .fetch_optional(tx.conn())
    .await?)
}

/// Records what the GitHub API says about the installation now.
pub async fn set_installation_state(
    tx: &mut TenantTx,
    id: Uuid,
    status: &str,
    repository_selection: &str,
    account_login: &str,
) -> Result<(), DbError> {
    let tenant = tx.tenant_uuid();
    sqlx::query!(
        "update github_installations
            set status = $3, repository_selection = $4, account_login = $5, state_read_at = now()
          where tenant_id = $1 and id = $2",
        tenant,
        id,
        status,
        repository_selection,
        account_login,
    )
    .execute(tx.conn())
    .await?;
    Ok(())
}

/// Ends the link: the installation is `deleted`, its repositories are no longer available and
/// none is the theme repository. Pull requests already opened stay on record.
pub async fn unlink_installation(tx: &mut TenantTx, id: Uuid) -> Result<(), DbError> {
    let tenant = tx.tenant_uuid();
    sqlx::query!(
        "update github_repos
            set status = 'removed', selected = false, updated_at = now()
          where tenant_id = $1 and installation_row = $2",
        tenant,
        id
    )
    .execute(tx.conn())
    .await?;
    sqlx::query!(
        "update github_installations set status = 'deleted', state_read_at = now()
          where tenant_id = $1 and id = $2",
        tenant,
        id
    )
    .execute(tx.conn())
    .await?;
    Ok(())
}

/// Makes the installation's repositories match `repos` (what GitHub lists): new ones are added,
/// known ones refreshed, and, when `remove_missing` is set, any not listed become `removed` and
/// lose the theme selection. A listing that was cut short must not remove anything. Returns how
/// many repositories were listed.
pub async fn sync_repos(
    tx: &mut TenantTx,
    installation_row: Uuid,
    repos: &[RepoUpsert],
    remove_missing: bool,
) -> Result<usize, DbError> {
    let tenant = tx.tenant_uuid();
    for repo in repos {
        sqlx::query!(
            "insert into github_repos
               (id, tenant_id, installation_row, repo_id, full_name, default_branch, is_private,
                archived, user_can_push, status)
             values ($1, $2, $3, $4, $5, $6, $7, $8, coalesce($9, false), 'available')
             on conflict (installation_row, repo_id) do update
               set full_name = excluded.full_name,
                   default_branch = excluded.default_branch,
                   is_private = excluded.is_private,
                   archived = excluded.archived,
                   user_can_push = coalesce($9, github_repos.user_can_push),
                   status = 'available',
                   updated_at = now()",
            Uuid::now_v7(),
            tenant,
            installation_row,
            repo.repo_id,
            repo.full_name,
            repo.default_branch,
            repo.is_private,
            repo.archived,
            repo.user_can_push,
        )
        .execute(tx.conn())
        .await?;
    }
    if !remove_missing {
        return Ok(repos.len());
    }
    let listed: Vec<i64> = repos.iter().map(|r| r.repo_id).collect();
    sqlx::query!(
        "update github_repos
            set status = 'removed', selected = false, updated_at = now()
          where tenant_id = $1 and installation_row = $2 and status = 'available'
            and not (repo_id = any($3))",
        tenant,
        installation_row,
        &listed,
    )
    .execute(tx.conn())
    .await?;
    Ok(repos.len())
}

/// The installation's repositories, by name.
pub async fn repos_of(tx: &mut TenantTx, installation_row: Uuid) -> Result<Vec<RepoRow>, DbError> {
    let tenant = tx.tenant_uuid();
    Ok(sqlx::query!(
        "select id, repo_id, full_name, default_branch, is_private, archived, user_can_push,
                status, selected, connected_branch, theme_state, theme_checked_at
           from github_repos
          where tenant_id = $1 and installation_row = $2
          order by full_name",
        tenant,
        installation_row
    )
    .fetch_all(tx.conn())
    .await?
    .into_iter()
    .map(|r| repo_row!(r))
    .collect())
}

/// One repository by row id.
pub async fn repo(tx: &mut TenantTx, id: Uuid) -> Result<Option<RepoRow>, DbError> {
    let tenant = tx.tenant_uuid();
    Ok(sqlx::query!(
        "select id, repo_id, full_name, default_branch, is_private, archived, user_can_push,
                status, selected, connected_branch, theme_state, theme_checked_at
           from github_repos where tenant_id = $1 and id = $2",
        tenant,
        id
    )
    .fetch_optional(tx.conn())
    .await?
    .map(|r| repo_row!(r)))
}

/// One repository by GitHub's id (audit L8: events and pull requests are matched on it).
pub async fn repo_by_github_id(
    tx: &mut TenantTx,
    repo_id: i64,
) -> Result<Option<RepoRow>, DbError> {
    let tenant = tx.tenant_uuid();
    Ok(sqlx::query!(
        "select id, repo_id, full_name, default_branch, is_private, archived, user_can_push,
                status, selected, connected_branch, theme_state, theme_checked_at
           from github_repos
          where tenant_id = $1 and repo_id = $2 and status = 'available'",
        tenant,
        repo_id
    )
    .fetch_optional(tx.conn())
    .await?
    .map(|r| repo_row!(r)))
}

/// The store's theme repository, if one is chosen.
pub async fn selected_repo(tx: &mut TenantTx) -> Result<Option<RepoRow>, DbError> {
    let tenant = tx.tenant_uuid();
    Ok(sqlx::query!(
        "select id, repo_id, full_name, default_branch, is_private, archived, user_can_push,
                status, selected, connected_branch, theme_state, theme_checked_at
           from github_repos where tenant_id = $1 and selected",
        tenant
    )
    .fetch_optional(tx.conn())
    .await?
    .map(|r| repo_row!(r)))
}

/// Why a repository could not be chosen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SelectOutcome {
    /// It is now the theme repository.
    Selected,
    /// No such repository, or it is gone from the installation.
    NotFound,
    /// The installer could not push to it when they connected, or it is archived.
    NotWritable,
}

/// Chooses the store's theme repository and the branch connected to the live theme. Any earlier
/// choice is cleared, and the theme check starts over.
pub async fn select_repo(
    tx: &mut TenantTx,
    id: Uuid,
    connected_branch: &str,
) -> Result<SelectOutcome, DbError> {
    let tenant = tx.tenant_uuid();
    let Some(row) = repo(tx, id).await? else {
        return Ok(SelectOutcome::NotFound);
    };
    if row.status != "available" {
        return Ok(SelectOutcome::NotFound);
    }
    if !row.user_can_push || row.archived {
        return Ok(SelectOutcome::NotWritable);
    }
    sqlx::query!(
        "update github_repos set selected = false, updated_at = now()
          where tenant_id = $1 and selected and id <> $2",
        tenant,
        id
    )
    .execute(tx.conn())
    .await?;
    sqlx::query!(
        "update github_repos
            set selected = true, connected_branch = $3, theme_state = 'unchecked',
                theme_checked_at = null, updated_at = now()
          where tenant_id = $1 and id = $2",
        tenant,
        id,
        connected_branch,
    )
    .execute(tx.conn())
    .await?;
    Ok(SelectOutcome::Selected)
}

/// Clears the theme repository.
pub async fn clear_selection(tx: &mut TenantTx) -> Result<(), DbError> {
    let tenant = tx.tenant_uuid();
    sqlx::query!(
        "update github_repos set selected = false, updated_at = now()
          where tenant_id = $1 and selected",
        tenant
    )
    .execute(tx.conn())
    .await?;
    Ok(())
}

/// Records the result of the theme structure check.
pub async fn set_theme_state(tx: &mut TenantTx, id: Uuid, state: &str) -> Result<(), DbError> {
    let tenant = tx.tenant_uuid();
    sqlx::query!(
        "update github_repos
            set theme_state = $3, theme_checked_at = now(), updated_at = now()
          where tenant_id = $1 and id = $2",
        tenant,
        id,
        state
    )
    .execute(tx.conn())
    .await?;
    Ok(())
}

/// A verified delivery to store.
#[derive(Debug, Clone)]
pub struct NewEvent {
    /// `X-GitHub-Delivery`.
    pub delivery_id: String,
    /// `X-GitHub-Event`.
    pub event: String,
    /// The installation the payload names.
    pub installation_id: i64,
    /// The repository the payload names, if any.
    pub repository_id: Option<i64>,
    /// The parsed body, stored as the copy that is processed.
    pub body: Value,
    /// SHA-256 of the raw body.
    pub body_sha256: [u8; 32],
}

/// What storing a delivery did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Recorded {
    /// Stored as this event.
    Stored(Uuid),
    /// Its delivery id was stored before (GitHub's own retry or a redelivery).
    DuplicateDelivery,
    /// The same body was stored before under another delivery id (a replay, audit M1).
    DuplicateBody,
}

/// Stores a verified delivery once.
pub async fn record_event(tx: &mut TenantTx, new: &NewEvent) -> Result<Recorded, DbError> {
    let tenant = tx.tenant_uuid();
    let id = Uuid::now_v7();
    let stored = sqlx::query!(
        "insert into github_events
           (id, tenant_id, delivery_id, event, installation_id, repository_id, body, body_sha256)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict do nothing
         returning id",
        id,
        tenant,
        new.delivery_id,
        new.event,
        new.installation_id,
        new.repository_id,
        new.body,
        new.body_sha256.as_slice(),
    )
    .fetch_optional(tx.conn())
    .await?;
    if stored.is_some() {
        return Ok(Recorded::Stored(id));
    }
    let same_delivery = sqlx::query_scalar!(
        r#"select exists(select 1 from github_events where tenant_id = $1 and delivery_id = $2) as "e!""#,
        tenant,
        new.delivery_id
    )
    .fetch_one(tx.conn())
    .await?;
    Ok(if same_delivery {
        Recorded::DuplicateDelivery
    } else {
        Recorded::DuplicateBody
    })
}

/// A stored delivery.
#[derive(Debug, Clone, PartialEq)]
pub struct EventRow {
    /// The row.
    pub id: Uuid,
    /// The event name.
    pub event: String,
    /// The installation it names.
    pub installation_id: i64,
    /// The stored body.
    pub body: Value,
    /// When it was processed.
    pub processed_at: Option<OffsetDateTime>,
}

/// A stored delivery by id.
pub async fn event(tx: &mut TenantTx, id: Uuid) -> Result<Option<EventRow>, DbError> {
    let tenant = tx.tenant_uuid();
    Ok(sqlx::query_as!(
        EventRow,
        "select id, event, installation_id, body, processed_at
           from github_events where tenant_id = $1 and id = $2",
        tenant,
        id
    )
    .fetch_optional(tx.conn())
    .await?)
}

/// Marks a delivery processed.
pub async fn mark_event_processed(tx: &mut TenantTx, id: Uuid) -> Result<(), DbError> {
    let tenant = tx.tenant_uuid();
    sqlx::query!(
        "update github_events set processed_at = now()
          where tenant_id = $1 and id = $2 and processed_at is null",
        tenant,
        id
    )
    .execute(tx.conn())
    .await?;
    Ok(())
}
