//! The api skeleton (R0 step 6): liveness, readiness against the database and its schema
//! version, problem+json errors, and an OpenAPI document generated from the handlers.

// Integration tests are test code: PLAN §8 denies these lints outside tests only.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use api::AppState;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use db::Db;
use http_body_util::BodyExt;
use serde_json::Value;
use sqlx::Executor;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use tower::ServiceExt;

async fn app_db(opts: PgPoolOptions, conn: PgConnectOptions) -> Db {
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
    Db::from_pool(pool)
}

async fn get(state: AppState, path: &str) -> (StatusCode, String, Value) {
    let res = api::app(state)
        .oneshot(Request::get(path).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = res.status();
    let content_type = res
        .headers()
        .get(header::CONTENT_TYPE)
        .map(|v| v.to_str().unwrap().to_owned())
        .unwrap_or_default();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        content_type,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[sqlx::test(migrations = "../db/migrations")]
async fn liveness_answers_without_touching_the_database(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let state = AppState::new(app_db(opts, conn).await);
    let (status, _, body) = get(state, "/healthz").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "ok");
}

#[sqlx::test(migrations = "../db/migrations")]
async fn readiness_reports_the_applied_schema_version(opts: PgPoolOptions, conn: PgConnectOptions) {
    let state = AppState::new(app_db(opts, conn).await);
    let (status, _, body) = get(state, "/readyz").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], "ready");
    assert_eq!(body["schema_version"], db::expected_schema_version());
}

#[sqlx::test(migrations = "../db/migrations")]
async fn readiness_fails_while_migrations_are_behind_this_build(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let state = AppState::new(app_db(opts, conn).await).expecting_schema(i64::MAX);
    let (status, content_type, body) = get(state, "/readyz").await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(content_type, "application/problem+json");
    assert_eq!(body["code"], "unavailable");
}

#[tokio::test]
async fn readiness_fails_when_the_database_is_unreachable() {
    let pool = PgPoolOptions::new()
        .acquire_timeout(std::time::Duration::from_millis(300))
        .connect_lazy("postgres://nobody@127.0.0.1:9/none")
        .unwrap();
    let (status, content_type, body) = get(AppState::new(Db::from_pool(pool)), "/readyz").await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(content_type, "application/problem+json");
    assert_eq!(body["code"], "unavailable");
}

#[tokio::test]
async fn unknown_routes_are_problems() {
    let pool = PgPoolOptions::new()
        .connect_lazy("postgres://nobody@127.0.0.1:9/none")
        .unwrap();
    let (status, content_type, body) = get(AppState::new(Db::from_pool(pool)), "/v1/nothing").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(content_type, "application/problem+json");
    assert_eq!(body["code"], "not_found");
}

#[test]
fn the_openapi_document_describes_every_route_and_the_problem_shape() {
    let doc: Value = serde_json::from_str(&api::openapi().to_json().unwrap()).unwrap();
    assert!(doc["openapi"].as_str().unwrap().starts_with("3."));
    assert_eq!(doc["info"]["title"], "Rampsmith API");
    for path in ["/healthz", "/readyz"] {
        assert!(doc["paths"][path]["get"].is_object(), "missing {path}");
    }
    assert!(doc["components"]["schemas"]["Problem"].is_object());
    assert!(
        doc["paths"]["/readyz"]["get"]["responses"]["503"]["content"]["application/problem+json"]
            .is_object()
    );
}
