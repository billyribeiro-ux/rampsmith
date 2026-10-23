//! The code-fix pipeline's `ctl` side (PLAN §15, ADR-295 to ADR-299): reading the theme files
//! from the merchant's repository, turning the engine's fixes into commits on
//! `rampsmith/fix-<batch>` and a pull request, and keeping the pull request's recorded state
//! in step with GitHub.
//!
//! Only `ctl` holds the GitHub App's key. The engine sees the theme source `ctl` stored for the
//! batch and never the repository. Nothing here merges, and nothing writes to the connected
//! branch: the guards in `crates/github` refuse both.

use std::collections::{BTreeMap, HashMap};

use contracts::{CodeFixPatch, GithubOpenPullRequest, GithubPlanBatch, GithubSyncPullRequest};
use db::repo::code_fix::{self as batches, BatchFile, BatchFix, BatchRow, NewPullRequest};
use db::repo::github::{self as store, RepoRow};
use db::repo::{audit, jobs as job_repo};
use domain::ActorKind;
use github::{
    BatchId, BranchName, CheckRunId, FileMode, FilePatch, FixId, GitHub, GitHubError,
    InstallationId, PrLimits, PullRequestPlan, RefUpdate, RepoRef, Repository, RepositoryId, Sha,
    ThemeFile, ThemePath, TokenScope, Verification, WcagCriterion, plan_pull_requests,
    verification_check_run,
};
use queue::{ClaimedJob, Failure, NewJob};
use serde_json::json;
use time::OffsetDateTime;
use tracing::{info, instrument, warn};
use url::Url;
use uuid::Uuid;

use super::github::github_failure;
use super::{Jobs, database, failure, payload, tenant_of};

/// Most theme files one batch reads.
const MAX_FILES: usize = 800;
/// Largest theme file kept (the `code_fix_files` limit).
const MAX_FILE_BYTES: usize = 1_048_576;
/// Most bytes of theme source one batch reads.
const MAX_TOTAL_BYTES: usize = 16 * 1_048_576;

/// The batch statuses in which a job may still change it.
const IN_FLIGHT: [&str; 4] = ["reading", "patching", "ready", "opening"];

/// What a job needs to reach the batch's repository.
struct Context {
    batch: BatchRow,
    repo: RepoRow,
    installation: InstallationId,
    reference: RepoRef,
    repo_id: RepositoryId,
    base: BranchName,
}

fn invalid(what: &'static str) -> Failure {
    failure(false, "repository_invalid", what)
}

fn code_of(failure: &Failure) -> String {
    let (Failure::Retryable(error) | Failure::Permanent(error)) = failure;
    error.code.clone()
}

/// A failure that ends the batch: it can never succeed, or this was the last attempt.
fn is_final(job: &ClaimedJob, failure: &Failure) -> bool {
    matches!(failure, Failure::Permanent(_)) || job.lease.attempt >= job.max_attempts
}

/// Ends the batch without a pull request when `result` is a final failure, so the store is not
/// left with a batch in flight that blocks the next one; the stored theme source goes with it.
async fn settle(
    jobs: &Jobs,
    job: &ClaimedJob,
    tenant: domain::TenantId,
    batch_row: Uuid,
    result: Result<(), Failure>,
) -> Result<(), Failure> {
    let Err(error) = result else {
        return Ok(());
    };
    if is_final(job, &error) {
        let mut tx = jobs.db.tenant(tenant).await.map_err(|e| database(&e))?;
        let batch = batches::batch_for_update(&mut tx, batch_row)
            .await
            .map_err(|e| database(&e))?;
        if batch.is_some_and(|b| IN_FLIGHT.contains(&b.status.as_str())) {
            batches::finish_batch(&mut tx, batch_row, "failed", Some(&code_of(&error)))
                .await
                .map_err(|e| database(&e))?;
            record(
                &mut tx,
                "github.batch_failed",
                batch_row,
                json!({"code": code_of(&error)}),
            )
            .await?;
        }
        tx.commit().await.map_err(|e| database(&e))?;
    }
    Err(error)
}

