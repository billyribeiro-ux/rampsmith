//! The GitHub channel's repositories and lookups (ADR-290 to ADR-294): the install state is
//! single-use, expiring and bound to its tenant; one installation belongs to one store; a
//! repository the installer could not push to cannot be chosen; a replayed body is recognised.

// Integration tests are test code: PLAN §8 denies these lints outside tests only.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod support;

use db::Db;
use db::repo::code_fix;
use db::repo::github::{
    self, Linked, NewEvent, NewInstallation, Recorded, RepoUpsert, SelectOutcome,
};
use sqlx::PgPool;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use support::{Graph, app_pool, owner_pool, seed};

async fn two_stores(opts: PgPoolOptions, conn: PgConnectOptions) -> (Db, PgPool, Graph, Graph) {
    let owner = owner_pool(opts.clone(), conn.clone()).await;
    let db = Db::from_pool(app_pool(opts, conn).await);
    let a = seed(&db, 1).await;
    let b = seed(&db, 2).await;
    (db, owner, a, b)
}

fn installation(graph: Graph, id: i64) -> NewInstallation {
    NewInstallation {
        site: graph.site,
        installation_id: id,
        account_login: "octo".to_owned(),
        account_type: "User".to_owned(),
        repository_selection: "selected".to_owned(),
        connected_by_ref: Some("shopify:42".to_owned()),
        connected_by_github: "octocat".to_owned(),
    }
}

fn repo(id: i64, name: &str, push: Option<bool>) -> RepoUpsert {
    RepoUpsert {
        repo_id: id,
        full_name: format!("octo/{name}"),
        default_branch: "main".to_owned(),
        is_private: true,
        archived: false,
        user_can_push: push,
    }
}

#[sqlx::test]
async fn an_install_state_works_once_for_the_store_it_was_issued_to(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let (db, _, a, b) = two_stores(opts, conn).await;
    let state = [7_u8; 32];
    let mut tx = db.tenant(a.tenant).await.unwrap();
    github::create_install_state(&mut tx, a.site, Some("shopify:42"), &state)
        .await
        .unwrap();
    tx.commit().await.unwrap();

    let owner = db.github_consume_state(&state).await.unwrap().unwrap();
    assert_eq!(owner.tenant, a.tenant);
    assert_eq!(owner.site, a.site);
    assert_eq!(owner.created_by_ref.as_deref(), Some("shopify:42"));
    // Spent: a second request with the same state learns nothing.
    assert!(db.github_consume_state(&state).await.unwrap().is_none());
    // And a state nobody issued is the same answer as a spent one.
    assert!(db.github_consume_state(&[8; 32]).await.unwrap().is_none());
    // Another store cannot create a state for this one's site.
    let mut tx = db.tenant(b.tenant).await.unwrap();
    assert!(
        github::create_install_state(&mut tx, a.site, None, &[9; 32])
            .await
            .is_err()
    );
}

#[sqlx::test]
async fn an_expired_install_state_is_refused(opts: PgPoolOptions, conn: PgConnectOptions) {
    let (db, owner, a, _) = two_stores(opts, conn).await;
    let state = [3_u8; 32];
    let mut tx = db.tenant(a.tenant).await.unwrap();
    github::create_install_state(&mut tx, a.site, None, &state)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    sqlx::query(
        "update github_install_states
            set created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'",
    )
    .execute(&owner)
    .await
    .unwrap();
    assert!(db.github_consume_state(&state).await.unwrap().is_none());
}

