//! The GitHub pull-request channel's routes (PLAN §15, ADR-290, ADR-291): the "Code fixes"
//! screen's state, connecting a GitHub installation, choosing the theme repository and
//! disconnecting.
//!
//! The channel is off unless `CODE_FIX_CHANNEL_ENABLED` is true (ADR-290): without a
//! [`GithubChannel`] on the state every route here answers 404, as if it did not exist, except
//! the status read, which says `enabled: false` so the screen can explain itself.
//!
//! The install flow (audit L7, ADR-291):
//!
//! 1. the signed-in staff member presses "Connect GitHub"; [`create_connection`] stores the
//!    SHA-256 of a random `state` bound to their tenant and site and returns the state;
//! 2. the web server sends the browser to GitHub's installation page with that state and keeps
//!    it in a cookie; GitHub sends the browser back with `code` and `installation_id`;
//! 3. the web server forwards both and the cookie's state to [`finish_connection`], which has
//!    no Shopify session: the state is what says which store this is, and it works once;
//! 4. the code is exchanged for a user token, which must list the installation (so one cannot
//!    claim another person's installation by knowing its id) and is used for the repositories
//!    the person can push to; then it is dropped. It is never stored.
//!
//! The api never holds the App's private key. Everything that needs an installation token runs
//! in `ctl`.

use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use billing::entitlements::{Feature, Gate, feature_gate};
use billing::stored::{entitlements_of, state_of};
use contracts::{GithubCheckRepository, GithubPlanBatch, GithubSyncInstallation};
use db::TenantTx;
use db::repo::code_fix::{self as batches, Created, NewBatch};
use db::repo::github::{self as store, Linked, NewInstallation, RepoUpsert, SelectOutcome};
use db::repo::{audit, jobs as job_repo, shop_billing};
use domain::{ActorKind, ShopId};
use github::{
    BranchName, ClientConfig, GitHub, GitHubError, InstallationId, OAuthApp, OAuthError,
    SystemClock,
};
use http_kit::{ApiError, ProblemCode};
use queue::NewJob;
use secrecy::SecretString;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use tracing::{info, warn};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::AppState;
use crate::config::GithubSettings;
use crate::r1::{Body, actor_id, invalid, not_found, queue_error, site_of, staff, ts};
use crate::shopify::ShopSession;

/// The channel's collaborators: a GitHub client without the App's key, and the App's OAuth
/// identity.
pub struct GithubChannel {
    client: GitHub,
    oauth: OAuthApp,
}

impl std::fmt::Debug for GithubChannel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GithubChannel").finish_non_exhaustive()
    }
}

impl GithubChannel {
    /// A channel for these settings. `config` points the client at GitHub; tests point it at a
    /// fake.
    pub fn new(settings: &GithubSettings, config: ClientConfig) -> Result<Self, GitHubError> {
        Ok(Self {
            client: GitHub::without_app(config, Arc::new(SystemClock))?,
            oauth: OAuthApp::new(
                &settings.client_id,
                SecretString::from(
                    secrecy::ExposeSecret::expose_secret(&settings.client_secret).to_owned(),
                ),
            ),
        })
    }
}

fn channel(state: &AppState) -> Result<&GithubChannel, ApiError> {
    state.github.as_deref().ok_or_else(not_found)
}

/// Length of a base64url-encoded 32-byte state.
const STATE_CHARS: usize = 43;

/// The first eight bytes of a digest, in hex.
fn short_hex(digest: &[u8]) -> String {
    use std::fmt::Write as _;
    digest.iter().take(8).fold(String::new(), |mut out, b| {
        let _ = write!(out, "{b:02x}");
        out
    })
}

/// The repositories GitHub listed, as rows to store.
fn repo_upserts(items: Vec<github::InstalledRepository>) -> Vec<RepoUpsert> {
    items
        .into_iter()
        .filter_map(|r| {
            Some(RepoUpsert {
                repo_id: i64::try_from(r.id.get()).ok()?,
                full_name: r.full_name,
                default_branch: r.default_branch.unwrap_or_else(|| "main".to_owned()),
                is_private: r.private,
                archived: r.archived,
                user_can_push: Some(r.permissions.is_some_and(|p| p.push || p.admin)),
            })
        })
        .collect()
}

/// The account's login and type, with a stand-in login when GitHub gives none.
fn account_of(account: &github::Account) -> (String, String) {
    match (&account.login, &account.kind) {
        (Some(login), Some(kind)) if matches!(kind.as_str(), "User" | "Organization") => {
            (login.clone(), kind.clone())
        }
        (Some(login), _) => (login.clone(), "Enterprise".to_owned()),
        (None, _) => (format!("account-{}", account.id), "Enterprise".to_owned()),
    }
}