/// The batch, its repository and the live installation, or `None` when the batch is gone.
async fn context(
    jobs: &Jobs,
    tenant: domain::TenantId,
    batch_row: Uuid,
) -> Result<Option<Context>, Failure> {
    let mut tx = jobs.db.tenant(tenant).await.map_err(|e| database(&e))?;
    let batch = batches::batch(&mut tx, batch_row)
        .await
        .map_err(|e| database(&e))?;
    let Some(batch) = batch else {
        tx.rollback().await.map_err(|e| database(&e))?;
        return Ok(None);
    };
    let repo = store::repo(&mut tx, batch.repo_row)
        .await
        .map_err(|e| database(&e))?;
    let live = store::live_installation(&mut tx)
        .await
        .map_err(|e| database(&e))?;
    tx.rollback().await.map_err(|e| database(&e))?;
    let (Some(repo), Some(live)) = (repo, live) else {
        return Err(failure(
            false,
            "repository_unavailable",
            "the repository or the installation is gone",
        ));
    };
    if !repo.selected || repo.status != "available" || repo.archived {
        return Err(failure(
            false,
            "repository_unavailable",
            "the repository is no longer chosen and available",
        ));
    }
    let (Some((owner, name)), Ok(base), Ok(repo_id), Ok(installation)) = (
        repo.full_name.split_once('/'),
        BranchName::parse(&batch.base_branch),
        u64::try_from(repo.repo_id),
        u64::try_from(live.installation_id),
    ) else {
        return Err(invalid("the stored repository is invalid"));
    };
    let reference =
        RepoRef::new(owner, name).map_err(|_| invalid("the stored repository name is invalid"))?;
    Ok(Some(Context {
        batch,
        reference,
        base,
        repo_id: RepositoryId::new(repo_id),
        installation: InstallationId::new(installation),
        repo,
    }))
}

fn handle<'a>(client: &'a GitHub, ctx: &Context, scope: TokenScope) -> Repository<'a> {
    client.repository(ctx.installation, ctx.reference.clone(), scope)
}

/// A theme file worth giving the patcher: Liquid, and the locale files the recipes edit.
fn wanted(path: &str) -> bool {
    let liquid = path.ends_with(".liquid")
        && ["sections/", "snippets/", "blocks/", "layout/", "templates/"]
            .iter()
            .any(|dir| path.starts_with(dir));
    liquid || (path.starts_with("locales/") && path.ends_with(".json"))
}

/// One theme file as read.
struct Source {
    path: String,
    content: String,
    blob: String,
}

/// Reads the wanted files of `files` through the read guards. A file that is too large or not
/// text is left out (a recipe cannot edit it); the batch fails only if it reads too much.
async fn read_sources(
    repository: &Repository<'_>,
    files: &[ThemeFile],
) -> Result<Vec<Source>, Failure> {
    let mut wanted_files: Vec<&ThemeFile> = files
        .iter()
        .filter(|f| wanted(f.path().as_str()))
        .collect();
    wanted_files.sort_by(|a, b| a.path().as_str().cmp(b.path().as_str()));
    if wanted_files.len() > MAX_FILES {
        return Err(failure(
            false,
            "theme_too_large",
            "the theme has more files than one batch reads",
        ));
    }
    let mut total = 0_usize;
    let mut out = Vec::with_capacity(wanted_files.len());
    for file in wanted_files {
        let bytes = repository
            .read_theme_file(file)
            .await
            .map_err(|e| github_failure(&e))?;
        if bytes.len() > MAX_FILE_BYTES {
            continue;
        }
        let Ok(content) = String::from_utf8(bytes) else {
            continue;
        };
        total += content.len();
        if total > MAX_TOTAL_BYTES {
            return Err(failure(
                false,
                "theme_too_large",
                "the theme is larger than one batch reads",
            ));
        }
        out.push(Source {
            path: file.path().to_string(),
            content,
            blob: file.sha().to_string(),
        });
    }
    Ok(out)
}

fn tree_failure(error: &GitHubError) -> Failure {
    match error {
        GitHubError::Structure(_) | GitHubError::TreeTruncated => {
            failure(false, "not_a_theme", "the branch is not a readable theme")
        }
        other => github_failure(other),
    }
}