#[sqlx::test]
async fn an_installation_belongs_to_one_store_and_a_store_has_one_installation(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let (db, _, a, b) = two_stores(opts, conn).await;
    let mut tx = db.tenant(a.tenant).await.unwrap();
    let Linked::Linked(row) = github::link_installation(&mut tx, &installation(a, 4242))
        .await
        .unwrap()
    else {
        panic!("the first link must succeed");
    };
    // Linking again refreshes the same row.
    assert_eq!(
        github::link_installation(&mut tx, &installation(a, 4242))
            .await
            .unwrap(),
        Linked::Linked(row)
    );
    // A second, different installation for the same store is refused.
    assert_eq!(
        github::link_installation(&mut tx, &installation(a, 5555))
            .await
            .unwrap(),
        Linked::StoreHasAnother
    );
    tx.commit().await.unwrap();

    // The webhook lookup finds the owner without knowing the tenant.
    let owner = db.github_installation(4242).await.unwrap().unwrap();
    assert_eq!((owner.tenant, owner.row), (a.tenant, row));
    assert!(db.github_installation(1).await.unwrap().is_none());

    // Another store cannot claim an installation that is linked.
    let mut tx = db.tenant(b.tenant).await.unwrap();
    assert_eq!(
        github::link_installation(&mut tx, &installation(b, 4242))
            .await
            .unwrap(),
        Linked::TakenByAnotherStore
    );
    tx.rollback().await.unwrap();

    // After the link ends, the id is free and no longer found.
    let mut tx = db.tenant(a.tenant).await.unwrap();
    github::unlink_installation(&mut tx, row).await.unwrap();
    tx.commit().await.unwrap();
    assert!(db.github_installation(4242).await.unwrap().is_none());
    let mut tx = db.tenant(b.tenant).await.unwrap();
    assert!(matches!(
        github::link_installation(&mut tx, &installation(b, 4242))
            .await
            .unwrap(),
        Linked::Linked(_)
    ));
}

#[sqlx::test]
async fn only_a_repository_the_installer_could_push_to_can_be_chosen(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let (db, _, a, _) = two_stores(opts, conn).await;
    let mut tx = db.tenant(a.tenant).await.unwrap();
    let Linked::Linked(row) = github::link_installation(&mut tx, &installation(a, 4242))
        .await
        .unwrap()
    else {
        panic!("link");
    };
    github::sync_repos(
        &mut tx,
        row,
        &[
            repo(1, "theme", Some(true)),
            repo(2, "readonly", Some(false)),
            repo(3, "other", Some(true)),
        ],
        true,
    )
    .await
    .unwrap();
    let repos = github::repos_of(&mut tx, row).await.unwrap();
    let id_of = |name: &str| {
        repos
            .iter()
            .find(|r| r.full_name == format!("octo/{name}"))
            .unwrap()
            .id
    };
    assert_eq!(
        github::select_repo(&mut tx, id_of("readonly"), "main")
            .await
            .unwrap(),
        SelectOutcome::NotWritable
    );
    assert_eq!(
        github::select_repo(&mut tx, uuid::Uuid::now_v7(), "main")
            .await
            .unwrap(),
        SelectOutcome::NotFound
    );
    assert_eq!(
        github::select_repo(&mut tx, id_of("theme"), "main")
            .await
            .unwrap(),
        SelectOutcome::Selected
    );
    // Choosing another one moves the choice: only one is ever selected.
    assert_eq!(
        github::select_repo(&mut tx, id_of("other"), "live")
            .await
            .unwrap(),
        SelectOutcome::Selected
    );
    let selected = github::selected_repo(&mut tx).await.unwrap().unwrap();
    assert_eq!(selected.full_name, "octo/other");
    assert_eq!(selected.connected_branch.as_deref(), Some("live"));
    assert_eq!(selected.theme_state, "unchecked");

    // A repository GitHub stops listing is removed and loses the choice.
    // A listing cut short removes nothing.
    github::sync_repos(&mut tx, row, &[repo(1, "theme", None)], false)
        .await
        .unwrap();
    assert!(github::selected_repo(&mut tx).await.unwrap().is_some());
    github::sync_repos(&mut tx, row, &[repo(1, "theme", None)], true)
        .await
        .unwrap();
    assert!(github::selected_repo(&mut tx).await.unwrap().is_none());
    let kept = github::repo_by_github_id(&mut tx, 1)
        .await
        .unwrap()
        .unwrap();
    assert!(
        kept.user_can_push,
        "an unknown permission keeps the stored one"
    );
    assert_eq!(
        github::select_repo(&mut tx, id_of("other"), "main")
            .await
            .unwrap(),
        SelectOutcome::NotFound,
        "a removed repository cannot be chosen"
    );
    tx.commit().await.unwrap();
}