/// What the person's user token can show of the installation: the installation itself, the
/// person's login and the repositories. The token is dropped before this returns.
async fn fetch_from_github(
    channel: &GithubChannel,
    code: &str,
    installation: u64,
) -> Result<
    (
        github::InstallationInfo,
        String,
        github::Listing<github::InstalledRepository>,
    ),
    ApiError,
> {
    let token = match channel
        .client
        .exchange_oauth_code(&channel.oauth, code)
        .await
    {
        Ok(token) => token,
        Err(OAuthError::Refused(reason)) => {
            warn!(%reason, "GitHub refused the authorization code");
            return Err(state_refused());
        }
        Err(OAuthError::Request(error)) => return Err(github_unavailable(&error)),
    };
    let id = InstallationId::new(installation);
    // The person must be able to reach this installation: knowing its id is not enough.
    let reachable = channel
        .client
        .user_installations(&token)
        .await
        .map_err(|e| github_unavailable(&e))?;
    let Some(info) = reachable.items.into_iter().find(|i| i.id == id) else {
        warn!(
            reason = "installation_not_reachable",
            "install callback refused"
        );
        return Err(ApiError::new(ProblemCode::Forbidden)
            .detail("This GitHub account cannot reach that installation."));
    };
    let login = channel
        .client
        .user_login(&token)
        .await
        .map_err(|e| github_unavailable(&e))?;
    let listed = channel
        .client
        .user_installation_repositories(&token, id)
        .await
        .map_err(|e| github_unavailable(&e))?;
    // The user token has done its work.
    drop(token);
    Ok((info, login, listed))
}

/// The stored name of an installation's repository selection.
const fn selection_name(selection: github::RepositorySelection) -> &'static str {
    match selection {
        github::RepositorySelection::All => "all",
        github::RepositorySelection::Selected => "selected",
    }
}

fn state_digest(state: &str) -> [u8; 32] {
    Sha256::digest(state.as_bytes()).into()
}

fn state_is_well_formed(state: &str) -> bool {
    state.len() == STATE_CHARS
        && state
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

// ---------------------------------------------------------------------------------------------
// The screen

/// Whether the plan includes pull requests.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct PlanGateDto {
    /// `allowed`, `locked` or `unavailable`.
    gate: String,
    /// The lowest plan that includes pull requests, when locked.
    unlocked_by: Option<String>,
}

/// The GitHub account connected to the store.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct GithubConnectionDto {
    /// The account the App is installed on.
    account: String,
    /// `User`, `Organization` or `Enterprise`.
    account_type: String,
    /// `active` or `suspended`.
    status: String,
    /// `all` or `selected` repositories.
    repository_selection: String,
    /// The GitHub login that connected it.
    connected_by: Option<String>,
    /// When it was connected.
    linked_at: String,
}

/// A repository the installation can reach.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct GithubRepositoryDto {
    /// Rampsmith's id for it, which the choose-repository call takes.
    id: String,
    /// `owner/name`.
    full_name: String,
    /// The repository's default branch.
    default_branch: String,
    /// `private` or `public`.
    visibility: &'static str,
    /// Whether it is archived (read only).
    archived: bool,
    /// Whether the person who connected could push to it. Only such a repository can be chosen.
    can_push: bool,
    /// Whether it is the store's theme repository.
    selected: bool,
    /// The branch connected to the live theme, for the chosen repository.
    connected_branch: Option<String>,
    /// `unchecked`, `ok`, `not_a_theme` or `unreachable`.
    theme_state: String,
}

/// The "Code fixes" screen's state.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct CodeFixesDto {
    /// Whether the channel is switched on in this deployment (`CODE_FIX_CHANNEL_ENABLED`).
    enabled: bool,
    /// What the plan allows.
    plan: PlanGateDto,
    /// The connected GitHub account, if any.
    connection: Option<GithubConnectionDto>,
    /// Its repositories, chosen one first.
    repositories: Vec<GithubRepositoryDto>,
    /// The latest requests for pull requests, newest first.
    batches: Vec<BatchDto>,
    /// The pull requests Rampsmith opened, newest first.
    pull_requests: Vec<PullRequestDto>,
}

/// How many findings of one kind a batch left alone, and why (a code, never finding text).
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct SkippedDto {
    /// `no-recipe`, `plan`, `unmapped`, `needs-review`, `data`, `refused`, `already-fixed`,
    /// `conflict` or `theme-check`.
    code: String,
    /// How many findings.
    count: u32,
}

