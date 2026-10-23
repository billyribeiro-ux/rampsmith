//! The GitHub channel's routes (ADR-290, ADR-291): the install flow bound to the signed-in store
//! through a single-use state (audit L7), the plan and flag gates, and choosing the theme
//! repository. GitHub is a fake server; the user token it hands out is never stored.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::time::Duration;

use api::AppState;
use api::config::GithubSettings;
use api::github_channel::GithubChannel;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use crypto::KeyRing;
use db::Db;
use github::ClientConfig;
use http_body_util::BodyExt;
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use secrecy::SecretString;
use serde_json::{Value, json};
use shopify::{SessionTokenVerifier, TokenClient, TokenEndpoint};
use shopify_auth::ShopifyAuth;
use sqlx::PgPool;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use tower::ServiceExt;
use uuid::Uuid;
use wiremock::matchers::{body_partial_json, header as header_is, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

mod support;

use support::app_login_pool;

const CLIENT_ID: &str = "0123456789abcdef0123456789abcdef";
const SECRET: &str = "shpss_api_test";
const SHOP: &str = "demo-store.myshopify.com";
const STAFF: &str = "42";
const KEYS: &str = "k1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const USER_TOKEN: &str = "ghu_user_token_for_tests";
const INSTALLATION: u64 = 4242;
const GOOD_CODE: &str = "good-code-1";

struct Harness {
    app: AppState,
    owner: PgPool,
    tenant: Uuid,
    shop: Uuid,
    github: MockServer,
    _shopify: MockServer,
}

struct Answer {
    status: StatusCode,
    body: Value,
}

fn id_token(sub: &str) -> String {
    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    encode(
        &Header::new(Algorithm::HS256),
        &json!({
            "iss": format!("https://{SHOP}/admin"), "dest": format!("https://{SHOP}"),
            "aud": CLIENT_ID, "exp": now + 60, "nbf": now - 1, "iat": now - 1,
            "jti": "j", "sid": "s", "sub": sub
        }),
        &EncodingKey::from_secret(SECRET.as_bytes()),
    )
    .unwrap()
}

/// `reachable`: the installation ids the fake lets the signed-in GitHub user see.
async fn harness(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
    channel_on: bool,
    plan: Option<&str>,
    reachable: &[u64],
) -> Harness {
    let owner = opts.clone().connect_with(conn.clone()).await.unwrap();
    let shopify = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "access_token": "shpat_a", "scope": "read_products,write_products",
            "expires_in": 3600, "refresh_token": "shprt_r", "refresh_token_expires_in": 7_776_000
        })))
        .mount(&shopify)
        .await;
    let github = MockServer::start().await;
    mount_github(&github, reachable).await;
    let db = Db::from_pool(app_login_pool(opts, conn).await);
    let auth = ShopifyAuth::new(
        db.clone(),
        KeyRing::parse(KEYS).unwrap(),
        SessionTokenVerifier::new(CLIENT_ID, &SecretString::from(SECRET)),
        TokenClient::new(
            CLIENT_ID,
            SecretString::from("client-secret"),
            TokenEndpoint::Base(shopify.uri()),
            Duration::from_secs(2),
        )
        .unwrap(),
    );
    let mut app = AppState::new(db).with_shopify(auth);
    if channel_on {
        let settings = GithubSettings {
            client_id: "Iv23liTest".to_owned(),
            client_secret: SecretString::from("gh-client-secret"),
            webhook_secret: SecretString::from("unused"),
            webhook_secret_previous: None,
        };
        let config = ClientConfig {
            base_url: github.uri(),
            oauth_base_url: github.uri(),
            ..ClientConfig::default()
        };
        app = app.with_github(GithubChannel::new(&settings, config).unwrap());
    }
    let installed = api::app(app.clone())
        .oneshot(
            Request::post("/v1/shopify/session")
                .header(header::AUTHORIZATION, format!("Bearer {}", id_token(STAFF)))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(installed.status(), StatusCode::OK);
    let (tenant, shop): (Uuid, Uuid) =
        sqlx::query_as("select tenant_id, id from shopify_shops where shop_domain = $1")
            .bind(SHOP)
            .fetch_one(&owner)
            .await
            .unwrap();
    if let Some(plan) = plan {
        sqlx::query(
            "insert into shop_billing (shop_id, tenant_id, standing, plan, plan_interval,
                                       last_confirmed_at)
             values ($1, $2, 'paid', $3, 'monthly', now())",
        )
        .bind(shop)
        .bind(tenant)
        .bind(plan)
        .execute(&owner)
        .await
        .unwrap();
    }
    Harness {
        app,
        owner,
        tenant,
        shop,
        github,
        _shopify: shopify,
    }
}

