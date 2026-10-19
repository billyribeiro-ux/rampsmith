//! Standalone-dashboard identity (PLAN §16, ADR-024): passkey registration and discoverable
//! sign-in through `webauthn-rs`, and opaque session tokens of which only a SHA-256 is stored.
//!
//! Each ceremony has two steps. `start_*` returns options for `navigator.credentials` and a
//! ceremony id; the server keeps the WebAuthn state. `finish_*` takes the browser's answer and
//! the id, consumes the state, verifies, and on success returns a new session.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use db::repo::identity::{self as repo, CeremonyKind, PendingUser};
use db::{Db, DbError};
use domain::UserId;
use secrecy::{ExposeSecret, SecretString};
use sha2::{Digest, Sha256};
use time::{Duration, OffsetDateTime};
use tracing::{info, instrument, warn};
use webauthn_rs::prelude::{
    CreationChallengeResponse, DiscoverableAuthentication, DiscoverableKey, Passkey,
    PasskeyRegistration, PublicKeyCredential, RegisterPublicKeyCredential,
    RequestChallengeResponse, Url, Uuid, Webauthn, WebauthnBuilder,
};

pub use db::repo::identity::User;

/// How long a ceremony may take between its two steps.
pub const CEREMONY_TTL: Duration = Duration::minutes(5);
/// A session dies after this long unused (PLAN §16).
pub const SESSION_IDLE: Duration = Duration::days(7);
/// A session dies this long after sign-in, however much it is used (PLAN §16).
pub const SESSION_ABSOLUTE: Duration = Duration::days(30);