/// Handles one `github.plan_batch@1` job: reads the connected branch's theme files into the
/// batch and hands it to the engine.
#[instrument(skip_all, fields(job = %job.lease.job_id), err(Debug))]
pub async fn plan_batch(jobs: &Jobs, job: ClaimedJob) -> Result<(), Failure> {
    let GithubPlanBatch { batch_row } = payload(&job, GithubPlanBatch::SCHEMA)?;
    let tenant = tenant_of(&job)?;
    let result = read_batch(jobs, &job, tenant, batch_row).await;
    settle(jobs, &job, tenant, batch_row, result).await
}

async fn read_batch(
    jobs: &Jobs,
    job: &ClaimedJob,
    tenant: domain::TenantId,
    batch_row: Uuid,
) -> Result<(), Failure> {
    let client = jobs.github(job)?;
    let Some(ctx) = context(jobs, tenant, batch_row).await? else {
        return Ok(());
    };
    if ctx.batch.status != "reading" {
        // Another attempt got here first.
        return Ok(());
    }
    let repository = handle(client, &ctx, TokenScope::read_theme(ctx.repo_id));
    let head = repository
        .branch_head(&ctx.base)
        .await
        .map_err(|e| github_failure(&e))?
        .ok_or_else(|| failure(false, "branch_missing", "the connected branch is gone"))?;
    let tree = repository
        .theme_tree(&head)
        .await
        .map_err(|e| tree_failure(&e))?;
    let sources = read_sources(&repository, &tree.theme_files).await?;
    if sources.is_empty() {
        return Err(failure(
            false,
            "no_theme_files",
            "the theme has no Liquid files to patch",
        ));
    }

    let mut tx = jobs.db.tenant(tenant).await.map_err(|e| database(&e))?;
    for source in &sources {
        batches::add_source_file(&mut tx, batch_row, &source.path, &source.content, &source.blob)
            .await
            .map_err(|e| database(&e))?;
    }
    let moved = batches::files_read(&mut tx, batch_row, head.as_str())
        .await
        .map_err(|e| database(&e))?;
    if !moved {
        tx.rollback().await.map_err(|e| database(&e))?;
        return Ok(());
    }
    let payload = serde_json::to_value(CodeFixPatch { batch_row })
        .map_err(|e| failure(false, "payload_invalid", e.to_string()))?;
    job_repo::enqueue(
        &mut tx,
        NewJob::new(CodeFixPatch::QUEUE, CodeFixPatch::SCHEMA, payload)
            .idempotency_key(format!("{}:{batch_row}", CodeFixPatch::QUEUE))
            .max_attempts(5),
    )
    .await
    .map_err(|e| database(&e))?;
    record(
        &mut tx,
        "github.batch_read",
        batch_row,
        json!({"files": sources.len()}),
    )
    .await?;
    tx.commit().await.map_err(|e| database(&e))?;
    info!(files = sources.len(), "the theme files were read for a batch");
    Ok(())
}

/// The fixes of a batch as `crates/github` takes them. Each fix starts from the previous fix's
/// result for a file, which is how the stored files chain.
fn build_batch(
    batch_id: &BatchId,
    fixes: &[BatchFix],
    files: &[BatchFile],
    modes: &HashMap<String, FileMode>,
    origin: &str,
) -> Result<github::Batch, Failure> {
    let broken = |what: &'static str| failure(false, "batch_invalid", what);
    let mut current: HashMap<&str, &str> = files
        .iter()
        .filter(|f| f.ordinal == 0)
        .map(|f| (f.path.as_str(), f.content.as_str()))
        .collect();
    let mut by_ordinal: BTreeMap<i32, Vec<&BatchFile>> = BTreeMap::new();
    for file in files.iter().filter(|f| f.ordinal > 0) {
        by_ordinal.entry(file.ordinal).or_default().push(file);
    }
    let mut out = Vec::with_capacity(fixes.len());
    for fix in fixes {
        let mut patches = Vec::new();
        for file in by_ordinal.get(&fix.ordinal).into_iter().flatten() {
            let before = current
                .get(file.path.as_str())
                .copied()
                .ok_or_else(|| broken("a fixed file has no source"))?;
            patches.push(FilePatch {
                path: ThemePath::parse(&file.path).map_err(|_| broken("a stored path is invalid"))?,
                mode: modes.get(&file.path).copied().unwrap_or_default(),
                before: before.to_owned(),
                after: file.content.clone(),
            });
            current.insert(file.path.as_str(), file.content.as_str());
        }
        let evidence = Url::parse(&format!("{origin}/app/fixes/{}", fix.fix_id))
            .map_err(|_| broken("the evidence link is invalid"))?;
        out.push(github::Fix {
            id: FixId::parse(&fix.fix_id.to_string()).map_err(|_| broken("a fix id is invalid"))?,
            summary: fix.summary.clone(),
            finding: fix.finding.clone(),
            criterion: WcagCriterion::parse(&fix.criterion)
                .map_err(|_| broken("a criterion is invalid"))?,
            evidence_url: evidence,
            files: patches,
        });
    }
    Ok(github::Batch {
        id: batch_id.clone(),
        fixes: out,
    })
}

