//! A shop installed through token exchange, with mock Shopify servers, for the job tests.

#![allow(dead_code, unreachable_pub, clippy::missing_panics_doc)]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::time::Duration;

use crypto::KeyRing;
use ctl::jobs::Jobs;
use db::Db;
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use queue::{ClaimedJob, Lease};
use secrecy::SecretString;
use serde_json::{Value, json};
use shopify::{SessionTokenVerifier, TokenClient, TokenEndpoint};
use shopify_admin::{AdminEndpoint, AdminFactory};
use shopify_auth::{ShopSession, ShopifyAuth};
use sqlx::PgPool;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use time::OffsetDateTime;
use wiremock::matchers::{body_partial_json, method};
use wiremock::{Mock, MockServer, ResponseTemplate};

use super::worker_login_pool;

pub const CLIENT_ID: &str = "0123456789abcdef0123456789abcdef";
pub const SECRET: &str = "shpss_ctl_test";
pub const SHOP: &str = "demo.myshopify.com";

pub struct World {
    pub db: Db,
    pub pool: PgPool,
    pub owner: PgPool,
    /// The token endpoint.
    pub shopify: MockServer,
    /// The Admin API.
    pub admin: MockServer,
    pub jobs: Jobs,
    pub session: ShopSession,
}

/// A shop installed now, with a fresh token, run as the worker role.
pub async fn world(opts: PgPoolOptions, conn: PgConnectOptions) -> World {
    let owner = opts.clone().connect_with(conn.clone()).await.unwrap();
    let pool = worker_login_pool(opts, conn).await;
    let db = Db::from_pool(pool.clone());
    let shopify = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "access_token": "shpat_1",
            "scope": "read_products,write_products,read_files,write_files,read_content,write_content",
            "expires_in": 3600,
            "refresh_token": "shprt_1",
            "refresh_token_expires_in": 7_776_000
        })))
        .mount(&shopify)
        .await;
    let auth = ShopifyAuth::new(
        db.clone(),
        KeyRing::parse("k1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8").unwrap(),
        SessionTokenVerifier::new(CLIENT_ID, &SecretString::from(SECRET)),
        TokenClient::new(
            CLIENT_ID,
            SecretString::from("client-secret"),
            TokenEndpoint::Base(shopify.uri()),
            Duration::from_secs(2),
        )
        .unwrap(),
    );
    let now = OffsetDateTime::now_utc();
    let t = now.unix_timestamp();
    let token = encode(
        &Header::new(Algorithm::HS256),
        &json!({"iss": format!("https://{SHOP}/admin"), "dest": format!("https://{SHOP}"),
                "aud": CLIENT_ID, "sub": "1", "exp": t + 60, "nbf": t - 1}),
        &EncodingKey::from_secret(SECRET.as_bytes()),
    )
    .unwrap();
    let session = auth.authenticate_at(&token, now).await.unwrap();
    let admin = MockServer::start().await;
    let jobs = Jobs::new(
        db.clone(),
        auth,
        AdminFactory::new(AdminEndpoint::Base(admin.uri()), Duration::from_secs(5)).unwrap(),
    );
    World {
        db,
        pool,
        owner,
        shopify,
        admin,
        jobs,
        session,
    }
}

impl World {
    /// A claimed job for the shop's tenant.
    pub fn job(&self, queue: &str, schema: &str, payload: Value) -> ClaimedJob {
        ClaimedJob {
            lease: Lease {
                job_id: uuid::Uuid::now_v7(),
                worker: "test".to_owned(),
                attempt: 1,
            },
            queue: queue.to_owned(),
            payload_schema: schema.to_owned(),
            payload,
            tenant_id: Some(self.session.tenant.as_uuid()),
            max_attempts: 8,
            locked_until: OffsetDateTime::now_utc() + time::Duration::seconds(30),
            traceparent: None,
        }
    }

    /// Makes the Admin API answer every call with `status` and `body`.
    pub async fn admin_answers(&self, status: u16, body: Value) {
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(status).set_body_json(body))
            .mount(&self.admin)
            .await;
    }

    /// Makes the Admin API answer calls to `operation` with `body`.
    pub async fn admin_operation(&self, operation: &str, body: Value) {
        Mock::given(method("POST"))
            .and(body_partial_json(json!({ "operationName": operation })))
            .respond_with(ResponseTemplate::new(200).set_body_json(body))
            .mount(&self.admin)
            .await;
    }

    pub async fn count(&self, sql: &str) -> i64 {
        sqlx::query_scalar(sqlx::AssertSqlSafe(sql.to_owned()))
            .fetch_one(&self.owner)
            .await
            .unwrap()
    }
}
