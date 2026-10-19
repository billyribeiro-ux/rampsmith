//! Standalone-dashboard identity: users, passkeys, WebAuthn ceremonies and sessions
//! (PLAN §16, ADR-024). These rows are not tenant-owned; every function takes an
//! [`IdentityTx`]. Session tokens are never stored, only their SHA-256.

use domain::UserId;
use serde_json::Value;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::{DbError, IdentityTx};

/// A dashboard user.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct User {
    /// The user's id; also the WebAuthn user handle.
    pub id: UserId,
    /// Lowercased email address.
    pub email: String,
    /// The name shown in the dashboard.
    pub display_name: String,
    /// When the email was verified, once email links exist.
    pub email_verified_at: Option<OffsetDateTime>,
    /// When the account was created.
    pub created_at: OffsetDateTime,
}

struct UserRow {
    id: Uuid,
    email: String,
    display_name: String,
    email_verified_at: Option<OffsetDateTime>,
    created_at: OffsetDateTime,
}

impl From<UserRow> for User {
    fn from(r: UserRow) -> Self {
        Self {
            id: UserId::from_uuid(r.id),
            email: r.email,
            display_name: r.display_name,
            email_verified_at: r.email_verified_at,
            created_at: r.created_at,
        }
    }
}

/// Creates a user. A taken email is `DbError::Conflict`.
pub async fn create_user(
    tx: &mut IdentityTx,
    id: UserId,
    email: &str,
    display_name: &str,
) -> Result<User, DbError> {
    let row = sqlx::query_as!(
        UserRow,
        r#"insert into users (id, email, display_name) values ($1, $2, $3)
           returning id, email, display_name, email_verified_at, created_at"#,
        id.as_uuid(),
        email,
        display_name,
    )
    .fetch_one(tx.conn())
    .await?;
    Ok(row.into())
}

/// Whether an account uses this (lowercased) email.
pub async fn email_taken(tx: &mut IdentityTx, email: &str) -> Result<bool, DbError> {
    Ok(sqlx::query_scalar!(
        r#"select exists (select 1 from users where email = $1) as "taken!""#,
        email
    )
    .fetch_one(tx.conn())
    .await?)
}

/// One user.
pub async fn user(tx: &mut IdentityTx, id: UserId) -> Result<Option<User>, DbError> {
    let row = sqlx::query_as!(
        UserRow,
        r#"select id, email, display_name, email_verified_at, created_at from users where id = $1"#,
        id.as_uuid(),
    )
    .fetch_optional(tx.conn())
    .await?;
    Ok(row.map(User::from))
}

/// A stored passkey: the `webauthn-rs` serialisation, which holds no secret.
#[derive(Debug, Clone, PartialEq)]
pub struct StoredPasskey {
    /// Row id.
    pub id: Uuid,
    /// Its owner.
    pub user_id: UserId,
    /// The WebAuthn credential id.
    pub credential_id: Vec<u8>,
    /// The serialised passkey.
    pub passkey: Value,
}

/// Registers a passkey. A credential id already registered to anyone is `DbError::Conflict`.
pub async fn add_passkey(
    tx: &mut IdentityTx,
    user: UserId,
    credential_id: &[u8],
    passkey: &Value,
) -> Result<Uuid, DbError> {
    let id = Uuid::now_v7();
    sqlx::query!(
        "insert into passkeys (id, user_id, credential_id, passkey) values ($1, $2, $3, $4)",
        id,
        user.as_uuid(),
        credential_id,
        passkey,
    )
    .execute(tx.conn())
    .await?;
    Ok(id)
}

