//! `POST /webhooks/github` (ADR-292): the signature before anything else, one stored copy per
//! body whatever delivery id it arrives under (integration audit M1), a job enqueued in the same
//! transaction, and nothing stored while the channel is off.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::fmt::Write as _;

use api::webhooks::{self, MAX_GITHUB_BODY_BYTES, WebhookState};
use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use db::Db;
use db::repo::github::{self as store, Linked, NewInstallation};
use domain::{Platform, TenantId, TenantKind};
use hmac::{Hmac, KeyInit, Mac};
use http_body_util::BodyExt;
use secrecy::SecretString;
use serde_json::{Value, json};
use sha2::Sha256;
use sqlx::PgPool;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use tower::ServiceExt;

mod support;

use support::app_login_pool;

const SECRET: &str = "whsec-api-test-only";
const PREVIOUS: &str = "whsec-api-test-previous";
const INSTALLATION: i64 = 4242;

struct Fixture {
    router: Router,
    owner: PgPool,
}

fn sign(secret: &str, body: &[u8]) -> String {
    let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(secret.as_bytes()).unwrap();
    mac.update(body);
    mac.finalize()
        .into_bytes()
        .iter()
        .fold("sha256=".to_owned(), |mut out, b| {
            write!(out, "{b:02x}").unwrap();
            out
        })
}

async fn fixture(opts: PgPoolOptions, conn: PgConnectOptions, on: bool, link: bool) -> Fixture {
    let owner = opts.clone().connect_with(conn.clone()).await.unwrap();
    let db = Db::from_pool(app_login_pool(opts, conn).await);
    let tenant = TenantId::new();
    let mut tx = db.tenant(tenant).await.unwrap();
    db::repo::tenants::create(&mut tx, TenantKind::ShopifyStore)
        .await
        .unwrap();
    let site = db::repo::sites::create(
        &mut tx,
        &db::repo::sites::NewSite {
            platform: Platform::Shopify,
            base_url: "https://demo.example".to_owned(),
            primary_locale: "en".to_owned(),
        },
    )
    .await
    .unwrap();
    if link {
        let linked = store::link_installation(
            &mut tx,
            &NewInstallation {
                site: site.id,
                installation_id: INSTALLATION,
                account_login: "octo".to_owned(),
                account_type: "User".to_owned(),
                repository_selection: "selected".to_owned(),
                connected_by_ref: None,
                connected_by_github: "octocat".to_owned(),
            },
        )
        .await
        .unwrap();
        assert!(matches!(linked, Linked::Linked(_)));
    }
    tx.commit().await.unwrap();
    let mut state = WebhookState::new(db, SecretString::from("shopify-secret"));
    if on {
        state = state.with_github(
            github::WebhookVerifier::new(SecretString::from(SECRET))
                .unwrap()
                .with_previous(SecretString::from(PREVIOUS))
                .unwrap(),
        );
    }
    Fixture {
        router: webhooks::router(state),
        owner,
    }
}

fn pull_request(number: u64) -> Value {
    json!({
        "action": "closed",
        "number": number,
        "pull_request": {
            "id": 99, "number": number, "state": "closed", "merged": true,
            "html_url": "https://github.com/octo/theme/pull/7",
            "head": {"ref": "rampsmith/fix-b1", "sha": "a".repeat(40)},
            "base": {"ref": "main", "sha": "b".repeat(40)}
        },
        "repository": {"id": 1_296_269, "name": "theme", "full_name": "octo/theme",
                       "private": true, "owner": {"login": "octo", "id": 1, "type": "User"},
                       "default_branch": "main"},
        "installation": {"id": INSTALLATION},
        "sender": {"login": "octocat", "id": 9}
    })
}

struct Hook {
    body: Vec<u8>,
    signature: Option<String>,
    event: &'static str,
    delivery: &'static str,
    content_type: &'static str,
}

impl Hook {
    fn signed(event: &'static str, delivery: &'static str, body: &Value) -> Self {
        let body = serde_json::to_vec(body).unwrap();
        Self {
            signature: Some(sign(SECRET, &body)),
            body,
            event,
            delivery,
            content_type: "application/json",
        }
    }

    fn request(&self) -> Request<Body> {
        let mut request = Request::post("/webhooks/github")
            .header("X-GitHub-Event", self.event)
            .header("X-GitHub-Delivery", self.delivery)
            .header("Content-Type", self.content_type);
        if let Some(signature) = &self.signature {
            request = request.header("X-Hub-Signature-256", signature);
        }
        request.body(Body::from(self.body.clone())).unwrap()
    }
}

async fn send(f: &Fixture, hook: &Hook) -> StatusCode {
    let res = f.router.clone().oneshot(hook.request()).await.unwrap();
    let status = res.status();
    let _ = res.into_body().collect().await.unwrap();
    status
}

async fn stored(f: &Fixture) -> (i64, i64) {
    let events: i64 = sqlx::query_scalar("select count(*) from github_events")
        .fetch_one(&f.owner)
        .await
        .unwrap();
    let jobs: i64 =
        sqlx::query_scalar("select count(*) from jobs where queue = 'github.process_event'")
            .fetch_one(&f.owner)
            .await
            .unwrap();
    (events, jobs)
}