fn event(delivery: &str, body: &str) -> NewEvent {
    NewEvent {
        delivery_id: delivery.to_owned(),
        event: "pull_request".to_owned(),
        installation_id: 4242,
        repository_id: Some(1),
        body: serde_json::json!({"n": body}),
        body_sha256: sha2_of(body),
    }
}

fn sha2_of(text: &str) -> [u8; 32] {
    let mut out = [0_u8; 32];
    for (i, byte) in text.bytes().enumerate() {
        out[i % 32] ^= byte.wrapping_add(u8::try_from(i % 256).unwrap_or(0));
    }
    out
}

#[sqlx::test]
async fn a_delivery_is_stored_once_whatever_id_it_arrives_under(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let (db, _, a, b) = two_stores(opts, conn).await;
    let mut tx = db.tenant(a.tenant).await.unwrap();
    let Recorded::Stored(first) = github::record_event(&mut tx, &event("d-1", "one"))
        .await
        .unwrap()
    else {
        panic!("the first delivery is stored");
    };
    // GitHub's own retry: same delivery id.
    assert_eq!(
        github::record_event(&mut tx, &event("d-1", "one"))
            .await
            .unwrap(),
        Recorded::DuplicateDelivery
    );
    // A replay of a signed body under a fresh delivery id (audit M1).
    assert_eq!(
        github::record_event(&mut tx, &event("d-2", "one"))
            .await
            .unwrap(),
        Recorded::DuplicateBody
    );
    assert!(matches!(
        github::record_event(&mut tx, &event("d-3", "two"))
            .await
            .unwrap(),
        Recorded::Stored(_)
    ));
    let stored = github::event(&mut tx, first).await.unwrap().unwrap();
    assert!(stored.processed_at.is_none());
    github::mark_event_processed(&mut tx, first).await.unwrap();
    assert!(
        github::event(&mut tx, first)
            .await
            .unwrap()
            .unwrap()
            .processed_at
            .is_some()
    );
    tx.commit().await.unwrap();

    // The other store neither sees it nor collides with it.
    let mut tx = db.tenant(b.tenant).await.unwrap();
    assert!(github::event(&mut tx, first).await.unwrap().is_none());
    assert!(matches!(
        github::record_event(&mut tx, &event("d-1", "one"))
            .await
            .unwrap(),
        Recorded::Stored(_)
    ));
}

#[sqlx::test]
async fn a_shop_redaction_removes_every_github_row(opts: PgPoolOptions, conn: PgConnectOptions) {
    let ctl = support::ctl_pool(opts.clone(), conn.clone()).await;
    let owner = owner_pool(opts.clone(), conn.clone()).await;
    let db = Db::from_pool(app_pool(opts, conn).await);
    let a = seed(&db, 1).await;
    let mut tx = db.tenant(a.tenant).await.unwrap();
    let Linked::Linked(row) = github::link_installation(&mut tx, &installation(a, 4242))
        .await
        .unwrap()
    else {
        panic!("link");
    };
    github::sync_repos(&mut tx, row, &[repo(1, "theme", Some(true))], true)
        .await
        .unwrap();
    github::record_event(&mut tx, &event("d-1", "one"))
        .await
        .unwrap();
    github::create_install_state(&mut tx, a.site, None, &[1; 32])
        .await
        .unwrap();
    tx.commit().await.unwrap();

    let ctl = Db::from_pool(ctl);
    let mut tx = ctl.tenant(a.tenant).await.unwrap();
    let removed = db::repo::redact::shop(&mut tx, a.shop)
        .await
        .unwrap()
        .unwrap();
    tx.commit().await.unwrap();
    assert!(removed.github >= 4, "{removed:?}");
    for table in [
        "github_installations",
        "github_repos",
        "github_events",
        "github_install_states",
    ] {
        let left: i64 =
            sqlx::query_scalar(sqlx::AssertSqlSafe(format!("select count(*) from {table}")))
                .fetch_one(&owner)
                .await
                .unwrap();
        assert_eq!(left, 0, "{table}");
    }
}