/// The passkey with `credential_id` owned by `user`, locked until the transaction ends so
/// concurrent sign-ins update its counter one at a time.
pub async fn passkey_for_sign_in(
    tx: &mut IdentityTx,
    user: UserId,
    credential_id: &[u8],
) -> Result<Option<StoredPasskey>, DbError> {
    let row = sqlx::query!(
        r#"select id, user_id, credential_id, passkey from passkeys
            where user_id = $1 and credential_id = $2
            for update"#,
        user.as_uuid(),
        credential_id,
    )
    .fetch_optional(tx.conn())
    .await?;
    Ok(row.map(|r| StoredPasskey {
        id: r.id,
        user_id: UserId::from_uuid(r.user_id),
        credential_id: r.credential_id,
        passkey: r.passkey,
    }))
}

/// Every passkey of a user, oldest first.
pub async fn passkeys(tx: &mut IdentityTx, user: UserId) -> Result<Vec<StoredPasskey>, DbError> {
    let rows = sqlx::query!(
        r#"select id, user_id, credential_id, passkey from passkeys
            where user_id = $1 order by created_at, id"#,
        user.as_uuid(),
    )
    .fetch_all(tx.conn())
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| StoredPasskey {
            id: r.id,
            user_id: UserId::from_uuid(r.user_id),
            credential_id: r.credential_id,
            passkey: r.passkey,
        })
        .collect())
}

/// Records a sign-in with a passkey, storing its updated counter and flags when they changed.
pub async fn passkey_used(
    tx: &mut IdentityTx,
    id: Uuid,
    updated: Option<&Value>,
    at: OffsetDateTime,
) -> Result<(), DbError> {
    sqlx::query!(
        "update passkeys set last_used_at = $2, passkey = coalesce($3, passkey) where id = $1",
        id,
        at,
        updated,
    )
    .execute(tx.conn())
    .await?;
    Ok(())
}

/// What a ceremony is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CeremonyKind {
    /// Registering a new user and their first passkey.
    Registration,
    /// Signing in with a discoverable passkey.
    Authentication,
}

impl CeremonyKind {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Registration => "registration",
            Self::Authentication => "authentication",
        }
    }
}

/// The user a registration will create once its passkey verifies.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingUser {
    /// The id the passkey is bound to (its user handle).
    pub id: UserId,
    /// Lowercased email.
    pub email: String,
    /// Display name.
    pub display_name: String,
}

/// A ceremony taken for completion.
#[derive(Debug, Clone, PartialEq)]
pub struct Ceremony {
    /// The server-side WebAuthn state.
    pub state: Value,
    /// For registrations, the user to create.
    pub pending_user: Option<PendingUser>,
}

/// Stores a ceremony's state until `expires_at`. Returns its id, which the browser echoes.
pub async fn begin_ceremony(
    tx: &mut IdentityTx,
    kind: CeremonyKind,
    state: &Value,
    pending_user: Option<&PendingUser>,
    expires_at: OffsetDateTime,
) -> Result<Uuid, DbError> {
    let id = Uuid::now_v7();
    sqlx::query!(
        r#"insert into webauthn_ceremonies
             (id, kind, state, pending_user_id, pending_email, pending_display_name, expires_at)
           values ($1, $2, $3, $4, $5, $6, $7)"#,
        id,
        kind.as_str(),
        state,
        pending_user.map(|p| p.id.as_uuid()),
        pending_user.map(|p| p.email.as_str()),
        pending_user.map(|p| p.display_name.as_str()),
        expires_at,
    )
    .execute(tx.conn())
    .await?;
    Ok(id)
}

/// Removes and returns an unexpired ceremony of `kind`. Each ceremony completes at most once.
pub async fn take_ceremony(
    tx: &mut IdentityTx,
    id: Uuid,
    kind: CeremonyKind,
    now: OffsetDateTime,
) -> Result<Option<Ceremony>, DbError> {
    let row = sqlx::query!(
        r#"delete from webauthn_ceremonies
            where id = $1 and kind = $2 and expires_at > $3
        returning state, pending_user_id, pending_email, pending_display_name"#,
        id,
        kind.as_str(),
        now,
    )
    .fetch_optional(tx.conn())
    .await?;
    Ok(row.map(|r| Ceremony {
        state: r.state,
        pending_user: match (r.pending_user_id, r.pending_email, r.pending_display_name) {
            (Some(id), Some(email), Some(display_name)) => Some(PendingUser {
                id: UserId::from_uuid(id),
                email,
                display_name,
            }),
            _ => None,
        },
    }))
}