/// Why an identity operation failed. Messages are safe to log; none contains a token.
#[derive(Debug, thiserror::Error)]
pub enum IdentityError {
    /// The email or display name is unusable.
    #[error("invalid input: {0}")]
    InvalidInput(&'static str),
    /// An account already uses this email.
    #[error("an account already uses this email")]
    EmailTaken,
    /// The ceremony is unknown, expired or already used.
    #[error("the ceremony is unknown, expired or already completed")]
    CeremonyNotFound,
    /// The browser's answer did not verify.
    #[error("the passkey response was rejected")]
    Rejected,
    /// The relying-party configuration is unusable.
    #[error("invalid WebAuthn configuration: {0}")]
    Config(String),
    /// Stored state could not be read back.
    #[error("stored WebAuthn state is corrupt")]
    Corrupt,
    /// The database failed.
    #[error(transparent)]
    Database(#[from] DbError),
}

/// A session just created by a sign-in or registration. The token leaves the process once.
#[derive(Debug)]
pub struct NewSession {
    /// The bearer token for the cookie. Never logged.
    pub token: SecretString,
    /// Who signed in.
    pub user: User,
    /// When the session ends regardless of use.
    pub expires_at: OffsetDateTime,
}

/// Passkeys and sessions for one relying party.
#[derive(Debug, Clone)]
pub struct Identity {
    db: Db,
    webauthn: std::sync::Arc<Webauthn>,
}

fn normalise_email(email: &str) -> Result<String, IdentityError> {
    let email = email.trim().to_lowercase();
    let valid = email.len() <= 254
        && email.split_once('@').is_some_and(|(local, domain)| {
            !local.is_empty()
                && domain.contains('.')
                && !domain.starts_with('.')
                && !domain.ends_with('.')
                && !email.chars().any(char::is_whitespace)
                && !domain.contains('@')
        });
    if valid {
        Ok(email)
    } else {
        Err(IdentityError::InvalidInput("email"))
    }
}

fn normalise_name(name: &str) -> Result<String, IdentityError> {
    let name = name.trim();
    if (1..=100).contains(&name.chars().count()) && !name.chars().any(char::is_control) {
        Ok(name.to_owned())
    } else {
        Err(IdentityError::InvalidInput("display name"))
    }
}

/// Asks for a discoverable credential. `webauthn-rs` leaves `residentKey` at "discouraged",
/// which security keys and Chromium's authenticator honour, and sign-in here is discoverable
/// (ADR-024), so a non-resident credential could never sign in. The challenge is unchanged and
/// registration verification does not depend on this field.
fn require_discoverable(
    options: CreationChallengeResponse,
) -> Result<CreationChallengeResponse, IdentityError> {
    let mut value = serde_json::to_value(options).map_err(|_| IdentityError::Corrupt)?;
    let selection = value
        .get_mut("publicKey")
        .and_then(|pk| pk.get_mut("authenticatorSelection"))
        .and_then(serde_json::Value::as_object_mut)
        .ok_or(IdentityError::Corrupt)?;
    selection.insert("residentKey".to_owned(), "required".into());
    selection.insert("requireResidentKey".to_owned(), true.into());
    serde_json::from_value(value).map_err(|_| IdentityError::Corrupt)
}

/// The SHA-256 of a session token, which is all the database ever sees.
fn token_hash(token: &str) -> [u8; 32] {
    Sha256::digest(token.as_bytes()).into()
}

impl Identity {
    /// An identity service for the relying party `rp_id` (a registrable domain) whose pages are
    /// served from `rp_origin`.
    pub fn new(db: Db, rp_id: &str, rp_origin: &str, rp_name: &str) -> Result<Self, IdentityError> {
        let origin = Url::parse(rp_origin).map_err(|e| IdentityError::Config(e.to_string()))?;
        let webauthn = WebauthnBuilder::new(rp_id, &origin)
            .map_err(|e| IdentityError::Config(e.to_string()))?
            .rp_name(rp_name)
            .build()
            .map_err(|e| IdentityError::Config(e.to_string()))?;
        Ok(Self {
            db,
            webauthn: std::sync::Arc::new(webauthn),
        })
    }

    /// Starts registering a new account with its first passkey.
    #[instrument(skip_all, err(Display))]
    pub async fn start_registration(
        &self,
        email: &str,
        display_name: &str,
        now: OffsetDateTime,
    ) -> Result<(Uuid, CreationChallengeResponse), IdentityError> {
        let email = normalise_email(email)?;
        let display_name = normalise_name(display_name)?;
        let mut tx = self.db.identity().await?;
        if repo::email_taken(&mut tx, &email).await? {
            return Err(IdentityError::EmailTaken);
        }
        let user_id = UserId::new();
        let (options, state) = self
            .webauthn
            .start_passkey_registration(user_id.as_uuid(), &email, &display_name, None)
            .map_err(|e| IdentityError::Config(e.to_string()))?;
        let options = require_discoverable(options)?;
        let state = serde_json::to_value(&state).map_err(|_| IdentityError::Corrupt)?;
        let pending = PendingUser {
            id: user_id,
            email,
            display_name,
        };
        let id = repo::begin_ceremony(
            &mut tx,
            CeremonyKind::Registration,
            &state,
            Some(&pending),
            now + CEREMONY_TTL,
        )
        .await?;
        tx.commit().await?;
        Ok((id, options))
    }

    /// Finishes a registration: verifies the new passkey, creates the account and signs in.
    #[instrument(skip_all, err(Display))]
    pub async fn finish_registration(
        &self,
        ceremony: Uuid,
        credential: &RegisterPublicKeyCredential,
        now: OffsetDateTime,
    ) -> Result<NewSession, IdentityError> {
        let taken = self.take(ceremony, CeremonyKind::Registration, now).await?;
        let pending = taken.pending_user.ok_or(IdentityError::Corrupt)?;
        let state: PasskeyRegistration =
            serde_json::from_value(taken.state).map_err(|_| IdentityError::Corrupt)?;
        let passkey = self
            .webauthn
            .finish_passkey_registration(credential, &state)
            .map_err(|e| {
                warn!(error = %e, "passkey registration rejected");
                IdentityError::Rejected
            })?;
        let stored = serde_json::to_value(&passkey).map_err(|_| IdentityError::Corrupt)?;

        let mut tx = self.db.identity().await?;
        let user = repo::create_user(&mut tx, pending.id, &pending.email, &pending.display_name)
            .await
            .map_err(|e| match e {
                DbError::Conflict(_) => IdentityError::EmailTaken,
                e => IdentityError::Database(e),
            })?;
        repo::add_passkey(&mut tx, user.id, passkey.cred_id().as_ref(), &stored)
            .await
            .map_err(|e| match e {
                DbError::Conflict(_) => IdentityError::Rejected,
                e => IdentityError::Database(e),
            })?;
        let session = Self::create_session(&mut tx, user, now).await?;
        tx.commit().await?;
        info!(user = %session.user.id, "account registered with a passkey");
        Ok(session)
    }

    /// Starts a discoverable sign-in: the browser offers the user's passkeys for this site.
    #[instrument(skip_all, err(Display))]
    pub async fn start_sign_in(
        &self,
        now: OffsetDateTime,
    ) -> Result<(Uuid, RequestChallengeResponse), IdentityError> {
        let (options, state) = self
            .webauthn
            .start_discoverable_authentication()
            .map_err(|e| IdentityError::Config(e.to_string()))?;
        let state = serde_json::to_value(&state).map_err(|_| IdentityError::Corrupt)?;
        let mut tx = self.db.identity().await?;
        let id = repo::begin_ceremony(
            &mut tx,
            CeremonyKind::Authentication,
            &state,
            None,
            now + CEREMONY_TTL,
        )
        .await?;
        tx.commit().await?;
        Ok((id, options))
    }

    /// Finishes a sign-in: identifies the user from the credential, verifies it against their
    /// stored passkey, records the use, and starts a session.
    #[instrument(skip_all, err(Display))]
    pub async fn finish_sign_in(
        &self,
        ceremony: Uuid,
        credential: &PublicKeyCredential,
        now: OffsetDateTime,
    ) -> Result<NewSession, IdentityError> {
        let taken = self
            .take(ceremony, CeremonyKind::Authentication, now)
            .await?;
        let state: DiscoverableAuthentication =
            serde_json::from_value(taken.state).map_err(|_| IdentityError::Corrupt)?;
        let (user_handle, credential_id) = self
            .webauthn
            .identify_discoverable_authentication(credential)
            .map_err(|_| IdentityError::Rejected)?;
        let user_id = UserId::from_uuid(user_handle);

        let mut tx = self.db.identity().await?;
        let stored = repo::passkey_for_sign_in(&mut tx, user_id, credential_id)
            .await?
            .ok_or(IdentityError::Rejected)?;
        let mut passkey: Passkey =
            serde_json::from_value(stored.passkey).map_err(|_| IdentityError::Corrupt)?;
        let result = self
            .webauthn
            .finish_discoverable_authentication(
                credential,
                state,
                &[DiscoverableKey::from(&passkey)],
            )
            .map_err(|e| {
                warn!(error = %e, "passkey sign-in rejected");
                IdentityError::Rejected
            })?;
        let updated = match passkey.update_credential(&result) {
            Some(true) => Some(serde_json::to_value(&passkey).map_err(|_| IdentityError::Corrupt)?),
            _ => None,
        };
        repo::passkey_used(&mut tx, stored.id, updated.as_ref(), now).await?;
        let user = repo::user(&mut tx, user_id)
            .await?
            .ok_or(IdentityError::Rejected)?;
        let session = Self::create_session(&mut tx, user, now).await?;
        tx.commit().await?;
        info!(user = %session.user.id, "signed in with a passkey");
        Ok(session)
    }

    /// The user of a live session, extending its idle expiry; `None` if it is unknown or over.
    pub async fn session(
        &self,
        token: &SecretString,
        now: OffsetDateTime,
    ) -> Result<Option<User>, IdentityError> {
        let mut tx = self.db.identity().await?;
        let user = repo::touch_session(
            &mut tx,
            &token_hash(token.expose_secret()),
            now,
            SESSION_IDLE,
        )
        .await?;
        tx.commit().await?;
        Ok(user)
    }

    /// Signs out. Returns whether the session existed.
    pub async fn sign_out(&self, token: &SecretString) -> Result<bool, IdentityError> {
        let mut tx = self.db.identity().await?;
        let ended = repo::delete_session(&mut tx, &token_hash(token.expose_secret())).await?;
        tx.commit().await?;
        Ok(ended)
    }

    /// Takes a ceremony in its own transaction, so a failed verification still consumes it.
    async fn take(
        &self,
        id: Uuid,
        kind: CeremonyKind,
        now: OffsetDateTime,
    ) -> Result<repo::Ceremony, IdentityError> {
        let mut tx = self.db.identity().await?;
        let taken = repo::take_ceremony(&mut tx, id, kind, now)
            .await?
            .ok_or(IdentityError::CeremonyNotFound)?;
        tx.commit().await?;
        Ok(taken)
    }

    /// Starts a session for `user` in `tx`, after ending all the user's earlier ones, so a
    /// session someone else holds does not survive the person's next sign-in (audit L8,
    /// ADR-046). Both happen in the caller's transaction: a sign-in that fails ends nothing.
    async fn create_session(
        tx: &mut db::IdentityTx,
        user: User,
        now: OffsetDateTime,
    ) -> Result<NewSession, IdentityError> {
        repo::delete_sessions_of(tx, user.id).await?;
        let raw: [u8; 32] = rand::random();
        let token = URL_SAFE_NO_PAD.encode(raw);
        let expires_at = now + SESSION_ABSOLUTE;
        repo::create_session(
            tx,
            &token_hash(&token),
            user.id,
            now + SESSION_IDLE,
            expires_at,
        )
        .await?;
        Ok(NewSession {
            token: SecretString::from(token),
            user,
            expires_at,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emails_are_trimmed_lowercased_and_checked() {
        assert_eq!(
            normalise_email("  Ada@Example.COM ").unwrap(),
            "ada@example.com"
        );
        for bad in [
            "",
            "ada",
            "@example.com",
            "ada@",
            "ada@example",
            "a b@example.com",
            "a@b@c.com",
            "ada@.com",
            "ada@example.",
        ] {
            assert!(normalise_email(bad).is_err(), "{bad:?}");
        }
        assert!(normalise_email(&format!("{}@example.com", "a".repeat(250))).is_err());
    }

    #[test]
    fn display_names_are_trimmed_and_bounded() {
        assert_eq!(normalise_name("  Ada Lovelace ").unwrap(), "Ada Lovelace");
        assert!(normalise_name("   ").is_err());
        assert!(normalise_name(&"x".repeat(101)).is_err());
        assert!(normalise_name("bad\u{0007}name").is_err());
    }

    #[test]
    fn registration_asks_for_a_discoverable_credential() {
        let webauthn = WebauthnBuilder::new(
            "app.rampsmith.test",
            &Url::parse("https://app.rampsmith.test").unwrap(),
        )
        .unwrap()
        .build()
        .unwrap();
        let (options, _) = webauthn
            .start_passkey_registration(Uuid::nil(), "ada@example.com", "Ada", None)
            .unwrap();
        let options = serde_json::to_value(require_discoverable(options).unwrap()).unwrap();
        let selection = &options["publicKey"]["authenticatorSelection"];
        assert_eq!(selection["residentKey"], "required");
        assert_eq!(selection["requireResidentKey"], true);
        assert_eq!(selection["userVerification"], "required");
    }

    #[test]
    fn token_hashes_are_sha256() {
        assert_eq!(
            token_hash("abc"),
            [
                0xba, 0x78, 0x16, 0xbf, 0x8f, 0x01, 0xcf, 0xea, 0x41, 0x41, 0x40, 0xde, 0x5d, 0xae,
                0x22, 0x23, 0xb0, 0x03, 0x61, 0xa3, 0x96, 0x17, 0x7a, 0x9c, 0xb4, 0x10, 0xff, 0x61,
                0xf2, 0x00, 0x15, 0xad
            ]
        );
    }
}