async fn mount_github(server: &MockServer, reachable: &[u64]) {
    Mock::given(method("POST"))
        .and(path("/login/oauth/access_token"))
        .and(body_partial_json(
            json!({"code": GOOD_CODE, "client_secret": "gh-client-secret"}),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "access_token": USER_TOKEN, "token_type": "bearer", "scope": ""
        })))
        .mount(server)
        .await;
    // A refused code is a 200 with an `error` member, as GitHub answers.
    Mock::given(method("POST"))
        .and(path("/login/oauth/access_token"))
        .and(body_partial_json(json!({"code": "refused-code"})))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "error": "bad_verification_code", "error_description": "The code passed is incorrect or expired."
        })))
        .mount(server)
        .await;
    let installations: Vec<Value> = reachable
        .iter()
        .map(|id| {
            json!({"id": id, "app_id": 1, "repository_selection": "selected",
                   "account": {"id": 7, "login": "octo", "type": "User"}})
        })
        .collect();
    Mock::given(method("GET"))
        .and(path("/user/installations"))
        .and(header_is(
            "authorization",
            format!("Bearer {USER_TOKEN}").as_str(),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "total_count": installations.len(), "installations": installations
        })))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/user"))
        .and(header_is(
            "authorization",
            format!("Bearer {USER_TOKEN}").as_str(),
        ))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({"login": "octocat", "id": 9})),
        )
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path(format!(
            "/user/installations/{INSTALLATION}/repositories"
        )))
        .and(header_is(
            "authorization",
            format!("Bearer {USER_TOKEN}").as_str(),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "total_count": 2,
            "repositories": [
                {"id": 101, "full_name": "octo/theme", "default_branch": "main", "private": true,
                 "archived": false, "permissions": {"admin": false, "push": true}},
                {"id": 102, "full_name": "octo/readonly", "default_branch": "main", "private": true,
                 "archived": false, "permissions": {"admin": false, "push": false}}
            ]
        })))
        .mount(server)
        .await;
}

impl Harness {
    async fn call(&self, verb: &str, uri: &str, body: Option<Value>) -> Answer {
        let mut request = Request::builder()
            .method(verb)
            .uri(uri)
            .header(header::AUTHORIZATION, format!("Bearer {}", id_token(STAFF)));
        let body = match body {
            Some(value) => {
                request = request.header(header::CONTENT_TYPE, "application/json");
                Body::from(value.to_string())
            }
            None => Body::empty(),
        };
        self.send(request.body(body).unwrap()).await
    }