/// A request for pull requests.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct BatchDto {
    /// Rampsmith's id for it.
    id: String,
    /// `reading`, `patching`, `ready`, `opening`, `opened`, `nothing_to_fix` or `failed`.
    status: String,
    /// `core` or `every`: the recipes the plan included.
    recipes: String,
    /// The open code findings it looked at, once known.
    considered: Option<u32>,
    /// The fixes it made, once known.
    fixed: Option<u32>,
    /// What it left alone, by code.
    skipped: Vec<SkippedDto>,
    /// Why it ended without a pull request.
    failure_code: Option<String>,
    /// When it was requested.
    created_at: String,
}

/// A pull request Rampsmith opened in the merchant's repository.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct PullRequestDto {
    /// Rampsmith's id for it.
    id: String,
    /// The number in the repository.
    number: i64,
    /// Which part of a split batch, from 1.
    part: i32,
    /// `open`, `closed` or `merged`.
    state: String,
    /// Its page on GitHub.
    html_url: String,
    /// Fixes in it.
    fix_count: i32,
    /// Files it changes.
    files: i32,
    /// Lines it changes.
    changed_lines: i32,
    /// Whether someone added commits to the branch since Rampsmith pushed it.
    edited: bool,
    /// When it was opened.
    opened_at: String,
}

fn count_of(outcome: Option<&serde_json::Value>, key: &str) -> Option<u32> {
    outcome?
        .get(key)?
        .as_u64()
        .and_then(|n| u32::try_from(n).ok())
}

/// The outcome's skipped findings, counted by code.
fn skipped_of(outcome: Option<&serde_json::Value>) -> Vec<SkippedDto> {
    let mut counts = std::collections::BTreeMap::<String, u32>::new();
    let items = outcome
        .and_then(|o| o.get("skipped"))
        .and_then(serde_json::Value::as_array);
    for item in items.into_iter().flatten() {
        if let Some(code) = item.get("code").and_then(serde_json::Value::as_str) {
            *counts.entry(code.chars().take(32).collect()).or_default() += 1;
        }
    }
    counts
        .into_iter()
        .map(|(code, count)| SkippedDto { code, count })
        .collect()
}

fn batch_dto(row: batches::BatchRow) -> BatchDto {
    BatchDto {
        id: row.id.to_string(),
        considered: count_of(row.outcome.as_ref(), "considered"),
        fixed: count_of(row.outcome.as_ref(), "fixed"),
        skipped: skipped_of(row.outcome.as_ref()),
        status: row.status,
        recipes: row.recipes,
        failure_code: row.failure_code,
        created_at: ts(row.created_at),
    }
}

fn pull_request_dto(row: batches::PullRequestRow) -> PullRequestDto {
    PullRequestDto {
        id: row.id.to_string(),
        number: row.number,
        part: row.part,
        edited: row.head_sha != row.pushed_sha,
        state: row.state,
        html_url: row.html_url,
        fix_count: row.fix_count,
        files: row.files,
        changed_lines: row.changed_lines,
        opened_at: ts(row.opened_at),
    }
}

/// The plan's gate for pull requests.
async fn plan_gate(tx: &mut TenantTx, shop: ShopId) -> Result<Gate, ApiError> {
    let stored = shop_billing::get(tx, shop).await?;
    let granted = entitlements_of(&state_of(stored.as_ref()));
    Ok(feature_gate(granted.plan(), Feature::GithubPullRequests))
}

fn gate_dto(gate: Gate) -> PlanGateDto {
    match gate {
        Gate::Allowed => PlanGateDto {
            gate: "allowed".to_owned(),
            unlocked_by: None,
        },
        Gate::Locked { unlocked_by } => PlanGateDto {
            gate: "locked".to_owned(),
            unlocked_by: Some(unlocked_by.handle().to_owned()),
        },
        Gate::Unavailable => PlanGateDto {
            gate: "unavailable".to_owned(),
            unlocked_by: None,
        },
    }
}