/// Handles one `github.open_pr@1` job: commits, pushes and opens the pull request(s). It never
/// merges and never touches the connected branch.
#[instrument(skip_all, fields(job = %job.lease.job_id), err(Debug))]
pub async fn open_pr(jobs: &Jobs, job: ClaimedJob) -> Result<(), Failure> {
    let GithubOpenPullRequest { batch_row } = payload(&job, GithubOpenPullRequest::SCHEMA)?;
    let tenant = tenant_of(&job)?;
    let result = open_batch(jobs, &job, tenant, batch_row).await;
    settle(jobs, &job, tenant, batch_row, result).await
}

async fn open_batch(
    jobs: &Jobs,
    job: &ClaimedJob,
    tenant: domain::TenantId,
    batch_row: Uuid,
) -> Result<(), Failure> {
    let client = jobs.github(job)?;
    let origin = jobs.app_origin.as_deref().ok_or_else(|| {
        failure(
            false,
            "app_origin_missing",
            "APP_ORIGIN is needed for the evidence links",
        )
    })?;
    let Some(ctx) = context(jobs, tenant, batch_row).await? else {
        return Ok(());
    };
    let resumed = match ctx.batch.status.as_str() {
        "ready" => false,
        "opening" => true,
        _ => return Ok(()),
    };
    let (fixes, files, existing) = load_batch(jobs, tenant, &ctx, resumed).await?;
    let Some(base_sha) = ctx.batch.base_sha.as_deref().and_then(|s| Sha::parse(s).ok()) else {
        return Err(failure(false, "batch_invalid", "the batch has no base commit"));
    };
    let repository = handle(client, &ctx, TokenScope::fix_pull_requests(ctx.repo_id));
    let tree = repository
        .theme_tree(&base_sha)
        .await
        .map_err(|e| tree_failure(&e))?;
    let modes: HashMap<String, FileMode> = tree
        .theme_files
        .iter()
        .map(|f| (f.path().to_string(), f.mode()))
        .collect();
    let batch_id = BatchId::parse(&ctx.batch.batch_id)
        .map_err(|_| failure(false, "batch_invalid", "the batch id is invalid"))?;
    let batch = build_batch(&batch_id, &fixes, &files, &modes, origin)?;
    let plans = plan_pull_requests(&batch, ctx.base.as_str(), PrLimits::default())
        .map_err(|e| failure(false, "plan_invalid", e.to_string()))?;
    for plan in &plans {
        let part = i32::try_from(plan.part)
            .map_err(|_| failure(false, "plan_invalid", "too many parts"))?;
        let row = existing.iter().find(|r| r.part == part);
        publish(
            jobs,
            tenant,
            &Publish {
                ctx: &ctx,
                repository: &repository,
                batch_id: &batch_id,
                base_sha: &base_sha,
                origin,
                resumed,
            },
            plan,
            row,
        )
        .await?;
    }
    let mut tx = jobs.db.tenant(tenant).await.map_err(|e| database(&e))?;
    batches::finish_batch(&mut tx, batch_row, "opened", None)
        .await
        .map_err(|e| database(&e))?;
    record(
        &mut tx,
        "github.batch_opened",
        batch_row,
        json!({"pull_requests": plans.len(), "fixes": fixes.len()}),
    )
    .await?;
    tx.commit().await.map_err(|e| database(&e))
}

