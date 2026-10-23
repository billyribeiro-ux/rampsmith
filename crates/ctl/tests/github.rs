//! The GitHub channel's jobs (ADR-290 to ADR-294) against PostgreSQL as the worker role and the
//! fake GitHub API that `crates/github`'s own tests use: the installation is believed from the
//! API and not from a webhook; deliveries are processed from the stored copy; the chosen
//! repository is checked for a Shopify theme.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use contracts::{
    GithubCheckRepository, GithubOpenPullRequest, GithubPlanBatch, GithubProcessEvent,
    GithubSyncInstallation, GithubSyncPullRequest,
};
use db::repo::github::{self as store, Linked, NewEvent, NewInstallation, RepoUpsert};
use domain::SiteId;
use queue::Failure;
use serde_json::{Value, json};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use uuid::Uuid;

mod support;

#[path = "../../github/tests/support/mod.rs"]
mod fake;

use fake::{Fake, INSTALLATION, Injected, REPO, REPO_ID};
use support::world::{World, world};

struct Setup {
    w: World,
    fake: Fake,
    installation_row: Uuid,
    repo_row: Uuid,
}

fn repo(id: u64, name: &str, push: Option<bool>) -> RepoUpsert {
    RepoUpsert {
        repo_id: i64::try_from(id).unwrap(),
        full_name: format!("{}/{name}", fake::OWNER),
        default_branch: "main".to_owned(),
        is_private: true,
        archived: false,
        user_can_push: push,
    }
}

/// A shop linked to the fake installation, with the theme repository chosen on `main`.
async fn setup(opts: PgPoolOptions, conn: PgConnectOptions, channel_on: bool) -> Setup {
    let mut w = world(opts, conn).await;
    let fake = Fake::start().await;
    fake::seed(&fake);
    if channel_on {
        w.jobs = w
            .jobs
            .clone()
            .with_github(fake.client())
            .with_app_origin("https://app.rampsmith.example");
    }
    let site = SiteId::from_uuid(w.site().await);
    let mut tx = w.db.tenant(w.session.tenant).await.unwrap();
    let Linked::Linked(installation_row) = store::link_installation(
        &mut tx,
        &NewInstallation {
            site,
            installation_id: i64::try_from(INSTALLATION).unwrap(),
            account_login: "old-name".to_owned(),
            account_type: "User".to_owned(),
            repository_selection: "selected".to_owned(),
            connected_by_ref: Some("shopify:1".to_owned()),
            connected_by_github: "octocat".to_owned(),
        },
    )
    .await
    .unwrap() else {
        panic!("link");
    };
    // The installer could push to the theme repository; a second repository is stale.
    store::sync_repos(
        &mut tx,
        installation_row,
        &[
            repo(REPO_ID, REPO, Some(true)),
            repo(999, "stale", Some(true)),
        ],
        true,
    )
    .await
    .unwrap();
    let repo_row = store::repo_by_github_id(&mut tx, i64::try_from(REPO_ID).unwrap())
        .await
        .unwrap()
        .unwrap()
        .id;
    store::select_repo(&mut tx, repo_row, "main").await.unwrap();
    tx.commit().await.unwrap();
    Setup {
        w,
        fake,
        installation_row,
        repo_row,
    }
}

async fn sync(s: &Setup) -> Result<(), Failure> {
    s.w.jobs
        .dispatch(s.w.job(
            GithubSyncInstallation::QUEUE,
            GithubSyncInstallation::SCHEMA,
            json!({"installation_row": s.installation_row}),
        ))
        .await
}

async fn check(s: &Setup) -> Result<(), Failure> {
    s.w.jobs
        .dispatch(s.w.job(
            GithubCheckRepository::QUEUE,
            GithubCheckRepository::SCHEMA,
            json!({"repo_row": s.repo_row}),
        ))
        .await
}