async fn screen(tx: &mut TenantTx, shop: ShopId, enabled: bool) -> Result<CodeFixesDto, ApiError> {
    let gate = plan_gate(tx, shop).await?;
    let mut dto = CodeFixesDto {
        enabled,
        plan: gate_dto(gate),
        connection: None,
        repositories: Vec::new(),
        batches: Vec::new(),
        pull_requests: Vec::new(),
    };
    if !enabled {
        return Ok(dto);
    }
    if let Some(live) = store::live_installation(tx).await? {
        dto.connection = Some(GithubConnectionDto {
            account: live.account_login.clone(),
            account_type: live.account_type.clone(),
            status: live.status.clone(),
            repository_selection: live.repository_selection.clone(),
            connected_by: live.connected_by_github.clone(),
            linked_at: ts(live.linked_at),
        });
        let mut repos = store::repos_of(tx, live.id).await?;
        repos.retain(|r| r.status == "available");
        repos.sort_by(|a, b| {
            b.selected
                .cmp(&a.selected)
                .then_with(|| a.full_name.cmp(&b.full_name))
        });
        dto.repositories = repos
            .into_iter()
            .map(|r| GithubRepositoryDto {
                id: r.id.to_string(),
                full_name: r.full_name,
                default_branch: r.default_branch,
                visibility: if r.visibility.is_private() {
                    "private"
                } else {
                    "public"
                },
                archived: r.archived,
                can_push: r.user_can_push,
                selected: r.selected,
                connected_branch: r.connected_branch,
                theme_state: r.theme_state,
            })
            .collect();
        dto.batches = batches::recent_batches(tx, 5)
            .await?
            .into_iter()
            .map(batch_dto)
            .collect();
        dto.pull_requests = batches::recent_pull_requests(tx, 20)
            .await?
            .into_iter()
            .map(pull_request_dto)
            .collect();
    }
    Ok(dto)
}

/// What the "Code fixes" screen shows: the plan's gate, the connected GitHub account and its
/// repositories.
#[utoipa::path(
    get,
    path = "/v1/shopify/code-fixes",
    tag = "code-fixes",
    operation_id = "getCodeFixes",
    security(("shopify_session" = [])),
    responses(
        (status = OK, description = "The screen's state", body = CodeFixesDto),
        (status = UNAUTHORIZED, description = "Missing or invalid session token",
            body = http_kit::Problem, content_type = "application/problem+json")
    )
)]
pub(crate) async fn get_code_fixes(
    State(state): State<AppState>,
    ShopSession(session): ShopSession,
) -> Result<Json<CodeFixesDto>, ApiError> {
    let mut tx = state.db.tenant(session.tenant).await?;
    let dto = screen(&mut tx, session.shop_id, state.github.is_some()).await?;
    tx.commit().await?;
    Ok(Json(dto))
}

// ---------------------------------------------------------------------------------------------
// Connecting

/// The one-time state of an install flow.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct ConnectionStartDto {
    /// A random value, valid for ten minutes and for one callback. The web server puts it in
    /// the installation URL and in a cookie.
    state: String,
}

fn plan_refusal() -> ApiError {
    ApiError::new(ProblemCode::Forbidden).detail("Pull requests need a higher plan.")
}

/// Starts connecting GitHub: stores a one-time state for this store.
#[utoipa::path(
    post,
    path = "/v1/shopify/code-fixes/connection",
    tag = "code-fixes",
    operation_id = "startGithubConnection",
    security(("shopify_session" = [])),
    responses(
        (status = OK, description = "The state to carry through GitHub's installation page",
            body = ConnectionStartDto),
        (status = FORBIDDEN, description = "The plan does not include pull requests, or no signed-in staff member",
            body = http_kit::Problem, content_type = "application/problem+json"),
        (status = NOT_FOUND, description = "The channel is not switched on",
            body = http_kit::Problem, content_type = "application/problem+json"),
        (status = UNAUTHORIZED, description = "Missing or invalid session token",
            body = http_kit::Problem, content_type = "application/problem+json")
    )
)]
pub(crate) async fn create_connection(
    State(state): State<AppState>,
    ShopSession(session): ShopSession,
) -> Result<Json<ConnectionStartDto>, ApiError> {
    channel(&state)?;
    staff(&session)?;
    let mut tx = state.db.tenant(session.tenant).await?;
    if !matches!(plan_gate(&mut tx, session.shop_id).await?, Gate::Allowed) {
        return Err(plan_refusal());
    }
    let site = site_of(&mut tx, session.shop_id).await?;
    let raw: [u8; 32] = rand::random();
    let value = URL_SAFE_NO_PAD.encode(raw);
    store::create_install_state(
        &mut tx,
        site,
        actor_id(&session).as_deref(),
        &state_digest(&value),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(ConnectionStartDto { state: value }))
}