/// A store with an installation and a chosen theme repository; returns the repository's row.
async fn with_repo(db: &Db, graph: Graph, installation_id: i64, repo_id: i64) -> uuid::Uuid {
    let mut tx = db.tenant(graph.tenant).await.unwrap();
    let Linked::Linked(row) =
        github::link_installation(&mut tx, &installation(graph, installation_id))
            .await
            .unwrap()
    else {
        panic!("link");
    };
    github::sync_repos(&mut tx, row, &[repo(repo_id, "theme", Some(true))], true)
        .await
        .unwrap();
    let id = github::repo_by_github_id(&mut tx, repo_id)
        .await
        .unwrap()
        .unwrap()
        .id;
    github::select_repo(&mut tx, id, "main").await.unwrap();
    tx.commit().await.unwrap();
    id
}

fn new_batch(graph: Graph, repo_row: uuid::Uuid, batch_id: &str) -> code_fix::NewBatch {
    code_fix::NewBatch {
        site: graph.site.as_uuid(),
        repo_row,
        batch_id: batch_id.to_owned(),
        base_branch: "main".to_owned(),
        requested_by: Some("shopify:42".to_owned()),
        recipes: "core".to_owned(),
        judgements: serde_json::json!([]),
    }
}

#[sqlx::test]
async fn a_store_has_one_batch_in_flight_and_cannot_touch_another_stores(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let (db, _, a, b) = two_stores(opts, conn).await;
    let repo_a = with_repo(&db, a, 4242, 4_242_000).await;
    let repo_b = with_repo(&db, b, 5252, 5_252_000).await;

    let mut tx = db.tenant(a.tenant).await.unwrap();
    let code_fix::Created::New(first) =
        code_fix::create_batch(&mut tx, &new_batch(a, repo_a, "one"))
            .await
            .unwrap()
    else {
        panic!("the first batch is new");
    };
    // One at a time: a second request, or the same id again, is not created.
    for id in ["two", "one"] {
        assert_eq!(
            code_fix::create_batch(&mut tx, &new_batch(a, repo_a, id))
                .await
                .unwrap(),
            code_fix::Created::InFlight
        );
    }
    code_fix::add_source_file(
        &mut tx,
        first,
        "layout/theme.liquid",
        "<html></html>",
        &"a".repeat(40),
    )
    .await
    .unwrap();
    assert!(
        code_fix::files_read(&mut tx, first, &"b".repeat(40))
            .await
            .unwrap()
    );
    assert!(
        !code_fix::files_read(&mut tx, first, &"c".repeat(40))
            .await
            .unwrap(),
        "only a batch still reading moves"
    );
    assert_eq!(
        code_fix::batch_files(&mut tx, first).await.unwrap().len(),
        1
    );
    tx.commit().await.unwrap();

    // The other store sees none of it, and cannot move it or use its repository.
    let mut tx = db.tenant(b.tenant).await.unwrap();
    assert!(code_fix::batch(&mut tx, first).await.unwrap().is_none());
    let recent = code_fix::recent_batches(&mut tx, 10).await.unwrap();
    assert_eq!(recent.len(), 0);
    let files = code_fix::batch_files(&mut tx, first).await.unwrap();
    assert_eq!(files.len(), 0);
    assert!(
        !code_fix::move_batch(&mut tx, first, "patching", "ready")
            .await
            .unwrap()
    );
    tx.commit().await.unwrap();
    let mut tx = db.tenant(b.tenant).await.unwrap();
    assert!(
        code_fix::create_batch(&mut tx, &new_batch(b, repo_a, "theirs"))
            .await
            .is_err(),
        "a batch cannot name another store's repository"
    );
    drop(tx);
    let mut tx = db.tenant(b.tenant).await.unwrap();
    assert!(matches!(
        code_fix::create_batch(&mut tx, &new_batch(b, repo_b, "theirs"))
            .await
            .unwrap(),
        code_fix::Created::New(_)
    ));
    tx.commit().await.unwrap();

    // Once the first batch ends, the store can ask again. (Dropping the source is the worker
    // role's job and is covered with the jobs in `ctl`.)
    let mut tx = db.tenant(a.tenant).await.unwrap();
    assert!(
        code_fix::move_batch(&mut tx, first, "patching", "failed")
            .await
            .unwrap()
    );
    assert!(matches!(
        code_fix::create_batch(&mut tx, &new_batch(a, repo_a, "three"))
            .await
            .unwrap(),
        code_fix::Created::New(_)
    ));
    tx.commit().await.unwrap();
}

