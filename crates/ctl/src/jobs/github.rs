//! The GitHub pull-request channel's jobs (PLAN §15, ADR-290 to ADR-294): refreshing an
//! installation from the API, processing a stored webhook delivery, and checking that the
//! chosen repository is a Shopify theme.
//!
//! `ctl` holds the App's private key; the `api` never does and the engine never does. Every
//! read here goes through `crates/github`, whose guards limit what can be touched: theme paths
//! only, regular files, no symlinks or submodules.
//!
//! A webhook only announces that something changed (integration audit M1). The installation's
//! state and its repositories are read from the API, so a forged or replayed delivery can at
//! worst cause one extra read.

use contracts::{GithubCheckRepository, GithubProcessEvent, GithubSyncInstallation};
use db::repo::github::{self as store, RepoUpsert};
use db::repo::{audit, jobs as job_repo};
use domain::ActorKind;
use github::{
    BranchName, Event, GitHub, GitHubError, InstallationId, RepoRef, RepositoryId, TokenScope,
};
use queue::{ClaimedJob, Failure, NewJob};
use serde_json::json;
use tracing::{info, instrument, warn};
use uuid::Uuid;

use super::{Jobs, database, failure, payload, tenant_of};

/// The queues that exist only while the channel is on.
pub const QUEUES: [&str; 3] = [
    GithubSyncInstallation::QUEUE,
    GithubProcessEvent::QUEUE,
    GithubCheckRepository::QUEUE,
];

/// A GitHub failure, classified by whether a retry can help. Messages carry no token or body.
pub(crate) fn github_failure(error: &GitHubError) -> Failure {
    let code = match error {
        GitHubError::Transport(_) => "github_unreachable",
        GitHubError::Unauthorized => "github_unauthorized",
        GitHubError::Forbidden { .. } => "github_forbidden",
        GitHubError::NotFound => "github_not_found",
        GitHubError::RateLimited { .. } => "github_rate_limited",
        GitHubError::Server { .. } => "github_server_error",
        _ => "github_error",
    };
    failure(error.is_retryable(), code, error.to_string())
}

impl Jobs {
    /// The GitHub client, when the channel is on. A job for a channel that is off is a wiring
    /// mistake (nothing enqueues one), so it ends rather than retries.
    fn github(&self, job: &ClaimedJob) -> Result<&GitHub, Failure> {
        self.github.as_deref().ok_or_else(|| {
            failure(
                false,
                "code_fix_channel_off",
                format!("{} ran while CODE_FIX_CHANNEL_ENABLED is off", job.queue),
            )
        })
    }
}

fn installation_id(raw: i64) -> Result<InstallationId, Failure> {
    u64::try_from(raw).map(InstallationId::new).map_err(|_| {
        failure(
            false,
            "installation_invalid",
            "the stored installation id is invalid",
        )
    })
}

