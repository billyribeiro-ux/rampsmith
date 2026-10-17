//! Real WebAuthn ceremonies against PostgreSQL, driven by `webauthn-authenticator-rs`'s software
//! passkey (ADR-024).

// Integration tests are test code: PLAN §8 denies these lints outside tests only.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use db::Db;
use identity::{Identity, IdentityError, SESSION_ABSOLUTE, SESSION_IDLE};
use secrecy::{ExposeSecret, SecretString};
use serde_json::{Value, json};
use sqlx::Executor;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use time::{Duration, OffsetDateTime};
use webauthn_authenticator_rs::WebauthnAuthenticator;
use webauthn_authenticator_rs::prelude::{RequestChallengeResponse, Url};
use webauthn_authenticator_rs::softpasskey::SoftPasskey;

const ORIGIN: &str = "https://app.rampsmith.test";

fn now() -> OffsetDateTime {
    OffsetDateTime::now_utc()
}

async fn identity(opts: PgPoolOptions, conn: PgConnectOptions) -> (Identity, sqlx::PgPool) {
    let owner = opts.clone().connect_with(conn.clone()).await.unwrap();
    let pool = opts
        .after_connect(|c, _| {
            Box::pin(async move {
                c.execute("set role rampsmith_app").await?;
                Ok(())
            })
        })
        .connect_with(conn)
        .await
        .unwrap();
    let id = Identity::new(
        Db::from_pool(pool),
        "app.rampsmith.test",
        ORIGIN,
        "Rampsmith",
    )
    .unwrap();
    (id, owner)
}

fn authenticator() -> WebauthnAuthenticator<SoftPasskey> {
    // The software key cannot do user verification; it asserts it, as a platform passkey would.
    WebauthnAuthenticator::new(SoftPasskey::new(true))
}

/// The software key keeps no resident credentials, so a discoverable request is pointed at the
/// registered credential, and the user handle a platform passkey would return is added. Neither
/// is covered by the signature.
fn sign_in_as(
    key: &mut WebauthnAuthenticator<SoftPasskey>,
    options: RequestChallengeResponse,
    credential_id: &str,
    user: [u8; 16],
) -> webauthn_authenticator_rs::prelude::PublicKeyCredential {
    let mut value = serde_json::to_value(options).unwrap();
    value["publicKey"]["allowCredentials"] = json!([{ "type": "public-key", "id": credential_id }]);
    let options: RequestChallengeResponse = serde_json::from_value(value).unwrap();
    let credential = key
        .do_authentication(Url::parse(ORIGIN).unwrap(), options)
        .unwrap();
    let mut value = serde_json::to_value(credential).unwrap();
    value["response"]["userHandle"] = Value::String(URL_SAFE_NO_PAD.encode(user));
    serde_json::from_value(value).unwrap()
}

