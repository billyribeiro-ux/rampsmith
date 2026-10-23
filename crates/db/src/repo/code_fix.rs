//! The code-fix pipeline's rows: batches, the theme files held for them, the fixes they hold,
//! and the pull requests Rampsmith opened (PLAN §12 and §15, ADR-295 to ADR-299).
//!
//! Everything is scoped to the transaction's tenant, in SQL and by row-level security.

use serde_json::Value;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::{DbError, TenantTx};

/// A request for pull requests against the store's theme repository.
#[derive(Debug, Clone, PartialEq)]
pub struct NewBatch {
    /// The store's site.
    pub site: Uuid,
    /// The chosen repository.
    pub repo_row: Uuid,
    /// Names the head branch (`rampsmith/fix-<batch_id>`).
    pub batch_id: String,
    /// The connected branch the pull request targets.
    pub base_branch: String,
    /// Who asked (`shopify:<sub>`).
    pub requested_by: Option<String>,
    /// `core` or `every`: the recipes the plan includes.
    pub recipes: String,
    /// What the person brought for findings that need judgement.
    pub judgements: Value,
}

/// What creating a batch did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Created {
    /// The batch exists, waiting for `ctl` to read the files.
    New(Uuid),
    /// The store already has a batch in flight (one at a time), or the id is taken.
    InFlight,
}

/// A batch.
#[derive(Debug, Clone, PartialEq)]
pub struct BatchRow {
    /// The row.
    pub id: Uuid,
    /// The site.
    pub site_id: Uuid,
    /// The repository.
    pub repo_row: Uuid,
    /// Names the head branch.
    pub batch_id: String,
    /// `reading`, `patching`, `ready`, `opening`, `opened`, `nothing_to_fix` or `failed`.
    pub status: String,
    /// The branch the pull request targets.
    pub base_branch: String,
    /// The branch's head when the files were read.
    pub base_sha: Option<String>,
    /// Who asked.
    pub requested_by: Option<String>,
    /// `core` or `every`.
    pub recipes: String,
    /// What the person brought for findings that need judgement.
    pub judgements: Value,
    /// Counts and, for each finding not fixed, a code.
    pub outcome: Option<Value>,
    /// Why the batch ended without a pull request.
    pub failure_code: Option<String>,
    /// When it was requested.
    pub created_at: OffsetDateTime,
    /// When it last changed.
    pub updated_at: OffsetDateTime,
}

macro_rules! batch_row {
    ($r:expr) => {{
        let r = $r;
        BatchRow {
            id: r.id,
            site_id: r.site_id,
            repo_row: r.repo_row,
            batch_id: r.batch_id,
            status: r.status,
            base_branch: r.base_branch,
            base_sha: r.base_sha,
            requested_by: r.requested_by,
            recipes: r.recipes,
            judgements: r.judgements,
            outcome: r.outcome,
            failure_code: r.failure_code,
            created_at: r.created_at,
            updated_at: r.updated_at,
        }
    }};
}

/// Records a request. At most one batch per store is in flight.
pub async fn create_batch(tx: &mut TenantTx, new: &NewBatch) -> Result<Created, DbError> {
    let tenant = tx.tenant_uuid();
    let id = Uuid::now_v7();
    let inserted = sqlx::query_scalar!(
        "insert into code_fix_batches
           (id, tenant_id, site_id, repo_row, batch_id, status, base_branch, requested_by,
            recipes, judgements)
         values ($1, $2, $3, $4, $5, 'reading', $6, $7, $8, $9)
         on conflict do nothing
         returning id",
        id,
        tenant,
        new.site,
        new.repo_row,
        new.batch_id,
        new.base_branch,
        new.requested_by,
        new.recipes,
        new.judgements
    )
    .fetch_optional(tx.conn())
    .await?;
    Ok(inserted.map_or(Created::InFlight, Created::New))
}

/// One batch.
pub async fn batch(tx: &mut TenantTx, id: Uuid) -> Result<Option<BatchRow>, DbError> {
    let tenant = tx.tenant_uuid();
    Ok(sqlx::query!(
        "select id, site_id, repo_row, batch_id, status, base_branch, base_sha, requested_by,
                recipes, judgements, outcome, failure_code, created_at, updated_at
           from code_fix_batches where tenant_id = $1 and id = $2",
        tenant,
        id
    )
    .fetch_optional(tx.conn())
    .await?
    .map(|r| batch_row!(r)))
}

