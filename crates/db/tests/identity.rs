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
    assert_eq!(
        identity::sweep(&mut tx, now() + Duration::days(31))
            .await
            .unwrap(),
        1
    );
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