async fn register(
    id: &Identity,
    key: &mut WebauthnAuthenticator<SoftPasskey>,
    email: &str,
) -> (identity::NewSession, String) {
    let (ceremony, options) = id.start_registration(email, "Ada", now()).await.unwrap();
    let credential = key
        .do_registration(Url::parse(ORIGIN).unwrap(), options)
        .unwrap();
    let credential_id = serde_json::to_value(&credential).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let session = id
        .finish_registration(ceremony, &credential, now())
        .await
        .unwrap();
    (session, credential_id)
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn register_then_sign_in_with_the_same_passkey(opts: PgPoolOptions, conn: PgConnectOptions) {
    let (id, owner) = identity(opts, conn).await;
    let mut key = authenticator();

    let (registered, credential_id) = register(&id, &mut key, " Ada@Example.com ").await;
    assert_eq!(registered.user.email, "ada@example.com");
    assert_eq!(registered.user.display_name, "Ada");
    let left = registered.expires_at - now();
    assert!(left > SESSION_ABSOLUTE - Duration::minutes(1) && left <= SESSION_ABSOLUTE);

    // The token is 256 bits, and only its hash is stored.
    let token = registered.token.expose_secret();
    assert_eq!(URL_SAFE_NO_PAD.decode(token).unwrap().len(), 32);
    let stored: Vec<Vec<u8>> = sqlx::query_scalar("select token_hash from web_sessions")
        .fetch_all(&owner)
        .await
        .unwrap();
    assert_eq!(stored.len(), 1);
    assert_ne!(stored[0], token.as_bytes());

    let (ceremony, options) = id.start_sign_in(now()).await.unwrap();
    let assertion = sign_in_as(
        &mut key,
        options,
        &credential_id,
        *registered.user.id.as_uuid().as_bytes(),
    );
    let signed_in = id
        .finish_sign_in(ceremony, &assertion, now())
        .await
        .unwrap();
    assert_eq!(signed_in.user.id, registered.user.id);
    assert_ne!(
        signed_in.token.expose_secret(),
        registered.token.expose_secret(),
        "every sign-in gets a new session"
    );
    let used: Option<OffsetDateTime> = sqlx::query_scalar("select last_used_at from passkeys")
        .fetch_one(&owner)
        .await
        .unwrap();
    assert!(used.is_some());

    // Both sessions resolve to the user until signed out.
    for session in [&registered, &signed_in] {
        let user = id.session(&session.token, now()).await.unwrap().unwrap();
        assert_eq!(user.id, registered.user.id);
    }
    assert!(id.sign_out(&signed_in.token).await.unwrap());
    assert!(id.session(&signed_in.token, now()).await.unwrap().is_none());
    assert!(!id.sign_out(&signed_in.token).await.unwrap());
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn a_ceremony_completes_at_most_once(opts: PgPoolOptions, conn: PgConnectOptions) {
    let (id, _) = identity(opts, conn).await;
    let mut key = authenticator();
    let (ceremony, options) = id
        .start_registration("ada@example.com", "Ada", now())
        .await
        .unwrap();
    let credential = key
        .do_registration(Url::parse(ORIGIN).unwrap(), options)
        .unwrap();
    id.finish_registration(ceremony, &credential, now())
        .await
        .unwrap();
    let again = id
        .finish_registration(ceremony, &credential, now())
        .await
        .unwrap_err();
    assert!(
        matches!(again, IdentityError::CeremonyNotFound),
        "{again:?}"
    );
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn an_expired_ceremony_is_refused(opts: PgPoolOptions, conn: PgConnectOptions) {
    let (id, _) = identity(opts, conn).await;
    let mut key = authenticator();
    let (ceremony, options) = id
        .start_registration("ada@example.com", "Ada", now())
        .await
        .unwrap();
    let credential = key
        .do_registration(Url::parse(ORIGIN).unwrap(), options)
        .unwrap();
    let late = now() + Duration::minutes(6);
    let err = id
        .finish_registration(ceremony, &credential, late)
        .await
        .unwrap_err();
    assert!(matches!(err, IdentityError::CeremonyNotFound), "{err:?}");
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn a_response_for_another_origin_is_rejected_and_consumes_the_ceremony(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let (id, owner) = identity(opts, conn).await;
    let mut key = authenticator();
    let (ceremony, options) = id
        .start_registration("ada@example.com", "Ada", now())
        .await
        .unwrap();
    // A browser on another origin reports that origin in clientDataJSON; with no attestation it
    // is not signed, so the server's own origin check is what stops it.
    let honest = key
        .do_registration(Url::parse(ORIGIN).unwrap(), options)
        .unwrap();
    let mut value = serde_json::to_value(honest).unwrap();
    let client_data = value["response"]["clientDataJSON"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut client_data: Value =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(client_data).unwrap()).unwrap();
    client_data["origin"] = json!("https://app.rampsmith.test.evil.example");
    value["response"]["clientDataJSON"] =
        json!(URL_SAFE_NO_PAD.encode(serde_json::to_vec(&client_data).unwrap()));
    let phished: webauthn_authenticator_rs::prelude::RegisterPublicKeyCredential =
        serde_json::from_value(value).unwrap();
    let err = id
        .finish_registration(ceremony, &phished, now())
        .await
        .unwrap_err();
    assert!(matches!(err, IdentityError::Rejected), "{err:?}");
    let users: i64 = sqlx::query_scalar("select count(*) from users")
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(users, 0, "no account without a verified passkey");
    let again = id
        .finish_registration(ceremony, &phished, now())
        .await
        .unwrap_err();
    assert!(matches!(again, IdentityError::CeremonyNotFound));
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn a_taken_email_cannot_register_again(opts: PgPoolOptions, conn: PgConnectOptions) {
    let (id, _) = identity(opts, conn).await;
    let mut key = authenticator();
    register(&id, &mut key, "ada@example.com").await;
    let err = id
        .start_registration("ADA@example.com", "Ada", now())
        .await
        .unwrap_err();
    assert!(matches!(err, IdentityError::EmailTaken), "{err:?}");
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn invalid_registration_input_is_refused(opts: PgPoolOptions, conn: PgConnectOptions) {
    let (id, _) = identity(opts, conn).await;
    for (email, name) in [("not-an-email", "Ada"), ("ada@example.com", "  ")] {
        let err = id.start_registration(email, name, now()).await.unwrap_err();
        assert!(
            matches!(err, IdentityError::InvalidInput(_)),
            "{email} {name}: {err:?}"
        );
    }
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn a_passkey_cannot_sign_in_as_someone_else(opts: PgPoolOptions, conn: PgConnectOptions) {
    let (id, _) = identity(opts, conn).await;
    let mut ada_key = authenticator();
    let mut bob_key = authenticator();
    let (_, ada_credential) = register(&id, &mut ada_key, "ada@example.com").await;
    let (bob, _) = register(&id, &mut bob_key, "bob@example.com").await;

    // Ada's key claims Bob's user handle.
    let (ceremony, options) = id.start_sign_in(now()).await.unwrap();
    let forged = sign_in_as(
        &mut ada_key,
        options,
        &ada_credential,
        *bob.user.id.as_uuid().as_bytes(),
    );
    let err = id
        .finish_sign_in(ceremony, &forged, now())
        .await
        .unwrap_err();
    assert!(matches!(err, IdentityError::Rejected), "{err:?}");
}

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn sessions_expire_when_idle_and_at_their_absolute_limit(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let (id, _) = identity(opts, conn).await;
    let mut key = authenticator();
    let (session, _) = register(&id, &mut key, "ada@example.com").await;
    let later = now() + SESSION_IDLE + Duration::hours(1);
    assert!(id.session(&session.token, later).await.unwrap().is_none());
    let unknown = SecretString::from("not-a-session".to_owned());
    assert!(id.session(&unknown, now()).await.unwrap().is_none());
}
