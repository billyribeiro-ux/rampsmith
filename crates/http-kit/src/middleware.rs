use std::any::Any;
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::extract::{MatchedPath, Request};
use axum::http::{HeaderName, Response, StatusCode, header};
use axum::response::IntoResponse;
use contracts::ProblemCode;
use tower::ServiceBuilder;
use tower_http::catch_panic::CatchPanicLayer;
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::request_id::{
    MakeRequestId, PropagateRequestIdLayer, RequestId, SetRequestIdLayer,
};
use tower_http::sensitive_headers::SetSensitiveRequestHeadersLayer;
use tower_http::timeout::TimeoutLayer;
use tower_http::trace::TraceLayer;
use tracing::error;

use crate::ApiError;

/// Request limits applied to every route.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    /// Longest a request may take before it is answered `503 unavailable`.
    pub request_timeout: Duration,
    /// Largest request body accepted, in bytes.
    pub body_bytes: usize,
}

impl Default for Limits {
    /// 30 seconds and 1 MiB: webhooks and API calls are small, and Shopify expects a webhook
    /// answer within seconds (PLAN §14).
    fn default() -> Self {
        Self {
            request_timeout: Duration::from_secs(30),
            body_bytes: 1024 * 1024,
        }
    }
}

/// UUIDv7 request ids, so ids sort by arrival.
#[derive(Debug, Clone, Copy, Default)]
struct UuidV7;

impl MakeRequestId for UuidV7 {
    fn make_request_id<B>(&mut self, _request: &axum::http::Request<B>) -> Option<RequestId> {
        uuid::Uuid::now_v7()
            .to_string()
            .parse()
            .ok()
            .map(RequestId::new)
    }
}

/// Headers whose values never reach logs or spans (PLAN §18).
fn sensitive_headers() -> [HeaderName; 7] {
    [
        header::AUTHORIZATION,
        header::PROXY_AUTHORIZATION,
        header::COOKIE,
        header::SET_COOKIE,
        HeaderName::from_static("x-shopify-hmac-sha256"),
        HeaderName::from_static("x-hub-signature-256"),
        HeaderName::from_static("stripe-signature"),
    ]
}

fn panic_response(_panic: Box<dyn Any + Send + 'static>) -> Response<Body> {
    // The payload can hold anything, including secrets; it is neither logged nor returned.
    error!("handler panicked");
    ApiError::new(ProblemCode::Internal).into_response()
}

/// Rewrites bodiless error responses from layers (timeout, body limit) and unmatched
/// routes into problem+json, so no error leaves without the RFC 9457 shape.
async fn problem_for_bare_errors<B>(response: Response<B>) -> Response<Body>
where
    B: axum::body::HttpBody<Data = axum::body::Bytes> + Send + 'static,
    B::Error: Into<axum::BoxError>,
{
    let status = response.status();
    let is_problem = response
        .headers()
        .get(header::CONTENT_TYPE)
        .is_some_and(|v| v.as_bytes() == crate::PROBLEM_JSON.as_bytes());
    if !(status.is_client_error() || status.is_server_error()) || is_problem {
        return response.map(Body::new);
    }
    let code = match status {
        StatusCode::BAD_REQUEST => ProblemCode::BadRequest,
        StatusCode::UNAUTHORIZED => ProblemCode::Unauthenticated,
        StatusCode::FORBIDDEN => ProblemCode::Forbidden,
        StatusCode::NOT_FOUND | StatusCode::METHOD_NOT_ALLOWED => ProblemCode::NotFound,
        StatusCode::CONFLICT => ProblemCode::Conflict,
        StatusCode::PAYLOAD_TOO_LARGE => ProblemCode::PayloadTooLarge,
        StatusCode::UNPROCESSABLE_ENTITY => ProblemCode::ValidationFailed,
        StatusCode::TOO_MANY_REQUESTS => ProblemCode::RateLimited,
        StatusCode::BAD_GATEWAY | StatusCode::GATEWAY_TIMEOUT => ProblemCode::UpstreamFailed,
        StatusCode::SERVICE_UNAVAILABLE | StatusCode::REQUEST_TIMEOUT => ProblemCode::Unavailable,
        _ if status.is_client_error() => ProblemCode::BadRequest,
        _ => ProblemCode::Internal,
    };
    ApiError::new(code).into_response()
}

fn request_span(request: &Request) -> tracing::Span {
    let route = request
        .extensions()
        .get::<MatchedPath>()
        .map_or("unmatched", MatchedPath::as_str);
    let request_id = request
        .headers()
        .get("x-request-id")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    tracing::info_span!(
        "http.request",
        http.request.method = %request.method(),
        http.route = route,
        request_id,
        otel.kind = "server",
        http.response.status_code = tracing::field::Empty,
    )
}

/// Applies the standard stack to `router`. Order, outermost first: request id, sensitive
/// header redaction, span, problem rewriting, panic catching, timeout, body limit.
pub fn with_middleware<S>(router: Router<S>, limits: Limits) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    let x_request_id = HeaderName::from_static("x-request-id");
    router
        .fallback(|| async { ApiError::new(ProblemCode::NotFound) })
        .layer(
            ServiceBuilder::new()
                .layer(SetRequestIdLayer::new(x_request_id.clone(), UuidV7))
                .layer(PropagateRequestIdLayer::new(x_request_id))
                .layer(SetSensitiveRequestHeadersLayer::new(sensitive_headers()))
                .layer(
                    TraceLayer::new_for_http()
                        .make_span_with(request_span)
                        .on_response(
                            |response: &Response<Body>,
                             _latency: Duration,
                             span: &tracing::Span| {
                                span.record(
                                    "http.response.status_code",
                                    response.status().as_u16(),
                                );
                            },
                        ),
                )
                .layer(axum::middleware::map_response(problem_for_bare_errors))
                .layer(CatchPanicLayer::custom(panic_response))
                .layer(TimeoutLayer::with_status_code(
                    StatusCode::SERVICE_UNAVAILABLE,
                    limits.request_timeout,
                ))
                .layer(RequestBodyLimitLayer::new(limits.body_bytes)),
        )
}
