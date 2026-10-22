//! The identity repository (ADR-024): users, passkeys, ceremonies and sessions.

// Integration tests are test code: PLAN §8 denies these lints outside tests only.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod support;

use db::repo::identity::{self, CeremonyKind, PendingUser};
use db::{Db, DbError};
use domain::UserId;
use serde_json::json;
use sqlx::Executor;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use time::{Duration, OffsetDateTime};

async fn app_db(opts: PgPoolOptions, conn: PgConnectOptions) -> Db {
    Db::from_pool(support::app_pool(opts, conn).await)
}

fn now() -> OffsetDateTime {
    OffsetDateTime::from_unix_timestamp(1_792_300_000).unwrap()
}

async fn user(db: &Db, email: &str) -> identity::User {
    let mut tx = db.identity().await.unwrap();
    let u = identity::create_user(&mut tx, UserId::new(), email, "Ada")
        .await
        .unwrap();
    tx.commit().await.unwrap();
    u
}

#[sqlx::test]
async fn emails_are_unique_and_must_be_lowercase(opts: PgPoolOptions, conn: PgConnectOptions) {
    let db = app_db(opts, conn).await;
    user(&db, "ada@example.com").await;
    let mut tx = db.identity().await.unwrap();
    assert!(
        identity::email_taken(&mut tx, "ada@example.com")
            .await
            .unwrap()
    );
    assert!(
        !identity::email_taken(&mut tx, "bob@example.com")
            .await
            .unwrap()
    );
    let err = identity::create_user(&mut tx, UserId::new(), "ada@example.com", "Again")
        .await
        .unwrap_err();
    assert!(matches!(err, DbError::Conflict(_)), "{err:?}");
    tx.rollback().await.unwrap();
    for bad in ["Ada@example.com", "no-at-sign", "a@b"] {
        let mut tx = db.identity().await.unwrap();
        let err = identity::create_user(&mut tx, UserId::new(), bad, "X")
            .await
            .unwrap_err();
        assert!(matches!(err, DbError::Invalid(_)), "{bad}: {err:?}");
    }
}

#[sqlx::test]
async fn a_credential_id_is_registered_once(opts: PgPoolOptions, conn: PgConnectOptions) {
    let db = app_db(opts, conn).await;
    let ada = user(&db, "ada@example.com").await;
    let bob = user(&db, "bob@example.com").await;
    let mut tx = db.identity().await.unwrap();
    identity::add_passkey(&mut tx, ada.id, b"cred-1", &json!({"k": 1}))
        .await
        .unwrap();
    tx.commit().await.unwrap();

    let mut tx = db.identity().await.unwrap();
    let err = identity::add_passkey(&mut tx, bob.id, b"cred-1", &json!({"k": 2}))
        .await
        .unwrap_err();
    assert!(matches!(err, DbError::Conflict(_)), "{err:?}");
    tx.rollback().await.unwrap();

    let mut tx = db.identity().await.unwrap();
    let found = identity::passkey_for_sign_in(&mut tx, ada.id, b"cred-1")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(found.passkey, json!({"k": 1}));
    // Another user's credential is never returned for this user.
    assert!(
        identity::passkey_for_sign_in(&mut tx, bob.id, b"cred-1")
            .await
            .unwrap()
            .is_none()
    );
    identity::passkey_used(&mut tx, found.id, Some(&json!({"k": 9})), now())
        .await
        .unwrap();
    identity::passkey_used(&mut tx, found.id, None, now() + Duration::minutes(1))
        .await
        .unwrap();
    let all = identity::passkeys(&mut tx, ada.id).await.unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(
        all[0].passkey,
        json!({"k": 9}),
        "None keeps the stored passkey"
    );
}

