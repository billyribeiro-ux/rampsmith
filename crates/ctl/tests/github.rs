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

use contracts::{GithubCheckRepository, GithubProcessEvent, GithubSyncInstallation};
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
        w.jobs = w.jobs.clone().with_github(fake.client());
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