/// What GitHub's redirect carried, forwarded by the web server.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct ConnectionFinishBody {
    /// The state from the browser's cookie.
    state: String,
    /// The `state` GitHub put on the redirect, when it did. It must equal the cookie's.
    echoed_state: Option<String>,
    /// The authorization `code` GitHub put on the redirect.
    code: String,
    /// The installation GitHub put on the redirect.
    installation_id: u64,
}

/// The result of connecting.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct ConnectionFinishDto {
    /// Always true; failures are problems.
    connected: bool,
}

fn state_refused() -> ApiError {
    ApiError::new(ProblemCode::BadRequest)
        .detail("This connection link expired or was already used. Start again from Rampsmith.")
}

fn github_unavailable(error: &impl std::fmt::Display) -> ApiError {
    warn!(%error, "GitHub did not answer the install callback");
    ApiError::new(ProblemCode::UpstreamFailed).detail("GitHub is not answering; try again shortly.")
}

/// Finishes connecting GitHub. Called by the web server with what GitHub's redirect carried; it
/// has no Shopify session, and the one-time state is what binds it to a store.
#[utoipa::path(
    post,
    path = "/v1/github/callback",
    tag = "code-fixes",
    operation_id = "finishGithubConnection",
    request_body = ConnectionFinishBody,
    responses(
        (status = OK, description = "The installation is linked to the store", body = ConnectionFinishDto),
        (status = BAD_REQUEST, description = "The state or the code is not valid",
            body = http_kit::Problem, content_type = "application/problem+json"),
        (status = FORBIDDEN, description = "The GitHub user cannot reach this installation",
            body = http_kit::Problem, content_type = "application/problem+json"),
        (status = CONFLICT, description = "The installation or the store is already linked",
            body = http_kit::Problem, content_type = "application/problem+json"),
        (status = NOT_FOUND, description = "The channel is not switched on",
            body = http_kit::Problem, content_type = "application/problem+json"),
        (status = BAD_GATEWAY, description = "GitHub did not answer",
            body = http_kit::Problem, content_type = "application/problem+json")
    )
)]
pub(crate) async fn finish_connection(
    State(state): State<AppState>,
    Body(body): Body<ConnectionFinishBody>,
) -> Result<Json<ConnectionFinishDto>, ApiError> {
    let channel = channel(&state)?;
    if !state_is_well_formed(&body.state) {
        return Err(state_refused());
    }
    // GitHub's redirect may or may not echo the state back (ADR-291). When it does, it must be
    // the state of the browser that is finishing.
    if body
        .echoed_state
        .as_deref()
        .is_some_and(|echoed| echoed != body.state)
    {
        warn!(reason = "state_mismatch", "install callback refused");
        return Err(state_refused());
    }
    let installation_id = i64::try_from(body.installation_id)
        .ok()
        .filter(|id| *id > 0)
        .ok_or_else(|| invalid("installation_id", "is not a GitHub installation id"))?;
    let digest = state_digest(&body.state);
    // Spent before anything else is tried: a failed attempt needs a new state.
    let Some(owner) = state.db.github_consume_state(&digest).await? else {
        warn!(
            reason = "unknown_or_spent_state",
            "install callback refused"
        );
        return Err(state_refused());
    };

    let (info, login, listed) =
        fetch_from_github(channel, &body.code, body.installation_id).await?;
    let truncated = listed.truncated;
    let repos = repo_upserts(listed.items);
    let (account_login, account_type) = account_of(&info.account);
    let selection = selection_name(info.repository_selection);

    let mut tx = state.db.tenant(owner.tenant).await?;
    let linked = store::link_installation(
        &mut tx,
        &NewInstallation {
            site: owner.site,
            installation_id,
            account_login,
            account_type,
            repository_selection: selection.to_owned(),
            connected_by_ref: owner.created_by_ref.clone(),
            connected_by_github: login,
        },
    )
    .await?;
    let row = match linked {
        Linked::Linked(row) => row,
        Linked::TakenByAnotherStore => {
            tx.rollback().await?;
            return Err(ApiError::new(ProblemCode::Conflict)
                .detail("This GitHub installation is already connected to another store."));
        }
        Linked::StoreHasAnother => {
            tx.rollback().await?;
            return Err(ApiError::new(ProblemCode::Conflict).detail(
                "This store is connected to a different GitHub installation. Disconnect it first.",
            ));
        }
    };
    let synced = store::sync_repos(&mut tx, row, &repos, !truncated).await?;
    audit::append(
        &mut tx,
        &audit::NewEntry {
            actor_kind: ActorKind::User,
            actor_id: owner.created_by_ref.clone(),
            action: "github.connected".to_owned(),
            subject_type: "github_installation".to_owned(),
            subject_id: row,
            data: json!({"repositories": synced, "selection": selection}),
        },
    )
    .await?;
    let payload = serde_json::to_value(GithubSyncInstallation {
        installation_row: row,
    })
    .map_err(|e| queue_error(&e))?;
    job_repo::enqueue(
        &mut tx,
        NewJob::new(
            GithubSyncInstallation::QUEUE,
            GithubSyncInstallation::SCHEMA,
            payload,
        )
        .idempotency_key(format!(
            "{}:{row}:{}",
            GithubSyncInstallation::QUEUE,
            short_hex(&digest)
        )),
    )
    .await?;
    tx.commit().await?;
    info!(
        installation = installation_id,
        repositories = synced,
        "GitHub installation linked"
    );
    Ok(Json(ConnectionFinishDto { connected: true }))
}