#[sqlx::test]
async fn ceremonies_complete_once_and_expire(opts: PgPoolOptions, conn: PgConnectOptions) {
    let db = app_db(opts, conn).await;
    let pending = PendingUser {
        id: UserId::new(),
        email: "ada@example.com".to_owned(),
        display_name: "Ada".to_owned(),
    };
    // A registration must say who it creates; a sign-in must not.
    let mut tx = db.identity().await.unwrap();
    assert!(
        identity::begin_ceremony(
            &mut tx,
            CeremonyKind::Authentication,
            &json!({}),
            Some(&pending),
            now()
        )
        .await
        .is_err()
    );
    tx.rollback().await.unwrap();

    let mut tx = db.identity().await.unwrap();
    let reg = identity::begin_ceremony(
        &mut tx,
        CeremonyKind::Registration,
        &json!({"rs": 1}),
        Some(&pending),
        now() + Duration::minutes(5),
    )
    .await
    .unwrap();
    let auth = identity::begin_ceremony(
        &mut tx,
        CeremonyKind::Authentication,
        &json!({"ast": 1}),
        None,
        now() + Duration::minutes(5),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();

    let mut tx = db.identity().await.unwrap();
    // The wrong kind finds nothing.
    assert!(
        identity::take_ceremony(&mut tx, reg, CeremonyKind::Authentication, now())
            .await
            .unwrap()
            .is_none()
    );
    let taken = identity::take_ceremony(&mut tx, reg, CeremonyKind::Registration, now())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(taken.state, json!({"rs": 1}));
    assert_eq!(taken.pending_user, Some(pending));
    assert!(
        identity::take_ceremony(&mut tx, reg, CeremonyKind::Registration, now())
            .await
            .unwrap()
            .is_none(),
        "single use"
    );
    // Expired.
    assert!(
        identity::take_ceremony(
            &mut tx,
            auth,
            CeremonyKind::Authentication,
            now() + Duration::minutes(5)
        )
        .await
        .unwrap()
        .is_none()
    );
    let fresh = identity::take_ceremony(&mut tx, auth, CeremonyKind::Authentication, now())
        .await
        .unwrap()
        .unwrap();
    assert!(fresh.pending_user.is_none());
}

#[sqlx::test]
async fn sessions_slide_their_idle_expiry_up_to_the_absolute_one(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let db = app_db(opts, conn).await;
    let ada = user(&db, "ada@example.com").await;
    let hash = [7_u8; 32];
    let idle = Duration::days(7);
    let mut tx = db.identity().await.unwrap();
    identity::create_session(
        &mut tx,
        &hash,
        ada.id,
        now() + idle,
        now() + Duration::days(30),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();

    let mut tx = db.identity().await.unwrap();
    // Day 6: alive, and the idle expiry moves to day 13.
    let seen = identity::touch_session(&mut tx, &hash, now() + Duration::days(6), idle)
        .await
        .unwrap();
    assert_eq!(seen.map(|u| u.id), Some(ada.id));
    // Day 12: alive only because day 6 extended it.
    assert!(
        identity::touch_session(&mut tx, &hash, now() + Duration::days(12), idle)
            .await
            .unwrap()
            .is_some()
    );
    // An unknown token finds nothing.
    assert!(
        identity::touch_session(&mut tx, &[8_u8; 32], now(), idle)
            .await
            .unwrap()
            .is_none()
    );
    // Day 30: past the absolute expiry, however recently it was used.
    for day in [18, 24, 29] {
        identity::touch_session(&mut tx, &hash, now() + Duration::days(day), idle)
            .await
            .unwrap()
            .unwrap();
    }
    assert!(
        identity::touch_session(&mut tx, &hash, now() + Duration::days(30), idle)
            .await
            .unwrap()
            .is_none()
    );
    tx.commit().await.unwrap();

    // A session idle for longer than `idle` is dead.
    let other = [9_u8; 32];
    let mut tx = db.identity().await.unwrap();
    identity::create_session(
        &mut tx,
        &other,
        ada.id,
        now() + idle,
        now() + Duration::days(30),
    )
    .await
    .unwrap();
    assert!(
        identity::touch_session(&mut tx, &other, now() + Duration::days(8), idle)
            .await
            .unwrap()
            .is_none()
    );
    assert!(identity::delete_session(&mut tx, &other).await.unwrap());
    assert!(!identity::delete_session(&mut tx, &other).await.unwrap());
}

/// A sign-in as the identity crate does it: end the user's sessions, then start a new one.
async fn sign_in(db: &Db, user: &identity::User, hash: [u8; 32]) -> u64 {
    let mut tx = db.identity().await.unwrap();
    let ended = identity::delete_sessions_of(&mut tx, user.id)
        .await
        .unwrap();
    identity::create_session(
        &mut tx,
        &hash,
        user.id,
        now() + Duration::days(7),
        now() + Duration::days(30),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    ended
}

async fn sessions_of(owner: &sqlx::PgPool, user: &identity::User) -> Vec<Vec<u8>> {
    sqlx::query_scalar(
        "select token_hash from web_sessions where user_id = $1 order by created_at, token_hash",
    )
    .bind(user.id.as_uuid())
    .fetch_all(owner)
    .await
    .unwrap()
}

/// Audit L8, ADR-046.
#[sqlx::test]
async fn ending_a_users_sessions_leaves_every_other_user_alone(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let owner = support::owner_pool(opts.clone(), conn.clone()).await;
    let db = app_db(opts, conn).await;
    let ada = user(&db, "ada@example.com").await;
    let bob = user(&db, "bob@example.com").await;
    assert_eq!(sign_in(&db, &ada, [1; 32]).await, 0, "nothing to end yet");
    assert_eq!(sign_in(&db, &bob, [2; 32]).await, 0);

    assert_eq!(sign_in(&db, &ada, [3; 32]).await, 1);
    assert_eq!(sessions_of(&owner, &ada).await, vec![vec![3_u8; 32]]);
    assert_eq!(sessions_of(&owner, &bob).await, vec![vec![2_u8; 32]]);

    // Ending a user's sessions in a transaction that rolls back ends nothing.
    let mut tx = db.identity().await.unwrap();
    assert_eq!(
        identity::delete_sessions_of(&mut tx, ada.id).await.unwrap(),
        1
    );
    tx.rollback().await.unwrap();
    assert_eq!(sessions_of(&owner, &ada).await, vec![vec![3_u8; 32]]);

    // An unknown user has none.
    let mut tx = db.identity().await.unwrap();
    assert_eq!(
        identity::delete_sessions_of(&mut tx, UserId::new())
            .await
            .unwrap(),
        0
    );
}

/// Two sign-ins of one user at once must leave one session, not two: the second waits for the
/// first and ends the session it made.
#[sqlx::test]
async fn simultaneous_sign_ins_of_one_user_take_turns(opts: PgPoolOptions, conn: PgConnectOptions) {
    let owner = support::owner_pool(opts.clone(), conn.clone()).await;
    let db = app_db(opts, conn).await;
    let ada = user(&db, "ada@example.com").await;

    // The first sign-in has done its work and not yet committed.
    let mut first = db.identity().await.unwrap();
    identity::delete_sessions_of(&mut first, ada.id)
        .await
        .unwrap();
    identity::create_session(
        &mut first,
        &[1; 32],
        ada.id,
        now() + Duration::days(7),
        now() + Duration::days(30),
    )
    .await
    .unwrap();

    let second = {
        let db = db.clone();
        let ada = ada.clone();
        tokio::spawn(async move { sign_in(&db, &ada, [2; 32]).await })
    };
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    assert!(
        !second.is_finished(),
        "the second sign-in did not wait for the first"
    );

    first.commit().await.unwrap();
    assert_eq!(
        second.await.unwrap(),
        1,
        "it ended the first sign-in's session"
    );
    assert_eq!(sessions_of(&owner, &ada).await, vec![vec![2_u8; 32]]);
}

/// Audit M6, ADR-042. The `ctl` leader runs as the worker role, which has no grants on the
/// identity tables; it sweeps through a function that deletes only what the database's own
/// clock says is expired.
#[sqlx::test]
async fn the_worker_sweeps_expired_sign_in_state_and_only_that(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let app = app_db(opts.clone(), conn.clone()).await;
    let worker = Db::from_pool(support::worker_pool(opts, conn).await);
    let ada = user(&app, "ada@example.com").await;
    let (idle, now) = (Duration::days(7), OffsetDateTime::now_utc());
    let hour = Duration::hours(1);
    let pending = PendingUser {
        id: UserId::new(),
        email: "bob@example.com".to_owned(),
        display_name: "Bob".to_owned(),
    };

    let mut tx = app.identity().await.unwrap();
    // Sessions: idle-expired, past the absolute expiry, and live.
    for (hash, idle_at, absolute_at) in [
        ([1_u8; 32], now - hour, now + hour),
        ([2; 32], now - hour, now - hour),
        ([3; 32], now + hour, now + Duration::days(1)),
    ] {
        identity::create_session(&mut tx, &hash, ada.id, idle_at, absolute_at)
            .await
            .unwrap();
    }
    // Ceremonies: two expired a minute ago, one with five minutes left.
    let minute = Duration::minutes(1);
    let state = json!({});
    for kind in [CeremonyKind::Authentication, CeremonyKind::Registration] {
        let pending = (kind == CeremonyKind::Registration).then_some(&pending);
        identity::begin_ceremony(&mut tx, kind, &state, pending, now - minute)
            .await
            .unwrap();
    }
    let live = identity::begin_ceremony(
        &mut tx,
        CeremonyKind::Authentication,
        &state,
        None,
        now + Duration::minutes(5),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();

    let mut tx = worker.identity().await.unwrap();
    assert_eq!(identity::sweep(&mut tx).await.unwrap(), 4);
    tx.commit().await.unwrap();
    let mut tx = worker.identity().await.unwrap();
    assert_eq!(
        identity::sweep(&mut tx).await.unwrap(),
        0,
        "nothing left to do"
    );
    tx.commit().await.unwrap();

    // What was live still is.
    let mut tx = app.identity().await.unwrap();
    assert!(
        identity::touch_session(&mut tx, &[3_u8; 32], now, idle)
            .await
            .unwrap()
            .is_some()
    );
    assert!(
        identity::take_ceremony(&mut tx, live, CeremonyKind::Authentication, now)
            .await
            .unwrap()
            .is_some()
    );
    tx.commit().await.unwrap();
}

/// The api never needs the sweep, so it may not run it.
#[sqlx::test]
async fn the_application_role_cannot_run_the_sweep(opts: PgPoolOptions, conn: PgConnectOptions) {
    let app = app_db(opts, conn).await;
    let mut tx = app.identity().await.unwrap();
    let error = identity::sweep(&mut tx).await.unwrap_err();
    assert!(matches!(error, DbError::Forbidden), "{error:?}");
}

#[sqlx::test]
async fn the_worker_role_cannot_read_identity(opts: PgPoolOptions, conn: PgConnectOptions) {
    let pool = opts
        .after_connect(|c, _| {
            Box::pin(async move {
                c.execute("set role rampsmith_worker").await?;
                Ok(())
            })
        })
        .connect_with(conn)
        .await
        .unwrap();
    for table in ["users", "passkeys", "webauthn_ceremonies", "web_sessions"] {
        let err = sqlx::query(sqlx::AssertSqlSafe(format!("select count(*) from {table}")))
            .fetch_one(&pool)
            .await
            .unwrap_err();
        assert!(
            err.to_string().contains("permission denied"),
            "{table}: {err}"
        );
    }
}