/// Moves a `ready` batch to `opening` and reads what is needed to build it.
async fn load_batch(
    jobs: &Jobs,
    tenant: domain::TenantId,
    ctx: &Context,
    resumed: bool,
) -> Result<(Vec<BatchFix>, Vec<BatchFile>, Vec<db::repo::code_fix::PullRequestRow>), Failure> {
    let mut tx = jobs.db.tenant(tenant).await.map_err(|e| database(&e))?;
    let id = ctx.batch.id;
    if !resumed {
        batches::move_batch(&mut tx, id, "ready", "opening")
            .await
            .map_err(|e| database(&e))?;
    }
    let fixes = batches::batch_fixes(&mut tx, id)
        .await
        .map_err(|e| database(&e))?;
    let files = batches::batch_files(&mut tx, id)
        .await
        .map_err(|e| database(&e))?;
    let existing = batches::pull_requests_of_batch(&mut tx, &ctx.batch.batch_id)
        .await
        .map_err(|e| database(&e))?;
    tx.commit().await.map_err(|e| database(&e))?;
    if fixes.is_empty() || files.is_empty() {
        return Err(failure(false, "files_missing", "the batch has no fixes"));
    }
    Ok((fixes, files, existing))
}

/// What publishing one part shares with the others.
struct Publish<'a> {
    ctx: &'a Context,
    repository: &'a Repository<'a>,
    batch_id: &'a BatchId,
    base_sha: &'a Sha,
    origin: &'a str,
    resumed: bool,
}

/// How the part's branch is moved. A branch Rampsmith already pushed to is replaced only while
/// it still points where Rampsmith left it (audit L3). A resumed batch with no recorded pull
/// request is the crash between the push and the record: the branch is Rampsmith's by name, and
/// is replaced only while it still points where it is now.
async fn ref_update(
    publish: &Publish<'_>,
    plan: &PullRequestPlan,
    row: Option<&db::repo::code_fix::PullRequestRow>,
) -> Result<RefUpdate, Failure> {
    if let Some(row) = row {
        let expected_head = Sha::parse(&row.pushed_sha)
            .map_err(|_| failure(false, "batch_invalid", "the stored head is invalid"))?;
        return Ok(RefUpdate::Rederive { expected_head });
    }
    if !publish.resumed {
        return Ok(RefUpdate::FastForward);
    }
    Ok(
        match publish
            .repository
            .branch_head(plan.head.as_branch())
            .await
            .map_err(|e| github_failure(&e))?
        {
            Some(expected_head) => RefUpdate::Rederive { expected_head },
            None => RefUpdate::FastForward,
        },
    )
}

async fn publish(
    jobs: &Jobs,
    tenant: domain::TenantId,
    publish: &Publish<'_>,
    plan: &PullRequestPlan,
    row: Option<&db::repo::code_fix::PullRequestRow>,
) -> Result<(), Failure> {
    let update = ref_update(publish, plan, row).await?;
    let head = publish
        .repository
        .push(plan, publish.base_sha, &update)
        .await
        .map_err(|e| github_failure(&e))?;
    let pull = publish
        .repository
        .open_or_update_pull_request(plan, &publish.ctx.base)
        .await
        .map_err(|e| github_failure(&e))?;
    let check_run = report_check(publish, &head, row.and_then(|r| r.check_run_id)).await;

    let count = |n: usize| {
        i32::try_from(n).map_err(|_| failure(false, "plan_invalid", "a count is out of range"))
    };
    let number = i64::try_from(pull.number)
        .map_err(|_| failure(false, "github_error", "the pull request number is out of range"))?;
    let mut tx = jobs.db.tenant(tenant).await.map_err(|e| database(&e))?;
    let id = batches::upsert_pull_request(
        &mut tx,
        &NewPullRequest {
            repo_row: publish.ctx.repo.id,
            repo_id: publish.ctx.repo.repo_id,
            number,
            github_id: i64::try_from(pull.id).ok(),
            batch_id: publish.ctx.batch.batch_id.clone(),
            part: count(plan.part)?,
            head_branch: plan.head.as_str().to_owned(),
            base_branch: publish.ctx.base.as_str().to_owned(),
            head_sha: head.to_string(),
            pushed_sha: head.to_string(),
            html_url: pull.html_url.clone(),
            check_run_id: check_run,
            fix_count: count(plan.commits.len())?,
            files: count(plan.files)?,
            changed_lines: i32::try_from(plan.changed_lines).unwrap_or(i32::MAX),
        },
    )
    .await
    .map_err(|e| database(&e))?;
    let fixes: Vec<Uuid> = plan
        .commits
        .iter()
        .filter_map(|c| Uuid::parse_str(c.fix_id.as_str()).ok())
        .collect();
    batches::link_pull_request_fixes(&mut tx, id, &fixes)
        .await
        .map_err(|e| database(&e))?;
    record(
        &mut tx,
        "github.pull_request_opened",
        id,
        json!({"number": number, "part": plan.part, "fixes": fixes.len(), "files": plan.files}),
    )
    .await?;
    tx.commit().await.map_err(|e| database(&e))
}