// ---------------------------------------------------------------------------------------------
// Choosing the repository, disconnecting

/// The repository to use for code fixes.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct ChooseRepositoryBody {
    /// A repository's `id` from the screen's state.
    repository_id: String,
    /// The branch Shopify syncs to the live theme. Rampsmith never pushes to it.
    connected_branch: String,
}

/// Chooses the store's theme repository and the branch connected to the live theme.
#[utoipa::path(
    put,
    path = "/v1/shopify/code-fixes/repository",
    tag = "code-fixes",
    operation_id = "chooseGithubRepository",
    security(("shopify_session" = [])),
    request_body = ChooseRepositoryBody,
    responses(
        (status = OK, description = "The screen's state after the choice", body = CodeFixesDto),
        (status = FORBIDDEN, description = "The plan does not include pull requests, or the person who connected could not push to that repository",
            body = http_kit::Problem, content_type = "application/problem+json"),
        (status = NOT_FOUND, description = "No such repository, or the channel is not switched on",
            body = http_kit::Problem, content_type = "application/problem+json"),
        (status = UNPROCESSABLE_ENTITY, description = "The branch name is not valid",
            body = http_kit::Problem, content_type = "application/problem+json"),
        (status = UNAUTHORIZED, description = "Missing or invalid session token",
            body = http_kit::Problem, content_type = "application/problem+json")
    )
)]
pub(crate) async fn choose_repository(
    State(state): State<AppState>,
    ShopSession(session): ShopSession,
    Body(body): Body<ChooseRepositoryBody>,
) -> Result<Json<CodeFixesDto>, ApiError> {
    channel(&state)?;
    staff(&session)?;
    let id = Uuid::parse_str(&body.repository_id).map_err(|_| not_found())?;
    let branch = BranchName::parse(&body.connected_branch)
        .map_err(|_| invalid("connected_branch", "is not a valid branch name"))?;
    let mut tx = state.db.tenant(session.tenant).await?;
    if !matches!(plan_gate(&mut tx, session.shop_id).await?, Gate::Allowed) {
        return Err(plan_refusal());
    }
    match store::select_repo(&mut tx, id, branch.as_str()).await? {
        SelectOutcome::Selected => {}
        SelectOutcome::NotFound => return Err(not_found()),
        SelectOutcome::NotWritable => {
            return Err(ApiError::new(ProblemCode::Forbidden)
                .detail("The GitHub account that connected could not push to this repository."));
        }
    }
    audit::append(
        &mut tx,
        &audit::NewEntry {
            actor_kind: ActorKind::User,
            actor_id: actor_id(&session),
            action: "github.repository_chosen".to_owned(),
            subject_type: "github_repository".to_owned(),
            subject_id: id,
            data: json!({"branch": branch.as_str()}),
        },
    )
    .await?;
    let payload = serde_json::to_value(GithubCheckRepository { repo_row: id })
        .map_err(|e| queue_error(&e))?;
    job_repo::enqueue(
        &mut tx,
        NewJob::new(
            GithubCheckRepository::QUEUE,
            GithubCheckRepository::SCHEMA,
            payload,
        )
        .idempotency_key(format!(
            "{}:{id}:{}",
            GithubCheckRepository::QUEUE,
            branch.as_str()
        )),
    )
    .await?;
    let dto = screen(&mut tx, session.shop_id, true).await?;
    tx.commit().await?;
    Ok(Json(dto))
}