/// Starts a session for `user`. `token_hash` is the SHA-256 of the token.
pub async fn create_session(
    tx: &mut IdentityTx,
    token_hash: &[u8; 32],
    user: UserId,
    idle_expires_at: OffsetDateTime,
    absolute_expires_at: OffsetDateTime,
) -> Result<(), DbError> {
    sqlx::query!(
        r#"insert into web_sessions (token_hash, user_id, idle_expires_at, absolute_expires_at)
           values ($1, $2, $3, $4)"#,
        token_hash.as_slice(),
        user.as_uuid(),
        idle_expires_at,
        absolute_expires_at,
    )
    .execute(tx.conn())
    .await?;
    Ok(())
}

/// The user of a live session, extending its idle expiry to `now + idle` (never past its
/// absolute expiry). `None` for an unknown or expired session.
pub async fn touch_session(
    tx: &mut IdentityTx,
    token_hash: &[u8; 32],
    now: OffsetDateTime,
    idle: time::Duration,
) -> Result<Option<User>, DbError> {
    let row = sqlx::query_as!(
        UserRow,
        r#"with touched as (
             update web_sessions
                set last_seen_at = $2,
                    idle_expires_at = least($2 + $3::interval, absolute_expires_at)
              where token_hash = $1 and idle_expires_at > $2 and absolute_expires_at > $2
          returning user_id)
           select u.id, u.email, u.display_name, u.email_verified_at, u.created_at
             from users u join touched t on t.user_id = u.id"#,
        token_hash.as_slice(),
        now,
        sqlx::postgres::types::PgInterval {
            months: 0,
            days: 0,
            microseconds: i64::try_from(idle.whole_microseconds()).unwrap_or(i64::MAX),
        },
    )
    .fetch_optional(tx.conn())
    .await?;
    Ok(row.map(User::from))
}

/// Ends a session. Returns whether it existed.
pub async fn delete_session(tx: &mut IdentityTx, token_hash: &[u8; 32]) -> Result<bool, DbError> {
    let done = sqlx::query!(
        "delete from web_sessions where token_hash = $1",
        token_hash.as_slice()
    )
    .execute(tx.conn())
    .await?;
    Ok(done.rows_affected() > 0)
}

/// Ends every session of `user` and returns how many there were. A sign-in calls this before it
/// creates its own session, so a session someone else holds does not outlive the person's next
/// sign-in (audit L8, ADR-046).
///
/// The user's row is locked first. Two sign-ins at once then take turns: the second waits for
/// the first to commit and deletes the session it created, so exactly one session is left. A
/// single `delete` could not do this, because under `READ COMMITTED` its snapshot is taken
/// before the lock wait ends and would not see the first sign-in's new row.
pub async fn delete_sessions_of(tx: &mut IdentityTx, user: UserId) -> Result<u64, DbError> {
    sqlx::query_scalar!(
        "select id from users where id = $1 for update",
        user.as_uuid()
    )
    .fetch_optional(tx.conn())
    .await?;
    let done = sqlx::query!(
        "delete from web_sessions where user_id = $1",
        user.as_uuid()
    )
    .execute(tx.conn())
    .await?;
    Ok(done.rows_affected())
}

/// Deletes expired sessions and ceremonies by the database's clock; returns how many rows
/// went. It calls `identity_sweep()` (migration 20261101000001), which only the worker role
/// may execute: the worker has no grants on the identity tables themselves (ADR-042).
pub async fn sweep(tx: &mut IdentityTx) -> Result<u64, DbError> {
    let swept = sqlx::query_scalar!(r#"select identity_sweep() as "swept!""#)
        .fetch_one(tx.conn())
        .await?;
    Ok(u64::try_from(swept).unwrap_or(0))
}