    /// A call with no Shopify session, as the web server's callback forwarding makes.
    async fn callback(&self, body: Value) -> Answer {
        self.send(
            Request::post("/v1/github/callback")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
    }

    async fn send(&self, request: Request<Body>) -> Answer {
        let res = api::app(self.app.clone()).oneshot(request).await.unwrap();
        let status = res.status();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        Answer {
            status,
            body: serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        }
    }

    async fn state(&self) -> String {
        let started = self
            .call("POST", "/v1/shopify/code-fixes/connection", None)
            .await;
        assert_eq!(started.status, StatusCode::OK, "{}", started.body);
        started.body["state"].as_str().unwrap().to_owned()
    }

    async fn connect(&self) -> String {
        let state = self.state().await;
        let done = self
            .callback(json!({"state": state, "code": GOOD_CODE, "installation_id": INSTALLATION}))
            .await;
        assert_eq!(done.status, StatusCode::OK, "{}", done.body);
        state
    }

    async fn count(&self, sql: &str) -> i64 {
        sqlx::query_scalar(sqlx::AssertSqlSafe(sql.to_owned()))
            .fetch_one(&self.owner)
            .await
            .unwrap()
    }
}

#[sqlx::test(migrations = "../db/migrations")]
async fn while_the_channel_is_off_the_screen_says_so_and_every_other_route_is_404(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = harness(opts, conn, false, Some("growth"), &[INSTALLATION]).await;
    let screen = h.call("GET", "/v1/shopify/code-fixes", None).await;
    assert_eq!(screen.status, StatusCode::OK, "{}", screen.body);
    assert_eq!(screen.body["enabled"], false);
    assert!(screen.body["connection"].is_null());
    assert_eq!(
        h.call("POST", "/v1/shopify/code-fixes/connection", None)
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        h.callback(json!({"state": "x".repeat(43), "code": GOOD_CODE, "installation_id": 1}))
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        h.count("select count(*) from github_install_states").await,
        0
    );
}

#[sqlx::test(migrations = "../db/migrations")]
async fn a_plan_without_pull_requests_cannot_connect(opts: PgPoolOptions, conn: PgConnectOptions) {
    let h = harness(opts, conn, true, None, &[INSTALLATION]).await;
    let screen = h.call("GET", "/v1/shopify/code-fixes", None).await;
    assert_eq!(screen.body["enabled"], true);
    assert_eq!(screen.body["plan"]["gate"], "locked");
    assert_eq!(screen.body["plan"]["unlocked_by"], "starter");
    let refused = h
        .call("POST", "/v1/shopify/code-fixes/connection", None)
        .await;
    assert_eq!(refused.status, StatusCode::FORBIDDEN, "{}", refused.body);
    assert_eq!(
        h.count("select count(*) from github_install_states").await,
        0
    );
    let batch = h
        .call("POST", "/v1/shopify/code-fixes/batches", Some(json!({})))
        .await;
    assert_eq!(batch.status, StatusCode::FORBIDDEN, "{}", batch.body);
    assert_eq!(h.count("select count(*) from code_fix_batches").await, 0);
}

#[sqlx::test(migrations = "../db/migrations")]
async fn the_install_flow_links_the_store_that_started_it_and_the_state_works_once(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = harness(opts, conn, true, Some("starter"), &[INSTALLATION]).await;
    let state = h.connect().await;
    // The installation belongs to the tenant that pressed the button, recorded with who did.
    let (tenant, by_ref, by_github): (Uuid, Option<String>, Option<String>) = sqlx::query_as(
        "select tenant_id, connected_by_ref, connected_by_github from github_installations",
    )
    .fetch_one(&h.owner)
    .await
    .unwrap();
    assert_eq!(tenant, h.tenant);
    assert_eq!(by_ref.as_deref(), Some("shopify:42"));
    assert_eq!(by_github.as_deref(), Some("octocat"));
    // The state is stored as a digest only, and it is spent.
    let stored: Vec<u8> = sqlx::query_scalar("select state_sha256 from github_install_states")
        .fetch_one(&h.owner)
        .await
        .unwrap();
    assert_ne!(stored, state.as_bytes());
    let replay = h
        .callback(json!({"state": state, "code": GOOD_CODE, "installation_id": INSTALLATION}))
        .await;
    assert_eq!(replay.status, StatusCode::BAD_REQUEST, "{}", replay.body);
    // Syncing was queued, and the audit trail names the connection.
    assert_eq!(
        h.count("select count(*) from jobs where queue = 'github.sync_installation'")
            .await,
        1
    );
    assert_eq!(
        h.count("select count(*) from audit_log where action = 'github.connected'")
            .await,
        1
    );
    // No token of any kind reached the database.
    let leaked: i64 = sqlx::query_scalar(
        "select count(*) from github_installations g, jobs j
          where j.payload::text like '%ghu_%' or g.account_login like '%ghu_%'",
    )
    .fetch_one(&h.owner)
    .await
    .unwrap();
    assert_eq!(leaked, 0);

    let screen = h.call("GET", "/v1/shopify/code-fixes", None).await;
    assert_eq!(screen.body["plan"]["gate"], "allowed");
    assert_eq!(screen.body["connection"]["account"], "octo");
    assert_eq!(screen.body["connection"]["connected_by"], "octocat");
    let repos = screen.body["repositories"].as_array().unwrap();
    assert_eq!(repos.len(), 2);
    let theme = repos
        .iter()
        .find(|r| r["full_name"] == "octo/theme")
        .unwrap();
    let readonly = repos
        .iter()
        .find(|r| r["full_name"] == "octo/readonly")
        .unwrap();
    assert_eq!(theme["can_push"], true);
    assert_eq!(readonly["can_push"], false);
}

#[sqlx::test(migrations = "../db/migrations")]
async fn a_state_nobody_issued_or_with_a_different_echo_links_nothing(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = harness(opts, conn, true, Some("starter"), &[INSTALLATION]).await;
    let forged = h
        .callback(
            json!({"state": "A".repeat(43), "code": GOOD_CODE, "installation_id": INSTALLATION}),
        )
        .await;
    assert_eq!(forged.status, StatusCode::BAD_REQUEST);
    let malformed = h
        .callback(json!({"state": "short", "code": GOOD_CODE, "installation_id": INSTALLATION}))
        .await;
    assert_eq!(malformed.status, StatusCode::BAD_REQUEST);
    // GitHub echoed another state than the browser's cookie: refused, and the real state is
    // not burned by an attacker's attempt.
    let state = h.state().await;
    let mismatch = h
        .callback(
            json!({"state": state, "echoed_state": "B".repeat(43), "code": GOOD_CODE,
                         "installation_id": INSTALLATION}),
        )
        .await;
    assert_eq!(mismatch.status, StatusCode::BAD_REQUEST);
    assert_eq!(
        h.count("select count(*) from github_installations").await,
        0
    );
    let fine = h
        .callback(
            json!({"state": state, "echoed_state": state, "code": GOOD_CODE,
                         "installation_id": INSTALLATION}),
        )
        .await;
    assert_eq!(fine.status, StatusCode::OK, "{}", fine.body);
}

#[sqlx::test(migrations = "../db/migrations")]
async fn an_installation_the_github_user_cannot_reach_is_refused(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    // The person can reach installation 1 only; the request names someone else's, 4242.
    let h = harness(opts, conn, true, Some("starter"), &[1]).await;
    let state = h.state().await;
    let refused = h
        .callback(json!({"state": state, "code": GOOD_CODE, "installation_id": INSTALLATION}))
        .await;
    assert_eq!(refused.status, StatusCode::FORBIDDEN, "{}", refused.body);
    assert_eq!(
        h.count("select count(*) from github_installations").await,
        0
    );
    // The state was spent by the attempt.
    let again = h
        .callback(json!({"state": state, "code": GOOD_CODE, "installation_id": 1}))
        .await;
    assert_eq!(again.status, StatusCode::BAD_REQUEST);
}

#[sqlx::test(migrations = "../db/migrations")]
async fn a_refused_code_links_nothing_and_spends_the_state(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = harness(opts, conn, true, Some("starter"), &[INSTALLATION]).await;
    let state = h.state().await;
    let refused = h
        .callback(json!({"state": state, "code": "refused-code", "installation_id": INSTALLATION}))
        .await;
    assert_eq!(refused.status, StatusCode::BAD_REQUEST, "{}", refused.body);
    assert_eq!(
        h.count("select count(*) from github_installations").await,
        0
    );
    assert_eq!(
        h.count("select count(*) from github_install_states where used_at is not null")
            .await,
        1
    );
}

#[sqlx::test(migrations = "../db/migrations")]
async fn the_theme_repository_must_be_one_the_installer_could_push_to(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = harness(opts, conn, true, Some("starter"), &[INSTALLATION]).await;
    h.connect().await;
    let screen = h.call("GET", "/v1/shopify/code-fixes", None).await;
    let id_of = |name: &str| {
        screen.body["repositories"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["full_name"] == name)
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let choose =
        |repo: String, branch: &str| json!({"repository_id": repo, "connected_branch": branch});
    let readonly = h
        .call(
            "PUT",
            "/v1/shopify/code-fixes/repository",
            Some(choose(id_of("octo/readonly"), "main")),
        )
        .await;
    assert_eq!(readonly.status, StatusCode::FORBIDDEN, "{}", readonly.body);
    let bad_branch = h
        .call(
            "PUT",
            "/v1/shopify/code-fixes/repository",
            Some(choose(id_of("octo/theme"), "../main")),
        )
        .await;
    assert_eq!(
        bad_branch.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{}",
        bad_branch.body
    );
    let unknown = h
        .call(
            "PUT",
            "/v1/shopify/code-fixes/repository",
            Some(choose(Uuid::now_v7().to_string(), "main")),
        )
        .await;
    assert_eq!(unknown.status, StatusCode::NOT_FOUND);
    let chosen = h
        .call(
            "PUT",
            "/v1/shopify/code-fixes/repository",
            Some(choose(id_of("octo/theme"), "main")),
        )
        .await;
    assert_eq!(chosen.status, StatusCode::OK, "{}", chosen.body);
    let first = &chosen.body["repositories"][0];
    assert_eq!(first["full_name"], "octo/theme");
    assert_eq!(first["selected"], true);
    assert_eq!(first["connected_branch"], "main");
    assert_eq!(first["theme_state"], "unchecked");
    assert_eq!(
        h.count("select count(*) from jobs where queue = 'github.check_repository'")
            .await,
        1
    );
}

#[sqlx::test(migrations = "../db/migrations")]
async fn disconnecting_ends_the_link_and_forgets_the_choice(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = harness(opts, conn, true, Some("starter"), &[INSTALLATION]).await;
    h.connect().await;
    let gone = h
        .call("DELETE", "/v1/shopify/code-fixes/connection", None)
        .await;
    assert_eq!(gone.status, StatusCode::OK, "{}", gone.body);
    assert!(gone.body["connection"].is_null());
    assert_eq!(gone.body["repositories"], serde_json::json!([]));
    assert_eq!(
        h.count("select count(*) from github_installations where status = 'deleted'")
            .await,
        1
    );
    // It can be connected again, with a new state.
    h.connect().await;
    let screen = h.call("GET", "/v1/shopify/code-fixes", None).await;
    assert_eq!(screen.body["connection"]["account"], "octo");
    let _ = (&h.github, h.shop);
}

#[sqlx::test(migrations = "../db/migrations")]
async fn while_the_flag_is_off_a_request_for_pull_requests_is_404(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = harness(opts, conn, false, Some("growth"), &[INSTALLATION]).await;
    assert_eq!(
        h.call("POST", "/v1/shopify/code-fixes/batches", Some(json!({})))
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(h.count("select count(*) from code_fix_batches").await, 0);
}

/// Connects, chooses `octo/theme` on `main` and marks the theme check done.
async fn ready_theme(h: &Harness) {
    h.connect().await;
    let screen = h.call("GET", "/v1/shopify/code-fixes", None).await;
    let repo = screen.body["repositories"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["full_name"] == "octo/theme")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let chosen = h
        .call(
            "PUT",
            "/v1/shopify/code-fixes/repository",
            Some(json!({"repository_id": repo, "connected_branch": "main"})),
        )
        .await;
    assert_eq!(chosen.status, StatusCode::OK, "{}", chosen.body);
    sqlx::query("update github_repos set theme_state = 'ok' where selected")
        .execute(&h.owner)
        .await
        .unwrap();
}

#[sqlx::test(migrations = "../db/migrations")]
async fn a_request_for_pull_requests_is_gated_by_flag_plan_and_theme_and_runs_one_at_a_time(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = harness(opts, conn, true, Some("starter"), &[INSTALLATION]).await;
    // No repository yet.
    let early = h
        .call("POST", "/v1/shopify/code-fixes/batches", Some(json!({})))
        .await;
    assert_eq!(early.status, StatusCode::CONFLICT, "{}", early.body);
    ready_theme(&h).await;

    // A judgement that is not well formed is refused before anything is stored.
    for bad in [
        json!({"judgements": [{"finding_id": "nope"}]}),
        json!({"judgements": [{"finding_id": Uuid::now_v7(), "label": {"key": "Bad Key", "text": "Cart"}}]}),
        json!({"judgements": [{"finding_id": Uuid::now_v7(), "id": "has space"}]}),
        json!({"judgements": [], "extra": 1}),
    ] {
        let refused = h
            .call("POST", "/v1/shopify/code-fixes/batches", Some(bad))
            .await;
        assert!(
            refused.status == StatusCode::UNPROCESSABLE_ENTITY
                || refused.status == StatusCode::BAD_REQUEST,
            "{} {}",
            refused.status,
            refused.body
        );
    }
    assert_eq!(h.count("select count(*) from code_fix_batches").await, 0);

    let label = json!({"key": "general.cart", "text": "Cart"});
    let accepted = h
        .call(
            "POST",
            "/v1/shopify/code-fixes/batches",
            Some(json!({"judgements": [{"finding_id": Uuid::now_v7(), "label": label}]})),
        )
        .await;
    assert_eq!(accepted.status, StatusCode::ACCEPTED, "{}", accepted.body);
    assert_eq!(accepted.body["status"], "reading");
    assert_eq!(
        accepted.body["recipes"], "core",
        "Starter has the core recipes"
    );
    assert_eq!(h.count("select count(*) from code_fix_batches").await, 1);
    assert_eq!(
        h.count("select count(*) from jobs where queue = 'github.plan_batch'")
            .await,
        1
    );

    // One at a time.
    let again = h
        .call("POST", "/v1/shopify/code-fixes/batches", Some(json!({})))
        .await;
    assert_eq!(again.status, StatusCode::CONFLICT, "{}", again.body);
    assert_eq!(h.count("select count(*) from code_fix_batches").await, 1);

    // The screen shows it.
    let screen = h.call("GET", "/v1/shopify/code-fixes", None).await;
    assert_eq!(screen.body["batches"][0]["status"], "reading");
    assert_eq!(screen.body["batches"][0]["recipes"], "core");
    assert_eq!(screen.body["pull_requests"], json!([]));
}

#[sqlx::test(migrations = "../db/migrations")]
async fn a_plan_with_every_recipe_asks_for_every_recipe(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let growth = harness(
        opts.clone(),
        conn.clone(),
        true,
        Some("growth"),
        &[INSTALLATION],
    )
    .await;
    ready_theme(&growth).await;
    let accepted = growth
        .call("POST", "/v1/shopify/code-fixes/batches", Some(json!({})))
        .await;
    assert_eq!(accepted.status, StatusCode::ACCEPTED, "{}", accepted.body);
    assert_eq!(accepted.body["recipes"], "every");
    drop(growth);
}