/// The neutral "Rampsmith verification" check run: no preview theme is scanned here, and the
/// check says so. A check run that cannot be written does not undo the pull request.
async fn report_check(publish: &Publish<'_>, head: &Sha, existing: Option<i64>) -> Option<i64> {
    let details = Url::parse(&format!("{}/app/code-fixes", publish.origin)).ok()?;
    let run = verification_check_run(
        head.clone(),
        publish.batch_id,
        Verification::NoPreviewTheme,
        &details,
        OffsetDateTime::now_utc(),
    )
    .ok()?;
    let existing = existing
        .and_then(|id| u64::try_from(id).ok())
        .map(CheckRunId::new);
    match publish.repository.upsert_check_run(existing, &run).await {
        Ok(id) => i64::try_from(id.get()).ok(),
        Err(error) => {
            warn!(%error, "the check run was not written");
            existing.and_then(|id| i64::try_from(id.get()).ok())
        }
    }
}

/// Handles one `github.sync_pr@1` job: reads one pull request Rampsmith opened from the API
/// and records what it says. The webhook that queued this only announced a change (audit M1).
#[instrument(skip_all, fields(job = %job.lease.job_id), err(Debug))]
pub async fn sync_pr(jobs: &Jobs, job: ClaimedJob) -> Result<(), Failure> {
    let GithubSyncPullRequest { pull_request_row } = payload(&job, GithubSyncPullRequest::SCHEMA)?;
    let tenant = tenant_of(&job)?;
    let client = jobs.github(&job)?;
    let mut tx = jobs.db.tenant(tenant).await.map_err(|e| database(&e))?;
    let row = batches::pull_request(&mut tx, pull_request_row)
        .await
        .map_err(|e| database(&e))?;
    let repo = match &row {
        Some(row) => store::repo(&mut tx, row.repo_row)
            .await
            .map_err(|e| database(&e))?,
        None => None,
    };
    let live = store::live_installation(&mut tx)
        .await
        .map_err(|e| database(&e))?;
    tx.rollback().await.map_err(|e| database(&e))?;
    let (Some(row), Some(repo), Some(live)) = (row, repo, live) else {
        return Ok(());
    };
    let (Some((owner, name)), Ok(repo_id), Ok(installation), Ok(number)) = (
        repo.full_name.split_once('/'),
        u64::try_from(repo.repo_id),
        u64::try_from(live.installation_id),
        u64::try_from(row.number),
    ) else {
        return Err(invalid("the stored repository is invalid"));
    };
    let reference =
        RepoRef::new(owner, name).map_err(|_| invalid("the stored repository name is invalid"))?;
    let repository = client.repository(
        InstallationId::new(installation),
        reference,
        TokenScope::read_theme(RepositoryId::new(repo_id)),
    );
    let Some(pull) = repository
        .pull_request(number)
        .await
        .map_err(|e| github_failure(&e))?
    else {
        return Ok(());
    };
    // A pull request is Rampsmith's only by repository id and number (audit L8); the head must
    // still be the branch it opened too.
    if pull.base_repository.get() != repo_id || pull.head_ref != row.head_branch {
        warn!("a pull request no longer matches what Rampsmith opened; it is left alone");
        return Ok(());
    }
    let state = match (pull.merged, pull.open) {
        (true, _) => "merged",
        (false, true) => "open",
        (false, false) => "closed",
    };
    let mut tx = jobs.db.tenant(tenant).await.map_err(|e| database(&e))?;
    batches::record_pull_request_state(&mut tx, row.id, state, pull.head_sha.as_str())
        .await
        .map_err(|e| database(&e))?;
    record(
        &mut tx,
        "github.pull_request_synced",
        row.id,
        json!({"state": state, "edited": pull.head_sha.as_str() != row.pushed_sha}),
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