/// Locks one batch for the rest of the transaction.
pub async fn batch_for_update(tx: &mut TenantTx, id: Uuid) -> Result<Option<BatchRow>, DbError> {
    let tenant = tx.tenant_uuid();
    Ok(sqlx::query!(
        "select id, site_id, repo_row, batch_id, status, base_branch, base_sha, requested_by,
                recipes, judgements, outcome, failure_code, created_at, updated_at
           from code_fix_batches where tenant_id = $1 and id = $2
            for update",
        tenant,
        id
    )
    .fetch_optional(tx.conn())
    .await?
    .map(|r| batch_row!(r)))
}

/// The store's most recent batches, newest first.
pub async fn recent_batches(tx: &mut TenantTx, limit: i64) -> Result<Vec<BatchRow>, DbError> {
    let tenant = tx.tenant_uuid();
    Ok(sqlx::query!(
        "select id, site_id, repo_row, batch_id, status, base_branch, base_sha, requested_by,
                recipes, judgements, outcome, failure_code, created_at, updated_at
           from code_fix_batches where tenant_id = $1
          order by created_at desc limit $2",
        tenant,
        limit
    )
    .fetch_all(tx.conn())
    .await?
    .into_iter()
    .map(|r| batch_row!(r))
    .collect())
}

/// Stores one theme file as read from the repository.
pub async fn add_source_file(
    tx: &mut TenantTx,
    batch: Uuid,
    path: &str,
    content: &str,
    blob_sha: &str,
) -> Result<(), DbError> {
    let tenant = tx.tenant_uuid();
    sqlx::query!(
        "insert into code_fix_files (batch_row, tenant_id, path, ordinal, content, blob_sha)
         values ($1, $2, $3, 0, $4, $5)
         on conflict (batch_row, path, ordinal) do nothing",
        batch,
        tenant,
        path,
        content,
        blob_sha
    )
    .execute(tx.conn())
    .await?;
    Ok(())
}

/// The files are read: the batch waits for the engine, on `base_sha`. Only a batch still
/// `reading` moves; returns whether it did.
pub async fn files_read(tx: &mut TenantTx, id: Uuid, base_sha: &str) -> Result<bool, DbError> {
    let tenant = tx.tenant_uuid();
    Ok(sqlx::query!(
        "update code_fix_batches
            set status = 'patching', base_sha = $3, updated_at = now()
          where tenant_id = $1 and id = $2 and status = 'reading'",
        tenant,
        id,
        base_sha
    )
    .execute(tx.conn())
    .await?
    .rows_affected()
        == 1)
}

/// Moves a batch from `from` to `to`; returns whether it was in `from`.
pub async fn move_batch(
    tx: &mut TenantTx,
    id: Uuid,
    from: &str,
    to: &str,
) -> Result<bool, DbError> {
    let tenant = tx.tenant_uuid();
    Ok(sqlx::query!(
        "update code_fix_batches set status = $4, updated_at = now()
          where tenant_id = $1 and id = $2 and status = $3",
        tenant,
        id,
        from,
        to
    )
    .execute(tx.conn())
    .await?
    .rows_affected()
        == 1)
}

/// Ends a batch without a pull request (or, for `opened`, with every one opened) and drops the
/// theme files held for it. Idempotent.
pub async fn finish_batch(
    tx: &mut TenantTx,
    id: Uuid,
    status: &str,
    failure_code: Option<&str>,
) -> Result<(), DbError> {
    let tenant = tx.tenant_uuid();
    sqlx::query!(
        "delete from code_fix_files where tenant_id = $1 and batch_row = $2",
        tenant,
        id
    )
    .execute(tx.conn())
    .await?;
    sqlx::query!(
        "update code_fix_batches set status = $3, failure_code = $4, updated_at = now()
          where tenant_id = $1 and id = $2",
        tenant,
        id,
        status,
        failure_code
    )
    .execute(tx.conn())
    .await?;
    Ok(())
}

/// A fix of a batch, in commit order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BatchFix {
    /// The `fixes` row.
    pub fix_id: Uuid,
    /// 1-based commit order.
    pub ordinal: i32,
    /// The axe-core rule.
    pub rule_id: String,
    /// The WCAG 2.2 success criterion.
    pub criterion: String,
    /// Rampsmith's one-line summary (the commit subject).
    pub summary: String,
    /// Rampsmith's one-line statement of the finding.
    pub finding: String,
}