/// Disconnects GitHub: ends the link and forgets the repository choice. Pull requests already
/// opened stay on GitHub; the App stays installed there until the merchant removes it.
#[utoipa::path(
    delete,
    path = "/v1/shopify/code-fixes/connection",
    tag = "code-fixes",
    operation_id = "disconnectGithub",
    security(("shopify_session" = [])),
    responses(
        (status = OK, description = "The screen's state after disconnecting", body = CodeFixesDto),
        (status = NOT_FOUND, description = "The channel is not switched on",
            body = http_kit::Problem, content_type = "application/problem+json"),
        (status = UNAUTHORIZED, description = "Missing or invalid session token",
            body = http_kit::Problem, content_type = "application/problem+json")
    )
)]
pub(crate) async fn delete_connection(
    State(state): State<AppState>,
    ShopSession(session): ShopSession,
) -> Result<Json<CodeFixesDto>, ApiError> {
    channel(&state)?;
    staff(&session)?;
    let mut tx = state.db.tenant(session.tenant).await?;
    if let Some(live) = store::live_installation(&mut tx).await? {
        store::unlink_installation(&mut tx, live.id).await?;
        audit::append(
            &mut tx,
            &audit::NewEntry {
                actor_kind: ActorKind::User,
                actor_id: actor_id(&session),
                action: "github.disconnected".to_owned(),
                subject_type: "github_installation".to_owned(),
                subject_id: live.id,
                data: json!({}),
            },
        )
        .await?;
    }
    let dto = screen(&mut tx, session.shop_id, true).await?;
    tx.commit().await?;
    Ok(Json(dto))
}

// ---------------------------------------------------------------------------------------------
// Requesting pull requests

/// A label the person wrote for a control that has none (a judgement call Rampsmith will not make).
#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct LabelBody {
    /// The translation key the label is stored under, such as `general.cart`.
    key: String,
    /// The label, in the store's default language.
    text: String,
}

/// What the person brings for one finding that needs judgement.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct JudgementBody {
    /// The finding it is for.
    finding_id: String,
    /// The accessible name to add.
    label: Option<LabelBody>,
    /// Why a decorative image has no text alternative.
    decorative_reason: Option<String>,
    /// The `id` to give an element that needs one.
    id: Option<String>,
}

/// Asks Rampsmith to open pull requests for the store's open code findings.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct CreateBatchBody {
    /// What the person brings for findings that need judgement.
    #[serde(default)]
    judgements: Vec<JudgementBody>,
}

/// The request that was accepted.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct CreateBatchDto {
    /// Rampsmith's id for it.
    id: String,
    /// Always `reading`: ctl reads the theme files next.
    status: String,
    /// `core` or `every`: the recipes the plan includes.
    recipes: String,
}

const MAX_JUDGEMENTS: usize = 50;
const MAX_TEXT_CHARS: usize = 200;

fn key_is_well_formed(key: &str) -> bool {
    (1..=80).contains(&key.len())
        && key
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_'))
}

fn text_is_well_formed(text: &str) -> bool {
    !text.trim().is_empty()
        && text.chars().count() <= MAX_TEXT_CHARS
        && !text.chars().any(char::is_control)
}

/// The judgements as the engine reads them. A value that is not well formed refuses the request.
fn judgements_json(items: &[JudgementBody]) -> Result<serde_json::Value, ApiError> {
    if items.len() > MAX_JUDGEMENTS {
        return Err(invalid("judgements", "has too many entries"));
    }
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let finding = Uuid::parse_str(&item.finding_id)
            .map_err(|_| invalid("judgements", "has a finding_id that is not an id"))?;
        let mut entry = serde_json::Map::new();
        entry.insert("finding_id".to_owned(), json!(finding));
        if let Some(label) = &item.label {
            if !key_is_well_formed(&label.key) || !text_is_well_formed(&label.text) {
                return Err(invalid("judgements", "has a label that is not valid"));
            }
            entry.insert(
                "label".to_owned(),
                json!({"key": label.key, "text": label.text}),
            );
        }
        if let Some(reason) = &item.decorative_reason {
            if !text_is_well_formed(reason) {
                return Err(invalid("judgements", "has a reason that is not valid"));
            }
            entry.insert("decorative_reason".to_owned(), json!(reason));
        }
        if let Some(id) = &item.id {
            let well_formed = (1..=64).contains(&id.len())
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'));
            if !well_formed {
                return Err(invalid("judgements", "has an id that is not valid"));
            }
            entry.insert("id".to_owned(), json!(id));
        }
        out.push(serde_json::Value::Object(entry));
    }
    Ok(serde_json::Value::Array(out))
}