/// Handles one `github.sync_installation@1` job: makes the stored installation and its
/// repositories match what the API says now.
#[instrument(skip_all, fields(job = %job.lease.job_id), err(Debug))]
pub async fn sync_installation(jobs: &Jobs, job: ClaimedJob) -> Result<(), Failure> {
    let GithubSyncInstallation { installation_row } =
        payload(&job, GithubSyncInstallation::SCHEMA)?;
    let tenant = tenant_of(&job)?;
    let client = jobs.github(&job)?;
    let mut tx = jobs.db.tenant(tenant).await.map_err(|e| database(&e))?;
    let row = store::installation(&mut tx, installation_row)
        .await
        .map_err(|e| database(&e))?;
    tx.rollback().await.map_err(|e| database(&e))?;
    let Some(row) = row.filter(|r| r.status != "deleted") else {
        // Disconnected while the job waited.
        return Ok(());
    };
    let id = installation_id(row.installation_id)?;

    // The API is believed, not the webhook that sent us here.
    let current = client
        .installation(id)
        .await
        .map_err(|e| github_failure(&e))?;
    let Some(info) = current else {
        let mut tx = jobs.db.tenant(tenant).await.map_err(|e| database(&e))?;
        store::unlink_installation(&mut tx, installation_row)
            .await
            .map_err(|e| database(&e))?;
        record(
            &mut tx,
            "github.installation_removed",
            installation_row,
            json!({}),
        )
        .await?;
        tx.commit().await.map_err(|e| database(&e))?;
        info!("the GitHub App was uninstalled; the link ended");
        return Ok(());
    };
    let status = if info.suspended_at.is_some() {
        "suspended"
    } else {
        "active"
    };
    let selection = match info.repository_selection {
        github::RepositorySelection::All => "all",
        github::RepositorySelection::Selected => "selected",
    };
    let listing = if status == "active" {
        Some(
            client
                .installation_repositories(id)
                .await
                .map_err(|e| github_failure(&e))?,
        )
    } else {
        None
    };

    let mut tx = jobs.db.tenant(tenant).await.map_err(|e| database(&e))?;
    let login = info.account.login.clone().unwrap_or(row.account_login);
    store::set_installation_state(&mut tx, installation_row, status, selection, &login)
        .await
        .map_err(|e| database(&e))?;
    let mut repositories = None;
    if let Some(listing) = listing {
        let truncated = listing.truncated;
        let repos: Vec<RepoUpsert> = listing
            .items
            .into_iter()
            .filter_map(|r| {
                Some(RepoUpsert {
                    repo_id: i64::try_from(r.id.get()).ok()?,
                    full_name: r.full_name,
                    default_branch: r.default_branch.unwrap_or_else(|| "main".to_owned()),
                    is_private: r.private,
                    archived: r.archived,
                    // What the installer could push to was recorded when they connected; the
                    // installation token cannot say it.
                    user_can_push: None,
                })
            })
            .collect();
        if truncated {
            warn!("the installation lists more repositories than are read; none is removed");
        }
        repositories = Some(
            store::sync_repos(&mut tx, installation_row, &repos, !truncated)
                .await
                .map_err(|e| database(&e))?,
        );
    }
    record(
        &mut tx,
        "github.installation_synced",
        installation_row,
        json!({"status": status, "selection": selection, "repositories": repositories}),
    )
    .await?;
    tx.commit().await.map_err(|e| database(&e))?;
    Ok(())
}

/// Handles one `github.process_event@1` job: one delivery, already verified and stored.
#[instrument(skip_all, fields(job = %job.lease.job_id), err(Debug))]
pub async fn process_event(jobs: &Jobs, job: ClaimedJob) -> Result<(), Failure> {
    let GithubProcessEvent { event_id } = payload(&job, GithubProcessEvent::SCHEMA)?;
    let tenant = tenant_of(&job)?;
    let mut tx = jobs.db.tenant(tenant).await.map_err(|e| database(&e))?;
    let Some(event) = store::event(&mut tx, event_id)
        .await
        .map_err(|e| database(&e))?
    else {
        tx.rollback().await.map_err(|e| database(&e))?;
        return Err(failure(
            false,
            "event_missing",
            "the GitHub event does not exist",
        ));
    };
    if event.processed_at.is_some() {
        tx.rollback().await.map_err(|e| database(&e))?;
        return Ok(());
    }
    if jobs.github.is_none() {
        // The channel was switched off after the delivery arrived: drop it.
        store::mark_event_processed(&mut tx, event_id)
            .await
            .map_err(|e| database(&e))?;
        return tx.commit().await.map_err(|e| database(&e));
    }
    // The stored copy is what is processed, parsed again as the documented payload.
    let bytes = serde_json::to_vec(&event.body)
        .map_err(|e| failure(false, "event_unreadable", e.to_string()))?;
    let parsed = Event::parse(&event.event, &bytes)
        .map_err(|_| failure(false, "event_unreadable", "the stored event does not parse"))?;
    let live = store::live_installation(&mut tx)
        .await
        .map_err(|e| database(&e))?;
    // Only the store's own installation matters; the event's body is not trusted to say which.
    let ours = live.filter(|l| l.installation_id == event.installation_id);
    // Pull request and push events are matched to the pull requests Rampsmith opened by
    // repository id and number (audit L8), which arrive with the patch pipeline.
    if let (Event::Installation(_) | Event::InstallationRepositories(_), Some(ours)) =
        (&parsed, ours)
    {
        {
            let payload = serde_json::to_value(GithubSyncInstallation {
                installation_row: ours.id,
            })
            .map_err(|e| failure(false, "payload_invalid", e.to_string()))?;
            job_repo::enqueue(
                &mut tx,
                NewJob::new(
                    GithubSyncInstallation::QUEUE,
                    GithubSyncInstallation::SCHEMA,
                    payload,
                )
                .idempotency_key(format!(
                    "{}:{}:event:{event_id}",
                    GithubSyncInstallation::QUEUE,
                    ours.id
                )),
            )
            .await
            .map_err(|e| database(&e))?;
        }
    }
    store::mark_event_processed(&mut tx, event_id)
        .await
        .map_err(|e| database(&e))?;
    tx.commit().await.map_err(|e| database(&e))
}