/// The fixes of a batch, in commit order.
pub async fn batch_fixes(tx: &mut TenantTx, batch: Uuid) -> Result<Vec<BatchFix>, DbError> {
    let tenant = tx.tenant_uuid();
    Ok(sqlx::query_as!(
        BatchFix,
        "select fix_id, ordinal, rule_id, criterion, summary, finding
           from code_fix_batch_fixes where tenant_id = $1 and batch_row = $2
          order by ordinal",
        tenant,
        batch
    )
    .fetch_all(tx.conn())
    .await?)
}

/// A theme file of a batch: ordinal 0 is the source, N the file after the Nth fix.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BatchFile {
    /// Theme-relative path.
    pub path: String,
    /// 0 for the source.
    pub ordinal: i32,
    /// The contents.
    pub content: String,
}

/// Every stored file of a batch, by path then ordinal.
pub async fn batch_files(tx: &mut TenantTx, batch: Uuid) -> Result<Vec<BatchFile>, DbError> {
    let tenant = tx.tenant_uuid();
    Ok(sqlx::query_as!(
        BatchFile,
        "select path, ordinal, content from code_fix_files
          where tenant_id = $1 and batch_row = $2
          order by path, ordinal",
        tenant,
        batch
    )
    .fetch_all(tx.conn())
    .await?)
}

/// A pull request to record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewPullRequest {
    /// The repository row.
    pub repo_row: Uuid,
    /// GitHub's repository id (audit L8).
    pub repo_id: i64,
    /// The number within the repository.
    pub number: i64,
    /// GitHub's global id.
    pub github_id: Option<i64>,
    /// The batch.
    pub batch_id: String,
    /// 1-based part of a split batch.
    pub part: i32,
    /// `rampsmith/fix-<batch>`.
    pub head_branch: String,
    /// The connected branch.
    pub base_branch: String,
    /// The head GitHub reports.
    pub head_sha: String,
    /// The head Rampsmith itself last pushed (audit L3).
    pub pushed_sha: String,
    /// The pull request's page.
    pub html_url: String,
    /// The check run, when one was created.
    pub check_run_id: Option<i64>,
    /// Fixes in it.
    pub fix_count: i32,
    /// Files it changes.
    pub files: i32,
    /// Lines it changes.
    pub changed_lines: i32,
}

/// A recorded pull request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullRequestRow {
    /// The row.
    pub id: Uuid,
    /// The repository row.
    pub repo_row: Uuid,
    /// GitHub's repository id.
    pub repo_id: i64,
    /// The number.
    pub number: i64,
    /// The batch.
    pub batch_id: String,
    /// The part.
    pub part: i32,
    /// The head branch.
    pub head_branch: String,
    /// The base branch.
    pub base_branch: String,
    /// The head GitHub reports.
    pub head_sha: String,
    /// The head Rampsmith last pushed.
    pub pushed_sha: String,
    /// `open`, `closed` or `merged`.
    pub state: String,
    /// The page.
    pub html_url: String,
    /// The check run.
    pub check_run_id: Option<i64>,
    /// Fixes in it.
    pub fix_count: i32,
    /// Files it changes.
    pub files: i32,
    /// Lines it changes.
    pub changed_lines: i32,
    /// When it was opened.
    pub opened_at: OffsetDateTime,
    /// When it last changed.
    pub updated_at: OffsetDateTime,
    /// When it closed or merged.
    pub closed_at: Option<OffsetDateTime>,
}

macro_rules! pr_row {
    ($r:expr) => {{
        let r = $r;
        PullRequestRow {
            id: r.id,
            repo_row: r.repo_row,
            repo_id: r.repo_id,
            number: r.number,
            batch_id: r.batch_id,
            part: r.part,
            head_branch: r.head_branch,
            base_branch: r.base_branch,
            head_sha: r.head_sha,
            pushed_sha: r.pushed_sha,
            state: r.state,
            html_url: r.html_url,
            check_run_id: r.check_run_id,
            fix_count: r.fix_count,
            files: r.files,
            changed_lines: r.changed_lines,
            opened_at: r.opened_at,
            updated_at: r.updated_at,
            closed_at: r.closed_at,
        }
    }};
}