async fn deliver(s: &Setup, name: &str, installation: u64, body: Value) -> Uuid {
    let mut tx = s.w.db.tenant(s.w.session.tenant).await.unwrap();
    let mut digest = [0_u8; 32];
    digest[..16].copy_from_slice(Uuid::now_v7().as_bytes());
    let recorded = store::record_event(
        &mut tx,
        &NewEvent {
            delivery_id: Uuid::now_v7().to_string(),
            event: name.to_owned(),
            installation_id: i64::try_from(installation).unwrap(),
            repository_id: None,
            body,
            body_sha256: digest,
        },
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let store::Recorded::Stored(id) = recorded else {
        panic!("expected a new event");
    };
    id
}

async fn process(s: &Setup, event: Uuid) -> Result<(), Failure> {
    s.w.jobs
        .dispatch(s.w.job(
            GithubProcessEvent::QUEUE,
            GithubProcessEvent::SCHEMA,
            json!({"event_id": event}),
        ))
        .await
}

fn installation_event(installation: u64, action: &str) -> Value {
    json!({
        "action": action,
        "installation": {
            "id": installation,
            "account": {"login": fake::OWNER, "id": 9, "type": "User"},
            "repository_selection": "selected"
        },
        "sender": {"login": "octocat", "id": 9}
    })
}

async fn theme_state(s: &Setup) -> String {
    sqlx::query_scalar("select theme_state from github_repos where id = $1")
        .bind(s.repo_row)
        .fetch_one(&s.w.owner)
        .await
        .unwrap()
}

fn permanent(result: Result<(), Failure>) -> String {
    match result {
        Err(Failure::Permanent(e)) => e.code,
        other => panic!("expected a permanent failure, got {other:?}"),
    }
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn a_sync_believes_the_api_and_keeps_what_the_installer_could_push_to(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let s = setup(opts, conn, true).await;
    sync(&s).await.unwrap();
    let (login, read_at): (String, Option<time::OffsetDateTime>) =
        sqlx::query_as("select account_login, state_read_at from github_installations")
            .fetch_one(&s.w.owner)
            .await
            .unwrap();
    assert_eq!(login, fake::OWNER, "the account name comes from the API");
    assert!(read_at.is_some());
    // The theme repository is still available, still chosen, still pushable; the stale one is gone.
    let rows: Vec<(String, String, bool, bool)> = sqlx::query_as(
        "select full_name, status, selected, user_can_push from github_repos order by full_name",
    )
    .fetch_all(&s.w.owner)
    .await
    .unwrap();
    assert_eq!(
        rows,
        vec![
            (
                format!("{}/{REPO}", fake::OWNER),
                "available".to_owned(),
                true,
                true
            ),
            (
                format!("{}/stale", fake::OWNER),
                "removed".to_owned(),
                false,
                true
            ),
        ]
    );
    // The App's JWT was used and the installation token was narrowed to metadata.
    let requests = s.fake.requests();
    assert!(
        requests
            .iter()
            .any(|r| r.path == format!("/app/installations/{INSTALLATION}"))
    );
    assert_eq!(
        s.w.count("select count(*) from audit_log where action = 'github.installation_synced'")
            .await,
        1
    );
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn an_uninstalled_app_ends_the_link(opts: PgPoolOptions, conn: PgConnectOptions) {
    let s = setup(opts, conn, true).await;
    s.fake
        .inject(Injected::json(404, json!({"message": "Not Found"})));
    sync(&s).await.unwrap();
    let status: String = sqlx::query_scalar("select status from github_installations")
        .fetch_one(&s.w.owner)
        .await
        .unwrap();
    assert_eq!(status, "deleted");
    assert_eq!(
        s.w.count("select count(*) from github_repos where selected")
            .await,
        0
    );
    // A job that arrives after the link ended has nothing to do.
    sync(&s).await.unwrap();
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn a_transient_github_failure_is_retried_and_a_forbidden_one_is_not(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let s = setup(opts, conn, true).await;
    s.fake
        .inject(Injected::json(502, json!({"message": "Bad Gateway"})));
    assert!(matches!(sync(&s).await, Err(Failure::Retryable(_))));
    s.fake.inject(Injected::json(
        403,
        json!({"message": "Resource not accessible by integration"}),
    ));
    assert_eq!(permanent(sync(&s).await), "github_forbidden");
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn an_installation_event_queues_one_sync_for_the_stores_own_installation_only(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let s = setup(opts, conn, true).await;
    let event = deliver(
        &s,
        "installation",
        INSTALLATION,
        installation_event(INSTALLATION, "suspend"),
    )
    .await;
    process(&s, event).await.unwrap();
    assert_eq!(
        s.w.count("select count(*) from jobs where queue = 'github.sync_installation'")
            .await,
        1
    );
    // The body is never what changes state: only the API read does.
    let status: String = sqlx::query_scalar("select status from github_installations")
        .fetch_one(&s.w.owner)
        .await
        .unwrap();
    assert_eq!(status, "active");
    // Processing again is a no-op.
    process(&s, event).await.unwrap();
    assert_eq!(
        s.w.count("select count(*) from jobs where queue = 'github.sync_installation'")
            .await,
        1
    );
    // An event that names another installation is processed and queues nothing.
    let other = deliver(&s, "installation", 777, installation_event(777, "deleted")).await;
    process(&s, other).await.unwrap();
    assert_eq!(
        s.w.count("select count(*) from jobs where queue = 'github.sync_installation'")
            .await,
        1
    );
    assert_eq!(
        s.w.count("select count(*) from github_events where processed_at is not null")
            .await,
        2
    );
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn a_stored_event_that_does_not_parse_ends_permanently(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let s = setup(opts, conn, true).await;
    let event = deliver(
        &s,
        "installation",
        INSTALLATION,
        json!({"action": "created"}),
    )
    .await;
    assert_eq!(permanent(process(&s, event).await), "event_unreadable");
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn a_theme_branch_is_recognised_and_a_missing_branch_is_not(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let s = setup(opts, conn, true).await;
    assert_eq!(theme_state(&s).await, "unchecked");
    check(&s).await.unwrap();
    assert_eq!(theme_state(&s).await, "ok");
    // Choosing a branch that does not exist.
    sqlx::query("update github_repos set connected_branch = 'no-such-branch' where id = $1")
        .bind(s.repo_row)
        .execute(&s.w.owner)
        .await
        .unwrap();
    check(&s).await.unwrap();
    assert_eq!(theme_state(&s).await, "not_a_theme");
    let reason: Value = sqlx::query_scalar(
        "select data from audit_log where action = 'github.repository_checked' order by at desc limit 1",
    )
    .fetch_one(&s.w.owner)
    .await
    .unwrap();
    assert_eq!(reason["reason"], "branch_missing");
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn a_repository_the_app_cannot_read_is_marked_unreachable(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let s = setup(opts, conn, true).await;
    s.fake.inject(Injected::json(
        403,
        json!({"message": "Resource not accessible by integration"}),
    ));
    check(&s).await.unwrap();
    assert_eq!(theme_state(&s).await, "unreachable");
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn while_the_channel_is_off_its_jobs_end_and_its_events_are_dropped(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let s = setup(opts, conn, false).await;
    assert_eq!(permanent(sync(&s).await), "code_fix_channel_off");
    assert_eq!(permanent(check(&s).await), "code_fix_channel_off");
    let event = deliver(
        &s,
        "installation",
        INSTALLATION,
        installation_event(INSTALLATION, "deleted"),
    )
    .await;
    process(&s, event).await.unwrap();
    assert_eq!(
        s.w.count("select count(*) from github_events where processed_at is not null")
            .await,
        1
    );
    assert_eq!(
        s.w.count("select count(*) from jobs where queue like 'github.%'")
            .await,
        0
    );
    assert!(s.w.jobs.queues().iter().all(|q| !q.starts_with("github.")));
}

// ---------------------------------------------------------------------------------------------
// The code-fix pipeline (ADR-295 to ADR-299)

const FINDING: &str = "Links must have discernible text";

/// A batch in `status` over the chosen repository, based on `main`'s head.
async fn batch_in(s: &Setup, status: &str) -> (Uuid, String) {
    let head = s.fake.state().refs["main"].clone();
    let id = Uuid::now_v7();
    let batch_id = id.simple().to_string();
    sqlx::query(
        "insert into code_fix_batches
           (id, tenant_id, site_id, repo_row, batch_id, status, base_branch, base_sha, recipes)
         values ($1, $2, $3, $4, $5, $6, 'main', $7, 'core')",
    )
    .bind(id)
    .bind(s.w.session.tenant.as_uuid())
    .bind(s.w.site().await)
    .bind(s.repo_row)
    .bind(&batch_id)
    .bind(status)
    .bind(if status == "reading" {
        None
    } else {
        Some(head)
    })
    .execute(&s.w.owner)
    .await
    .unwrap();
    (id, batch_id)
}

/// What the engine stores for a batch: the source files and two fixes that both edit the header.
async fn stage_files(s: &Setup, batch: Uuid) {
    let tenant = s.w.session.tenant.as_uuid();
    let head = s.fake.state().refs["main"].clone();
    let blob = |path: &str| {
        let state = s.fake.state();
        let tree = &state.trees[&state.commits[&head].tree];
        tree[path].sha.clone()
    };
    for (path, ordinal, content) in [
        ("sections/header.liquid", 0, fake::HEADER),
        ("locales/en.default.json", 0, fake::LOCALE),
        ("sections/header.liquid", 1, fake::HEADER_FIXED),
        ("locales/en.default.json", 1, fake::LOCALE_FIXED),
        ("sections/header.liquid", 2, fake::HEADER_FIXED_2),
    ] {
        sqlx::query(
            "insert into code_fix_files (batch_row, tenant_id, path, ordinal, content, blob_sha)
             values ($1, $2, $3, $4, $5, $6)",
        )
        .bind(batch)
        .bind(tenant)
        .bind(path)
        .bind(ordinal)
        .bind(content)
        .bind((ordinal == 0).then(|| blob(path)))
        .execute(&s.w.owner)
        .await
        .unwrap();
    }
}

/// The two fixes, as the engine records them.
async fn stage_fixes(s: &Setup, batch: Uuid) -> [Uuid; 2] {
    let tenant = s.w.session.tenant.as_uuid();
    let ids = [Uuid::now_v7(), Uuid::now_v7()];
    for (i, id) in ids.iter().enumerate() {
        sqlx::query(
            "insert into fixes (id, tenant_id, site_id, kind, channel, status, origin)
             values ($1, $2, $3, 'code', 'github_pr', 'proposed', 'rule')",
        )
        .bind(id)
        .bind(tenant)
        .bind(s.w.site().await)
        .execute(&s.w.owner)
        .await
        .unwrap();
        sqlx::query(
            "insert into code_fix_batch_fixes
               (batch_row, tenant_id, fix_id, ordinal, rule_id, criterion, summary, finding)
             values ($1, $2, $3, $4, 'link-name', '2.4.4', 'add accessible name to cart link', $5)",
        )
        .bind(batch)
        .bind(tenant)
        .bind(id)
        .bind(i32::try_from(i + 1).unwrap())
        .bind(FINDING)
        .execute(&s.w.owner)
        .await
        .unwrap();
    }
    ids
}

async fn staged(s: &Setup, status: &str) -> (Uuid, String, [Uuid; 2]) {
    let (batch, batch_id) = batch_in(s, status).await;
    let fixes = stage_fixes(s, batch).await;
    stage_files(s, batch).await;
    (batch, batch_id, fixes)
}

async fn open_pr(s: &Setup, batch: Uuid) -> Result<(), Failure> {
    s.w.jobs
        .dispatch(s.w.job(
            GithubOpenPullRequest::QUEUE,
            GithubOpenPullRequest::SCHEMA,
            json!({"batch_row": batch}),
        ))
        .await
}

async fn status_of(s: &Setup, batch: Uuid) -> (String, Option<String>) {
    sqlx::query_as("select status, failure_code from code_fix_batches where id = $1")
        .bind(batch)
        .fetch_one(&s.w.owner)
        .await
        .unwrap()
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn reading_a_batch_stores_only_theme_source_and_hands_it_to_the_engine(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let s = setup(opts, conn, true).await;
    let (batch, _) = batch_in(&s, "reading").await;
    s.w.jobs
        .dispatch(s.w.job(
            GithubPlanBatch::QUEUE,
            GithubPlanBatch::SCHEMA,
            json!({"batch_row": batch}),
        ))
        .await
        .unwrap();
    let paths: Vec<String> = sqlx::query_scalar(
        "select path from code_fix_files where batch_row = $1 and ordinal = 0 order by path",
    )
    .bind(batch)
    .fetch_all(&s.w.owner)
    .await
    .unwrap();
    assert_eq!(
        paths,
        [
            "config/settings_data.json",
            "layout/theme.liquid",
            "locales/en.default.json",
            "sections/header.liquid",
            "templates/index.json"
        ],
        "theme source only: no README, no .env, no symlink"
    );
    let head = s.fake.state().refs["main"].clone();
    let (status, base): (String, Option<String>) =
        sqlx::query_as("select status, base_sha from code_fix_batches where id = $1")
            .bind(batch)
            .fetch_one(&s.w.owner)
            .await
            .unwrap();
    assert_eq!((status.as_str(), base), ("patching", Some(head)));
    assert_eq!(
        s.w.count("select count(*) from jobs where queue = 'code_fix.patch'")
            .await,
        1
    );
    // The token for reading was narrowed to contents read: nothing could be written.
    assert!(
        s.fake
            .requests()
            .iter()
            .all(|r| r.method == "GET" || r.path.ends_with("/access_tokens")),
        "reading the theme makes no write"
    );
    // A second attempt finds the batch past reading.
    s.w.jobs
        .dispatch(s.w.job(
            GithubPlanBatch::QUEUE,
            GithubPlanBatch::SCHEMA,
            json!({"batch_row": batch}),
        ))
        .await
        .unwrap();
    assert_eq!(
        s.w.count("select count(*) from jobs where queue = 'code_fix.patch'")
            .await,
        1
    );
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn a_batch_becomes_a_pull_request_on_a_fix_branch_and_never_touches_the_connected_one(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let s = setup(opts, conn, true).await;
    let (batch, batch_id, fixes) = staged(&s, "ready").await;
    let base = s.fake.state().refs["main"].clone();
    open_pr(&s, batch).await.unwrap();

    let requests = s.fake.requests();
    let head = {
        let state = s.fake.state();
        assert_eq!(
            state.refs["main"], base,
            "the connected branch is untouched"
        );
        let branch = format!("rampsmith/fix-{batch_id}");
        let head = state.refs[&branch].clone();
        // One commit per fix, on the base, with the files the engine stored.
        let second = &state.commits[&head];
        let first = &state.commits[&second.parents[0]];
        assert_eq!(first.parents, std::slice::from_ref(&base));
        let files = state.files_at(&head);
        assert_eq!(files["sections/header.liquid"], fake::HEADER_FIXED_2);
        assert_eq!(files["locales/en.default.json"], fake::LOCALE_FIXED);
        assert_eq!(
            files["README.md"], "# theme\n",
            "other files are as they were"
        );
        // No finding text in any commit message (audit M2); the fix id is the trailer.
        for commit in [first, second] {
            assert!(!commit.message.contains(FINDING), "{}", commit.message);
            assert!(
                commit.message.contains("Rampsmith-Fix: "),
                "{}",
                commit.message
            );
        }
        // The pull request: head is the fix branch, base the connected one, finding in a code span.
        assert_eq!(state.pulls.len(), 1);
        let pull = &state.pulls[0];
        assert_eq!(
            (pull.head.as_str(), pull.base.as_str()),
            (branch.as_str(), "main")
        );
        assert!(pull.body.contains(&format!("`{FINDING}`")), "{}", pull.body);
        assert!(pull.body.contains("2.4.4"));
        assert!(pull.body.contains(&format!(
            "https://app.rampsmith.example/app/fixes/{}",
            fixes[0]
        )));
        // The neutral verification check run.
        assert_eq!(state.check_runs.len(), 1);
        assert_eq!(state.check_runs[0].1["conclusion"], "neutral");
        // Nothing was merged or deleted: the only writes are blobs, trees, commits, a ref, a pull
        // request and a check run.
        assert!(
            requests
                .iter()
                .all(|r| r.method != "DELETE" && !r.path.ends_with("/merge")),
        );
        head
    };

    let (state_name, number, pushed, fix_count): (String, i64, String, i32) =
        sqlx::query_as("select state, number, pushed_sha, fix_count from github_pull_requests")
            .fetch_one(&s.w.owner)
            .await
            .unwrap();
    assert_eq!(
        (state_name.as_str(), number, pushed, fix_count),
        ("open", 1, head, 2)
    );
    assert_eq!(
        s.w.count("select count(*) from github_pr_fixes").await,
        2,
        "both fixes are linked to the pull request"
    );
    assert_eq!(status_of(&s, batch).await, ("opened".to_owned(), None));
    assert_eq!(
        s.w.count("select count(*) from code_fix_files").await,
        0,
        "the merchant's source is not kept once the pull request is open"
    );
    let _ = fixes;
    // A repeat of the job finds nothing to do.
    open_pr(&s, batch).await.unwrap();
    assert_eq!(s.fake.state().pulls.len(), 1);
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn a_branch_that_already_exists_is_not_overwritten_on_the_first_attempt(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let s = setup(opts, conn, true).await;
    let (batch, batch_id, _) = staged(&s, "ready").await;
    let branch = format!("rampsmith/fix-{batch_id}");
    let theirs = {
        let mut state = s.fake.state();
        let main = state.refs["main"].clone();
        let tree = state.commits[&main].tree.clone();
        let theirs = state.add_commit(&tree, vec![main], "someone's own commit");
        state.refs.insert(branch.clone(), theirs.clone());
        theirs
    };
    let code = permanent(open_pr(&s, batch).await);
    assert!(code.starts_with("github_"), "{code}");
    assert_eq!(
        s.fake.state().refs[&branch],
        theirs,
        "their branch is as it was"
    );
    let (status, failure) = status_of(&s, batch).await;
    assert_eq!(status, "failed");
    assert_eq!(failure.as_deref(), Some(code.as_str()));
    assert_eq!(
        s.w.count("select count(*) from code_fix_files").await,
        0,
        "a failed batch keeps no source"
    );
    assert_eq!(
        s.w.count("select count(*) from github_pull_requests").await,
        0
    );
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn a_branch_a_person_added_commits_to_is_left_alone(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let s = setup(opts, conn, true).await;
    let (batch, batch_id, _) = staged(&s, "ready").await;
    open_pr(&s, batch).await.unwrap();
    let branch = format!("rampsmith/fix-{batch_id}");
    // A developer fixes up the branch; then the job runs again for the same batch.
    let theirs = {
        let mut state = s.fake.state();
        let head = state.refs[&branch].clone();
        let tree = state.commits[&head].tree.clone();
        let theirs = state.add_commit(&tree, vec![head], "developer fix-up");
        state.refs.insert(branch.clone(), theirs.clone());
        theirs
    };
    sqlx::query("update code_fix_batches set status = 'opening' where id = $1")
        .bind(batch)
        .execute(&s.w.owner)
        .await
        .unwrap();
    stage_files(&s, batch).await;
    assert_eq!(permanent(open_pr(&s, batch).await), "branch_moved");
    assert_eq!(
        s.fake.state().refs[&branch],
        theirs,
        "nothing was overwritten"
    );
    assert_eq!(status_of(&s, batch).await.0, "failed");
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn a_crash_after_the_push_is_resumed_without_losing_the_branch(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let s = setup(opts, conn, true).await;
    let (batch, batch_id, _) = staged(&s, "opening").await;
    let branch = format!("rampsmith/fix-{batch_id}");
    // The first attempt pushed and then died before recording: a branch, no row.
    let pushed = {
        let mut state = s.fake.state();
        let main = state.refs["main"].clone();
        let tree = state.commits[&main].tree.clone();
        let pushed = state.add_commit(&tree, vec![main], "pushed before the crash");
        state.refs.insert(branch.clone(), pushed.clone());
        pushed
    };
    open_pr(&s, batch).await.unwrap();
    {
        let state = s.fake.state();
        assert_ne!(state.refs[&branch], pushed, "the resumed push replaced it");
        assert_eq!(state.pulls.len(), 1);
    }
    assert_eq!(status_of(&s, batch).await.0, "opened");
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn a_final_failure_ends_the_batch_so_the_next_one_can_start(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let s = setup(opts, conn, true).await;
    // No fixes were stored: the batch cannot be opened.
    let (batch, _) = batch_in(&s, "ready").await;
    assert_eq!(permanent(open_pr(&s, batch).await), "files_missing");
    assert_eq!(status_of(&s, batch).await.0, "failed");
    let (next, _) = batch_in(&s, "reading").await;
    assert_eq!(status_of(&s, next).await.0, "reading");
}

async fn sync_pr(s: &Setup, row: Uuid) -> Result<(), Failure> {
    s.w.jobs
        .dispatch(s.w.job(
            GithubSyncPullRequest::QUEUE,
            GithubSyncPullRequest::SCHEMA,
            json!({"pull_request_row": row}),
        ))
        .await
}

fn pull_event(number: u64, repo: u64) -> Value {
    let sha = "a".repeat(40);
    json!({
        "action": "closed", "number": number,
        "pull_request": {
            "id": 1, "number": number, "state": "closed", "merged": true,
            "head": {"ref": "rampsmith/fix-x", "sha": sha},
            "base": {"ref": "main", "sha": sha}
        },
        "repository": {"id": repo, "full_name": format!("{}/{REPO}", fake::OWNER)},
        "installation": {"id": INSTALLATION}
    })
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn a_merge_is_read_from_the_api_and_marks_the_fixes_applied(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let s = setup(opts, conn, true).await;
    let (batch, _, _) = staged(&s, "ready").await;
    open_pr(&s, batch).await.unwrap();
    let row: Uuid = sqlx::query_scalar("select id from github_pull_requests")
        .fetch_one(&s.w.owner)
        .await
        .unwrap();

    // An event for a pull request that is not ours queues nothing; ours queues one read.
    let stranger = deliver(&s, "pull_request", INSTALLATION, pull_event(99, REPO_ID)).await;
    process(&s, stranger).await.unwrap();
    let other_repo = deliver(&s, "pull_request", INSTALLATION, pull_event(1, 31_337)).await;
    process(&s, other_repo).await.unwrap();
    assert_eq!(
        s.w.count("select count(*) from jobs where queue = 'github.sync_pr'")
            .await,
        0,
        "a pull request is matched by repository id and number"
    );
    let ours = deliver(&s, "pull_request", INSTALLATION, pull_event(1, REPO_ID)).await;
    process(&s, ours).await.unwrap();
    assert_eq!(
        s.w.count("select count(*) from jobs where queue = 'github.sync_pr'")
            .await,
        1
    );

    // The webhook said "merged"; the API has not, so nothing changes.
    sync_pr(&s, row).await.unwrap();
    let state: String = sqlx::query_scalar("select state from github_pull_requests")
        .fetch_one(&s.w.owner)
        .await
        .unwrap();
    assert_eq!(state, "open", "the API is believed, not the webhook");

    s.fake.state().pulls[0].merged = true;
    sync_pr(&s, row).await.unwrap();
    let state: String = sqlx::query_scalar("select state from github_pull_requests")
        .fetch_one(&s.w.owner)
        .await
        .unwrap();
    assert_eq!(state, "merged");
    assert_eq!(
        s.w.count("select count(*) from fixes where status = 'applied'")
            .await,
        2
    );

    // Closing without merging marks them rejected.
    {
        let mut fake = s.fake.state();
        fake.pulls[0].merged = false;
        fake.pulls[0].closed = true;
    }
    sync_pr(&s, row).await.unwrap();
    assert_eq!(
        s.w.count("select count(*) from fixes where status = 'rejected'")
            .await,
        2
    );
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn a_push_to_the_connected_branch_queues_a_read_of_the_open_pull_requests(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let s = setup(opts, conn, true).await;
    let (batch, _, _) = staged(&s, "ready").await;
    open_pr(&s, batch).await.unwrap();
    let push = |reference: &str| {
        json!({
            "ref": reference, "before": "a".repeat(40), "after": "b".repeat(40),
            "created": false, "deleted": false, "forced": false,
            "repository": {"id": REPO_ID, "full_name": format!("{}/{REPO}", fake::OWNER)},
            "installation": {"id": INSTALLATION}, "commits": []
        })
    };
    let unrelated = deliver(&s, "push", INSTALLATION, push("refs/heads/feature")).await;
    process(&s, unrelated).await.unwrap();
    assert_eq!(
        s.w.count("select count(*) from jobs where queue = 'github.sync_pr'")
            .await,
        0
    );
    let to_main = deliver(&s, "push", INSTALLATION, push("refs/heads/main")).await;
    process(&s, to_main).await.unwrap();
    assert_eq!(
        s.w.count("select count(*) from jobs where queue = 'github.sync_pr'")
            .await,
        1
    );
}