/// The recipes a plan includes: every recipe, or the core ones, or none.
async fn recipes_of(tx: &mut TenantTx, shop: ShopId) -> Result<&'static str, ApiError> {
    let stored = shop_billing::get(tx, shop).await?;
    let plan = entitlements_of(&state_of(stored.as_ref())).plan();
    if !matches!(
        feature_gate(plan, Feature::GithubPullRequests),
        Gate::Allowed
    ) {
        return Err(plan_refusal());
    }
    if matches!(feature_gate(plan, Feature::EveryRecipe), Gate::Allowed) {
        Ok("every")
    } else if matches!(feature_gate(plan, Feature::CoreRecipes), Gate::Allowed) {
        Ok("core")
    } else {
        Err(plan_refusal())
    }
}

/// Requests pull requests for the store's open code findings. Rampsmith reads the theme files
/// from the chosen repository, makes the fixes, and opens a pull request on a
/// `rampsmith/fix-<batch>` branch. It never merges.
#[utoipa::path(
    post,
    path = "/v1/shopify/code-fixes/batches",
    tag = "code-fixes",
    operation_id = "createCodeFixBatch",
    security(("shopify_session" = [])),
    request_body = CreateBatchBody,
    responses(
        (status = ACCEPTED, description = "The request was accepted", body = CreateBatchDto),
        (status = FORBIDDEN, description = "The plan does not include pull requests, or no signed-in staff member",
            body = http_kit::Problem, content_type = "application/problem+json"),
        (status = NOT_FOUND, description = "The channel is not switched on",
            body = http_kit::Problem, content_type = "application/problem+json"),
        (status = CONFLICT, description = "No theme repository is ready, or a request is already in progress",
            body = http_kit::Problem, content_type = "application/problem+json"),
        (status = UNPROCESSABLE_ENTITY, description = "A judgement is not valid",
            body = http_kit::Problem, content_type = "application/problem+json"),
        (status = UNAUTHORIZED, description = "Missing or invalid session token",
            body = http_kit::Problem, content_type = "application/problem+json")
    )
)]
pub(crate) async fn create_batch(
    State(state): State<AppState>,
    ShopSession(session): ShopSession,
    Body(body): Body<CreateBatchBody>,
) -> Result<(axum::http::StatusCode, Json<CreateBatchDto>), ApiError> {
    channel(&state)?;
    staff(&session)?;
    let judgements = judgements_json(&body.judgements)?;
    let mut tx = state.db.tenant(session.tenant).await?;
    let recipes = recipes_of(&mut tx, session.shop_id).await?;
    let site = site_of(&mut tx, session.shop_id).await?;
    let ready = store::live_installation(&mut tx).await?.is_some();
    let repo = store::selected_repo(&mut tx)
        .await?
        .filter(|r| ready && r.status == "available" && !r.archived && r.theme_state == "ok");
    let Some((repo, base)) = repo.and_then(|r| {
        let base = r.connected_branch.clone()?;
        Some((r, base))
    }) else {
        return Err(ApiError::new(ProblemCode::Conflict)
            .detail("Choose a theme repository, and wait for the theme check, first."));
    };
    let batch_id = Uuid::now_v7().simple().to_string();
    let created = batches::create_batch(
        &mut tx,
        &NewBatch {
            site: site.as_uuid(),
            repo_row: repo.id,
            batch_id,
            base_branch: base,
            requested_by: actor_id(&session),
            recipes: recipes.to_owned(),
            judgements,
        },
    )
    .await?;
    let Created::New(id) = created else {
        return Err(ApiError::new(ProblemCode::Conflict)
            .detail("Pull requests are already being prepared for this store."));
    };
    audit::append(
        &mut tx,
        &audit::NewEntry {
            actor_kind: ActorKind::User,
            actor_id: actor_id(&session),
            action: "github.batch_requested".to_owned(),
            subject_type: "code_fix_batch".to_owned(),
            subject_id: id,
            data: json!({"recipes": recipes, "judgements": body.judgements.len()}),
        },
    )
    .await?;
    let payload =
        serde_json::to_value(GithubPlanBatch { batch_row: id }).map_err(|e| queue_error(&e))?;
    job_repo::enqueue(
        &mut tx,
        NewJob::new(GithubPlanBatch::QUEUE, GithubPlanBatch::SCHEMA, payload)
            .idempotency_key(format!("{}:{id}", GithubPlanBatch::QUEUE))
            .max_attempts(5),
    )
    .await?;
    tx.commit().await?;
    Ok((
        axum::http::StatusCode::ACCEPTED,
        Json(CreateBatchDto {
            id: id.to_string(),
            status: "reading".to_owned(),
            recipes: recipes.to_owned(),
        }),
    ))
}