/// Records a pull request, or, for a batch part already recorded, its new head and counts (a
/// re-run of the open job after a crash, or a re-derive). Returns the row.
pub async fn upsert_pull_request(tx: &mut TenantTx, new: &NewPullRequest) -> Result<Uuid, DbError> {
    let tenant = tx.tenant_uuid();
    Ok(sqlx::query_scalar!(
        "insert into github_pull_requests
           (id, tenant_id, repo_row, repo_id, number, github_id, batch_id, part, head_branch,
            base_branch, head_sha, pushed_sha, state, html_url, check_run_id, fix_count, files,
            changed_lines)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'open', $13, $14, $15, $16,
                 $17)
         on conflict (tenant_id, batch_id, part) do update
            set head_sha = excluded.head_sha, pushed_sha = excluded.pushed_sha,
                html_url = excluded.html_url, check_run_id = coalesce(excluded.check_run_id,
                                                      github_pull_requests.check_run_id),
                fix_count = excluded.fix_count, files = excluded.files,
                changed_lines = excluded.changed_lines, updated_at = now()
         returning id",
        Uuid::now_v7(),
        tenant,
        new.repo_row,
        new.repo_id,
        new.number,
        new.github_id,
        new.batch_id,
        new.part,
        new.head_branch,
        new.base_branch,
        new.head_sha,
        new.pushed_sha,
        new.html_url,
        new.check_run_id,
        new.fix_count,
        new.files,
        new.changed_lines
    )
    .fetch_one(tx.conn())
    .await?)
}

/// Links a pull request to the fixes in it.
pub async fn link_pull_request_fixes(
    tx: &mut TenantTx,
    pull_request: Uuid,
    fixes: &[Uuid],
) -> Result<(), DbError> {
    let tenant = tx.tenant_uuid();
    sqlx::query!(
        "insert into github_pr_fixes (pull_request_id, fix_id, tenant_id)
         select $2, f, $1 from unnest($3::uuid[]) as f
         on conflict do nothing",
        tenant,
        pull_request,
        fixes
    )
    .execute(tx.conn())
    .await?;
    Ok(())
}

/// One pull request by row id.
pub async fn pull_request(tx: &mut TenantTx, id: Uuid) -> Result<Option<PullRequestRow>, DbError> {
    let tenant = tx.tenant_uuid();
    Ok(sqlx::query!(
        "select id, repo_row, repo_id, number, batch_id, part, head_branch, base_branch, head_sha,
                pushed_sha, state, html_url, check_run_id, fix_count, files, changed_lines,
                opened_at, updated_at, closed_at
           from github_pull_requests where tenant_id = $1 and id = $2",
        tenant,
        id
    )
    .fetch_optional(tx.conn())
    .await?
    .map(|r| pr_row!(r)))
}

/// One pull request by GitHub's repository id and number: how an event is matched to the pull
/// requests Rampsmith opened (audit L8). A name or a head branch is never used.
pub async fn pull_request_by_number(
    tx: &mut TenantTx,
    repo_id: i64,
    number: i64,
) -> Result<Option<PullRequestRow>, DbError> {
    let tenant = tx.tenant_uuid();
    Ok(sqlx::query!(
        "select id, repo_row, repo_id, number, batch_id, part, head_branch, base_branch, head_sha,
                pushed_sha, state, html_url, check_run_id, fix_count, files, changed_lines,
                opened_at, updated_at, closed_at
           from github_pull_requests
          where tenant_id = $1 and repo_id = $2 and number = $3",
        tenant,
        repo_id,
        number
    )
    .fetch_optional(tx.conn())
    .await?
    .map(|r| pr_row!(r)))
}

/// The pull requests already recorded for a batch (a re-run of the open job finds its parts).
pub async fn pull_requests_of_batch(
    tx: &mut TenantTx,
    batch_id: &str,
) -> Result<Vec<PullRequestRow>, DbError> {
    let tenant = tx.tenant_uuid();
    Ok(sqlx::query!(
        "select id, repo_row, repo_id, number, batch_id, part, head_branch, base_branch, head_sha,
                pushed_sha, state, html_url, check_run_id, fix_count, files, changed_lines,
                opened_at, updated_at, closed_at
           from github_pull_requests where tenant_id = $1 and batch_id = $2
          order by part",
        tenant,
        batch_id
    )
    .fetch_all(tx.conn())
    .await?
    .into_iter()
    .map(|r| pr_row!(r))
    .collect())
}

