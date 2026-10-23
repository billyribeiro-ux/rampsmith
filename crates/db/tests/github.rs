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
