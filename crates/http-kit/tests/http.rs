//! Every error leaves a Rampsmith service as RFC 9457 problem+json (PLAN §8), and every
//! request carries an id and a span.

// Integration tests are test code: PLAN §8 denies these lints outside tests only.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use axum::routing::{get, post};
use contracts::ProblemCode;
use http_body_util::BodyExt;
use http_kit::{ApiError, Limits, with_middleware};
use serde_json::Value;
use tower::ServiceExt;

const PROBLEM: &str = "application/problem+json";

async fn boom() -> &'static str {
    panic!("secret panic message with a token sk_live_123")
}

fn app() -> Router {
    let router = Router::new()
        .route("/ok", get(|| async { "ok" }))
        .route(
            "/missing",
            get(|| async {
                Err::<(), _>(ApiError::new(ProblemCode::NotFound).detail("no such site"))
            }),
        )
        .route("/boom", get(boom))
        .route(
            "/slow",
            get(|| async {
                tokio::time::sleep(Duration::from_millis(500)).await;
                "late"
            }),
        )
        .route("/echo", post(|body: String| async move { body }));
    with_middleware(
        router,
        Limits {
            request_timeout: Duration::from_millis(100),
            body_bytes: 1024,
        },
    )
}

async fn send(req: Request<Body>) -> (StatusCode, axum::http::HeaderMap, Value) {
    let res = app().oneshot(req).await.unwrap();
    let status = res.status();
    let headers = res.headers().clone();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    let json = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, headers, json)
}

fn get_req(path: &str) -> Request<Body> {
    Request::get(path).body(Body::empty()).unwrap()
}

#[tokio::test]
async fn an_api_error_becomes_problem_json() {
    let (status, headers, body) = send(get_req("/missing")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(headers[header::CONTENT_TYPE], PROBLEM);
    assert_eq!(body["type"], "/problems/not_found");
    assert_eq!(body["code"], "not_found");
    assert_eq!(body["status"], 404);
    assert_eq!(body["detail"], "no such site");
}

#[tokio::test]
async fn an_unknown_route_is_a_problem_not_an_empty_404() {
    let (status, headers, body) = send(get_req("/nope")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(headers[header::CONTENT_TYPE], PROBLEM);
    assert_eq!(body["code"], "not_found");
}

#[tokio::test]
async fn a_panic_is_a_500_problem_that_leaks_nothing() {
    let (status, headers, body) = send(get_req("/boom")).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(headers[header::CONTENT_TYPE], PROBLEM);
    assert_eq!(body["code"], "internal");
    assert!(!body.to_string().contains("sk_live"), "{body}");
    assert!(!body.to_string().contains("secret"), "{body}");
}

#[tokio::test]
async fn a_slow_handler_times_out_as_a_problem() {
    let (status, headers, body) = send(get_req("/slow")).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(headers[header::CONTENT_TYPE], PROBLEM);
    assert_eq!(body["code"], "unavailable");
}

#[tokio::test]
async fn an_oversized_body_is_rejected_as_a_problem() {
    let req = Request::post("/echo")
        .body(Body::from("x".repeat(2048)))
        .unwrap();
    let (status, headers, body) = send(req).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(headers[header::CONTENT_TYPE], PROBLEM);
    assert_eq!(body["code"], "payload_too_large");
}

#[tokio::test]
async fn successful_responses_are_untouched() {
    let res = app().oneshot(get_req("/ok")).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(&bytes[..], b"ok");
}

#[tokio::test]
async fn every_response_carries_a_request_id_and_keeps_a_caller_supplied_one() {
    let res = app().oneshot(get_req("/ok")).await.unwrap();
    let id = res.headers()["x-request-id"].to_str().unwrap().to_owned();
    let parsed = uuid::Uuid::parse_str(&id).expect("a UUID");
    assert_eq!(parsed.get_version_num(), 7);

    let req = Request::get("/ok")
        .header("x-request-id", "caller-123")
        .body(Body::empty())
        .unwrap();
    let res = app().oneshot(req).await.unwrap();
    assert_eq!(res.headers()["x-request-id"], "caller-123");
}

#[tokio::test]
async fn database_errors_never_leak_their_details() {
    let cases = [
        (
            db::DbError::Conflict("fixes_pkey".to_owned()),
            StatusCode::CONFLICT,
            "conflict",
        ),
        (
            db::DbError::Invalid("fixes_kind_check".to_owned()),
            StatusCode::UNPROCESSABLE_ENTITY,
            "validation_failed",
        ),
        (db::DbError::Forbidden, StatusCode::FORBIDDEN, "forbidden"),
        (
            db::DbError::Corrupt {
                what: "sites.platform",
            },
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
        ),
    ];
    for (error, status, code) in cases {
        let api: ApiError = error.into();
        let res = axum::response::IntoResponse::into_response(api);
        assert_eq!(res.status(), status);
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["code"], code);
        let text = body.to_string();
        assert!(
            !text.contains("fixes_") && !text.contains("sites."),
            "{text}"
        );
    }
}