#[sqlx::test(migrations = "../db/migrations")]
async fn an_unsigned_or_wrongly_signed_delivery_is_401_and_stores_nothing(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let f = fixture(opts, conn, true, true).await;
    let mut hook = Hook::signed("pull_request", "d-1", &pull_request(7));
    hook.signature = None;
    assert_eq!(send(&f, &hook).await, StatusCode::UNAUTHORIZED);
    hook.signature = Some("sha256=zz".to_owned());
    assert_eq!(send(&f, &hook).await, StatusCode::UNAUTHORIZED);
    hook.signature = Some(sign("another-secret", &hook.body));
    assert_eq!(send(&f, &hook).await, StatusCode::UNAUTHORIZED);
    assert_eq!(stored(&f).await, (0, 0));
}

#[sqlx::test(migrations = "../db/migrations")]
async fn a_signed_delivery_is_stored_and_its_job_enqueued_together(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let f = fixture(opts, conn, true, true).await;
    let hook = Hook::signed("pull_request", "d-1", &pull_request(7));
    assert_eq!(send(&f, &hook).await, StatusCode::OK);
    assert_eq!(stored(&f).await, (1, 1));
    let (event, repo, digest): (String, Option<i64>, Vec<u8>) =
        sqlx::query_as("select event, repository_id, body_sha256 from github_events")
            .fetch_one(&f.owner)
            .await
            .unwrap();
    assert_eq!(event, "pull_request");
    assert_eq!(repo, Some(1_296_269));
    assert_eq!(digest.len(), 32);
    // The previous secret still verifies during a rotation.
    let mut rotated = Hook::signed("pull_request", "d-2", &pull_request(8));
    rotated.signature = Some(sign(PREVIOUS, &rotated.body));
    assert_eq!(send(&f, &rotated).await, StatusCode::OK);
    assert_eq!(stored(&f).await, (2, 2));
}

#[sqlx::test(migrations = "../db/migrations")]
async fn a_replayed_body_is_stored_once_whatever_delivery_id_it_arrives_under(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let f = fixture(opts, conn, true, true).await;
    let body = pull_request(7);
    assert_eq!(
        send(&f, &Hook::signed("pull_request", "d-1", &body)).await,
        StatusCode::OK
    );
    // GitHub's own redelivery: same id.
    assert_eq!(
        send(&f, &Hook::signed("pull_request", "d-1", &body)).await,
        StatusCode::OK
    );
    // A captured, validly signed body under a fresh id (neither header is signed).
    assert_eq!(
        send(&f, &Hook::signed("pull_request", "d-replayed", &body)).await,
        StatusCode::OK
    );
    assert_eq!(stored(&f).await, (1, 1));
}

#[sqlx::test(migrations = "../db/migrations")]
async fn events_for_unlinked_installations_and_unhandled_events_are_acknowledged_and_dropped(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let f = fixture(opts, conn, true, false).await;
    assert_eq!(
        send(&f, &Hook::signed("pull_request", "d-1", &pull_request(7))).await,
        StatusCode::OK
    );
    assert_eq!(
        send(
            &f,
            &Hook::signed("ping", "d-2", &json!({"zen": "Keep it logically awesome."}))
        )
        .await,
        StatusCode::OK
    );
    assert_eq!(stored(&f).await, (0, 0));
}

#[sqlx::test(migrations = "../db/migrations")]
async fn a_signed_delivery_with_bad_headers_or_a_body_not_shaped_like_its_event_is_400(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let f = fixture(opts, conn, true, true).await;
    // The event header is not signed: an installation body relabelled as a push does not parse.
    let relabelled = Hook::signed(
        "push",
        "d-1",
        &json!({"action": "created", "installation": {"id": INSTALLATION}}),
    );
    assert_eq!(send(&f, &relabelled).await, StatusCode::BAD_REQUEST);
    let bad_id = Hook::signed("pull_request", "not a valid id!", &pull_request(7));
    assert_eq!(send(&f, &bad_id).await, StatusCode::BAD_REQUEST);
    let mut form = Hook::signed("pull_request", "d-3", &pull_request(7));
    form.content_type = "application/x-www-form-urlencoded";
    assert_eq!(send(&f, &form).await, StatusCode::BAD_REQUEST);
    assert_eq!(stored(&f).await, (0, 0));
}

#[sqlx::test(migrations = "../db/migrations")]
async fn an_oversized_body_is_refused_before_it_is_verified(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let f = fixture(opts, conn, true, true).await;
    let mut hook = Hook::signed("push", "d-1", &json!({}));
    hook.body = vec![b' '; MAX_GITHUB_BODY_BYTES + 1];
    hook.signature = Some(sign(SECRET, &hook.body));
    assert_eq!(send(&f, &hook).await, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(stored(&f).await, (0, 0));
}

#[sqlx::test(migrations = "../db/migrations")]
async fn while_the_channel_is_off_every_delivery_is_acknowledged_and_nothing_is_stored(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let f = fixture(opts, conn, false, true).await;
    assert_eq!(
        send(&f, &Hook::signed("pull_request", "d-1", &pull_request(7))).await,
        StatusCode::OK
    );
    // Not even a bad signature is looked at: nothing is read.
    let mut unsigned = Hook::signed("pull_request", "d-2", &pull_request(7));
    unsigned.signature = None;
    assert_eq!(send(&f, &unsigned).await, StatusCode::OK);
    assert_eq!(stored(&f).await, (0, 0));
}