/// Handles one `github.check_repository@1` job: is the chosen branch a Shopify theme?
#[instrument(skip_all, fields(job = %job.lease.job_id), err(Debug))]
pub async fn check_repository(jobs: &Jobs, job: ClaimedJob) -> Result<(), Failure> {
    let GithubCheckRepository { repo_row } = payload(&job, GithubCheckRepository::SCHEMA)?;
    let tenant = tenant_of(&job)?;
    let client = jobs.github(&job)?;
    let mut tx = jobs.db.tenant(tenant).await.map_err(|e| database(&e))?;
    let repo = store::repo(&mut tx, repo_row)
        .await
        .map_err(|e| database(&e))?;
    let live = store::live_installation(&mut tx)
        .await
        .map_err(|e| database(&e))?;
    tx.rollback().await.map_err(|e| database(&e))?;
    // Chosen again, changed or disconnected while the job waited: nothing to check.
    let (Some(repo), Some(live)) = (repo, live) else {
        return Ok(());
    };
    let (true, "available", Some(branch)) = (
        repo.selected,
        repo.status.as_str(),
        repo.connected_branch.as_deref(),
    ) else {
        return Ok(());
    };
    let (Some((owner, name)), Ok(branch), Ok(repo_id)) = (
        repo.full_name.split_once('/'),
        BranchName::parse(branch),
        u64::try_from(repo.repo_id),
    ) else {
        return Err(failure(
            false,
            "repository_invalid",
            "the stored repository is invalid",
        ));
    };
    let reference = RepoRef::new(owner, name).map_err(|_| {
        failure(
            false,
            "repository_invalid",
            "the stored repository name is invalid",
        )
    })?;
    let handle = client.repository(
        installation_id(live.installation_id)?,
        reference,
        TokenScope::read_theme(RepositoryId::new(repo_id)),
    );
    let (state, reason) = match handle.branch_head(&branch).await {
        Ok(None) => ("not_a_theme", "branch_missing"),
        Ok(Some(head)) => match handle.theme_tree(&head).await {
            Ok(_) => ("ok", "theme"),
            Err(GitHubError::Structure(_)) => ("not_a_theme", "structure"),
            Err(GitHubError::TreeTruncated) => ("not_a_theme", "too_large"),
            Err(error) => return finish_unreachable(jobs, tenant, repo_row, &error).await,
        },
        Err(error) => return finish_unreachable(jobs, tenant, repo_row, &error).await,
    };
    set_state(jobs, tenant, repo_row, state, reason).await
}

/// A read that cannot succeed (the App lost access) is recorded; a transient one is retried.
async fn finish_unreachable(
    jobs: &Jobs,
    tenant: domain::TenantId,
    repo_row: Uuid,
    error: &GitHubError,
) -> Result<(), Failure> {
    if error.is_retryable() {
        return Err(github_failure(error));
    }
    warn!(%error, "the chosen repository cannot be read");
    set_state(jobs, tenant, repo_row, "unreachable", "unreadable").await
}

async fn set_state(
    jobs: &Jobs,
    tenant: domain::TenantId,
    repo_row: Uuid,
    state: &str,
    reason: &str,
) -> Result<(), Failure> {
    let mut tx = jobs.db.tenant(tenant).await.map_err(|e| database(&e))?;
    store::set_theme_state(&mut tx, repo_row, state)
        .await
        .map_err(|e| database(&e))?;
    record(
        &mut tx,
        "github.repository_checked",
        repo_row,
        json!({"state": state, "reason": reason}),
    )
    .await?;
    tx.commit().await.map_err(|e| database(&e))
}

async fn record(
    tx: &mut db::TenantTx,
    action: &str,
    subject: Uuid,
    data: serde_json::Value,
) -> Result<(), Failure> {
    audit::append(
        tx,
        &audit::NewEntry {
            actor_kind: ActorKind::System,
            actor_id: None,
            action: action.to_owned(),
            subject_type: "github".to_owned(),
            subject_id: subject,
            data,
        },
    )
    .await
    .map_err(|e| database(&e))?;
    Ok(())
}