#[sqlx::test]
async fn a_pull_request_is_found_by_repository_id_and_number_inside_its_own_store(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let (db, _, a, b) = two_stores(opts, conn).await;
    let repo_a = with_repo(&db, a, 4242, 4_242_000).await;
    with_repo(&db, b, 5252, 5_252_000).await;
    let new = |repo_id: i64| code_fix::NewPullRequest {
        repo_row: repo_a,
        repo_id,
        number: 7,
        github_id: Some(99),
        batch_id: "one".to_owned(),
        part: 1,
        head_branch: "rampsmith/fix-one".to_owned(),
        base_branch: "main".to_owned(),
        head_sha: "a".repeat(40),
        pushed_sha: "a".repeat(40),
        html_url: "https://github.com/octo/theme/pull/7".to_owned(),
        check_run_id: None,
        fix_count: 1,
        files: 1,
        changed_lines: 2,
    };
    let mut tx = db.tenant(a.tenant).await.unwrap();
    let id = code_fix::upsert_pull_request(&mut tx, &new(4_242_000))
        .await
        .unwrap();
    // Recording it again (a re-run after a crash) updates the same row.
    let again = code_fix::upsert_pull_request(
        &mut tx,
        &code_fix::NewPullRequest {
            head_sha: "b".repeat(40),
            ..new(4_242_000)
        },
    )
    .await
    .unwrap();
    assert_eq!(id, again);
    code_fix::link_pull_request_fixes(&mut tx, id, &[a.fix.as_uuid()])
        .await
        .unwrap();
    assert_eq!(
        code_fix::pull_request_fix_ids(&mut tx, id).await.unwrap(),
        [a.fix.as_uuid()]
    );
    // A number alone is not an identity: the repository id has to match too (audit L8).
    assert!(
        code_fix::pull_request_by_number(&mut tx, 4_242_000, 7)
            .await
            .unwrap()
            .is_some()
    );
    assert!(
        code_fix::pull_request_by_number(&mut tx, 1, 7)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        code_fix::pull_request_by_number(&mut tx, 4_242_000, 8)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        code_fix::open_pull_requests(&mut tx, 4_242_000)
            .await
            .unwrap()
            .len(),
        1
    );
    code_fix::record_pull_request_state(&mut tx, id, "merged", &"c".repeat(40))
        .await
        .unwrap();
    let still_open = code_fix::open_pull_requests(&mut tx, 4_242_000)
        .await
        .unwrap();
    assert_eq!(still_open.len(), 0);
    let row = code_fix::pull_request(&mut tx, id).await.unwrap().unwrap();
    assert_eq!(
        (row.state.as_str(), row.head_sha),
        ("merged", "c".repeat(40))
    );
    assert_eq!(
        row.pushed_sha,
        "a".repeat(40),
        "what Rampsmith pushed is not what GitHub reports"
    );
    assert!(row.closed_at.is_some());
    tx.commit().await.unwrap();

    // The other store finds nothing, by id or by number.
    let mut tx = db.tenant(b.tenant).await.unwrap();
    assert!(code_fix::pull_request(&mut tx, id).await.unwrap().is_none());
    assert!(
        code_fix::pull_request_by_number(&mut tx, 4_242_000, 7)
            .await
            .unwrap()
            .is_none()
    );
    let recent_prs = code_fix::recent_pull_requests(&mut tx, 10).await.unwrap();
    assert_eq!(recent_prs.len(), 0);
}