/// The open pull requests of a repository, by GitHub's repository id.
pub async fn open_pull_requests(
    tx: &mut TenantTx,
    repo_id: i64,
) -> Result<Vec<PullRequestRow>, DbError> {
    let tenant = tx.tenant_uuid();
    Ok(sqlx::query!(
        "select id, repo_row, repo_id, number, batch_id, part, head_branch, base_branch, head_sha,
                pushed_sha, state, html_url, check_run_id, fix_count, files, changed_lines,
                opened_at, updated_at, closed_at
           from github_pull_requests
          where tenant_id = $1 and repo_id = $2 and state = 'open'
          order by number",
        tenant,
        repo_id
    )
    .fetch_all(tx.conn())
    .await?
    .into_iter()
    .map(|r| pr_row!(r))
    .collect())
}

/// The store's pull requests, newest first.
pub async fn recent_pull_requests(
    tx: &mut TenantTx,
    limit: i64,
) -> Result<Vec<PullRequestRow>, DbError> {
    let tenant = tx.tenant_uuid();
    Ok(sqlx::query!(
        "select id, repo_row, repo_id, number, batch_id, part, head_branch, base_branch, head_sha,
                pushed_sha, state, html_url, check_run_id, fix_count, files, changed_lines,
                opened_at, updated_at, closed_at
           from github_pull_requests where tenant_id = $1
          order by opened_at desc, number desc limit $2",
        tenant,
        limit
    )
    .fetch_all(tx.conn())
    .await?
    .into_iter()
    .map(|r| pr_row!(r))
    .collect())
}

/// Records what the API says about a pull request: its state, and the head it has now. A merge
/// marks its fixes `applied`; closing without merging marks them `rejected`; reopening puts them
/// back to `proposed`.
pub async fn record_pull_request_state(
    tx: &mut TenantTx,
    id: Uuid,
    state: &str,
    head_sha: &str,
) -> Result<(), DbError> {
    let tenant = tx.tenant_uuid();
    sqlx::query!(
        "update github_pull_requests
            set state = $3, head_sha = $4, updated_at = now(),
                closed_at = case when $3 = 'open' then null else coalesce(closed_at, now()) end
          where tenant_id = $1 and id = $2",
        tenant,
        id,
        state,
        head_sha
    )
    .execute(tx.conn())
    .await?;
    let fix_status = match state {
        "merged" => "applied",
        "closed" => "rejected",
        _ => "proposed",
    };
    // Only fixes Rampsmith itself proposed move; one a person already moved on stays.
    sqlx::query!(
        "update fixes set status = $3
          where tenant_id = $1 and channel = 'github_pr'
            and status in ('proposed', 'applied', 'rejected')
            and id in (select fix_id from github_pr_fixes
                        where tenant_id = $1 and pull_request_id = $2)",
        tenant,
        id,
        fix_status
    )
    .execute(tx.conn())
    .await?;
    Ok(())
}

/// Records the head Rampsmith itself pushed (a re-derive), which is also the head GitHub now
/// reports.
pub async fn record_pushed_head(
    tx: &mut TenantTx,
    id: Uuid,
    sha: &str,
    fix_count: i32,
    files: i32,
    changed_lines: i32,
) -> Result<(), DbError> {
    let tenant = tx.tenant_uuid();
    sqlx::query!(
        "update github_pull_requests
            set head_sha = $3, pushed_sha = $3, fix_count = $4, files = $5, changed_lines = $6,
                updated_at = now()
          where tenant_id = $1 and id = $2",
        tenant,
        id,
        sha,
        fix_count,
        files,
        changed_lines
    )
    .execute(tx.conn())
    .await?;
    Ok(())
}

/// The finding ids of a batch's fixes, for re-deriving a pull request on a new base.
pub async fn pull_request_fix_ids(
    tx: &mut TenantTx,
    pull_request: Uuid,
) -> Result<Vec<Uuid>, DbError> {
    let tenant = tx.tenant_uuid();
    Ok(sqlx::query_scalar!(
        "select fix_id from github_pr_fixes where tenant_id = $1 and pull_request_id = $2
          order by fix_id",
        tenant,
        pull_request
    )
    .fetch_all(tx.conn())
    .await?)
}
