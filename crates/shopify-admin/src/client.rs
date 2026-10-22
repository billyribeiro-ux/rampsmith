//! The HTTP transport: one POST per operation to
//! `https://<shop>/admin/api/2026-10/graphql.json` with `X-Shopify-Access-Token`, paced by the
//! shop's [`Throttle`], with Shopify's statuses and `errors` mapped to [`AdminError`].
//!
//! Sources, read on shopify.dev on 22 Oct 2026 (ADR-080): "GraphQL Admin API reference"
//! (endpoint, header, status codes 200/400/402/403/404/423/5xx, `extensions.code` values
//! `THROTTLED`, `ACCESS_DENIED`, `SHOP_INACTIVE`, `INTERNAL_SERVER_ERROR`) and "API rate limits"
//! (`extensions.cost`, the 1,000-point single-query ceiling).

use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use graphql_client::{QueryBody, Response};
use reqwest::{StatusCode, redirect};
use secrecy::{ExposeSecret, SecretString};
use serde::Serialize;
use serde::de::DeserializeOwned;
use shopify::ShopDomain;
use tracing::{debug, warn};

use crate::API_VERSION;
use crate::error::AdminError;
use crate::throttle::{QueryCost, Throttle, Throttles};

/// How many times a call re-runs itself after a `THROTTLED` answer before giving up.
const THROTTLE_RETRIES: u32 = 3;

/// Where Admin API calls go.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AdminEndpoint {
    /// `https://<shop>/admin/api/<version>/graphql.json`. A client built for it speaks HTTPS
    /// only.
    Shopify,
    /// `<base>/<shop>/admin/api/<version>/graphql.json`, for tests against a mock server on
    /// plain HTTP. Never use it in a deployed service.
    Base(String),
}

impl AdminEndpoint {
    /// The GraphQL URL for `shop`.
    #[must_use]
    pub fn url(&self, shop: &ShopDomain) -> String {
        match self {
            Self::Shopify => format!("https://{shop}/admin/api/{API_VERSION}/graphql.json"),
            Self::Base(base) => format!(
                "{}/{shop}/admin/api/{API_VERSION}/graphql.json",
                base.trim_end_matches('/')
            ),
        }
    }
}

/// One GraphQL operation: its name, text and a first guess at its cost.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Query {
    /// The operation name, also the key of the learned cost.
    pub(crate) name: &'static str,
    /// The document.
    pub(crate) text: &'static str,
    /// Points to reserve before the first response teaches the real cost.
    pub(crate) cost_hint: f64,
}

/// Builds clients for shops: one HTTP client, one set of buckets, shared by every job.
#[derive(Clone)]
pub struct AdminFactory {
    http: reqwest::Client,
    endpoint: AdminEndpoint,
    throttles: Throttles,
}

impl fmt::Debug for AdminFactory {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AdminFactory")
            .field("endpoint", &self.endpoint)
            .finish_non_exhaustive()
    }
}

impl AdminFactory {
    /// A factory whose calls time out after `timeout`.
    ///
    /// It never follows a redirect, because a redirected POST would resend the access token to
    /// wherever the response points; built for [`AdminEndpoint::Shopify`] it also refuses any
    /// URL that is not `https`.
    pub fn new(endpoint: AdminEndpoint, timeout: Duration) -> Result<Self, AdminError> {
        let http = reqwest::Client::builder()
            .redirect(redirect::Policy::none())
            .https_only(endpoint == AdminEndpoint::Shopify)
            .timeout(timeout)
            .connect_timeout(timeout)
            .user_agent(concat!("rampsmith/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|_| AdminError::Transport)?;
        Ok(Self {
            http,
            endpoint,
            throttles: Throttles::default(),
        })
    }

    /// A client for `shop` with its access token. The token is held as a secret and never
    /// printed.
    #[must_use]
    pub fn client(&self, shop: &ShopDomain, token: SecretString) -> AdminClient {
        AdminClient {
            http: self.http.clone(),
            url: self.endpoint.url(shop),
            token,
            throttle: self.throttles.for_shop(shop),
        }
    }
}

/// An Admin API client for one shop.
#[derive(Clone)]
pub struct AdminClient {
    http: reqwest::Client,
    url: String,
    token: SecretString,
    throttle: Arc<Throttle>,
}

impl fmt::Debug for AdminClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AdminClient").finish_non_exhaustive()
    }
}

impl AdminClient {
    /// Runs `query` and returns its `data`.
    pub(crate) async fn run<V, D>(&self, query: &Query, variables: &V) -> Result<D, AdminError>
    where
        V: Serialize + Sync,
        D: DeserializeOwned,
    {
        let mut attempt = 0;
        loop {
            self.throttle.acquire(query.name, query.cost_hint).await;
            match self.send(query, variables).await {
                Err(AdminError::Throttled { retry_after }) if attempt < THROTTLE_RETRIES => {
                    attempt += 1;
                    warn!(
                        operation = query.name,
                        attempt, "Admin API throttled; waiting"
                    );
                    tokio::time::sleep(retry_after).await;
                }
                other => return other,
            }
        }
    }

    async fn send<V, D>(&self, query: &Query, variables: &V) -> Result<D, AdminError>
    where
        V: Serialize + Sync,
        D: DeserializeOwned,
    {
        let body = QueryBody {
            variables,
            query: query.text,
            operation_name: query.name,
        };
        let response = self
            .http
            .post(&self.url)
            .header("X-Shopify-Access-Token", self.token.expose_secret())
            .header(reqwest::header::ACCEPT, "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|_| AdminError::Transport)?;
        let status = response.status();
        debug!(
            operation = query.name,
            status = status.as_u16(),
            "Admin API answered"
        );
        if !status.is_success() {
            let retry_after = response
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.trim().parse::<u64>().ok())
                .map(Duration::from_secs);
            return Err(classify(status, retry_after, &self.throttle, query));
        }
        let parsed: Response<D> = response.json().await.map_err(|e| {
            if e.is_timeout() {
                AdminError::Transport
            } else {
                AdminError::Decode
            }
        })?;
        if let Some(cost) = parsed
            .extensions
            .as_ref()
            .and_then(|e| e.get("cost"))
            .and_then(|c| serde_json::from_value::<QueryCost>(c.clone()).ok())
        {
            self.throttle.observe(query.name, &cost);
        }
        if let Some(errors) = parsed.errors.as_ref().filter(|e| !e.is_empty()) {
            let code = errors
                .iter()
                .find_map(|e| {
                    e.extensions
                        .as_ref()
                        .and_then(|x| x.get("code"))
                        .and_then(serde_json::Value::as_str)
                })
                .unwrap_or("UNKNOWN");
            return Err(match code {
                "THROTTLED" => AdminError::Throttled {
                    retry_after: self.throttle.throttled(query.name, query.cost_hint),
                },
                "ACCESS_DENIED" => AdminError::AccessDenied,
                "SHOP_INACTIVE" => AdminError::ShopUnavailable { status: 200 },
                "INTERNAL_SERVER_ERROR" => AdminError::Upstream { status: 200 },
                other => AdminError::GraphQl {
                    code: other.chars().take(40).collect(),
                },
            });
        }
        parsed.data.ok_or(AdminError::Decode)
    }
}

fn classify(
    status: StatusCode,
    retry_after: Option<Duration>,
    throttle: &Throttle,
    query: &Query,
) -> AdminError {
    match status.as_u16() {
        401 => AdminError::Unauthorized,
        402 | 423 => AdminError::ShopUnavailable {
            status: status.as_u16(),
        },
        403 => AdminError::AccessDenied,
        404 => AdminError::NotFound,
        429 => AdminError::Throttled {
            retry_after: retry_after
                .unwrap_or_else(|| throttle.throttled(query.name, query.cost_hint))
                .min(Duration::from_secs(30)),
        },
        code if status.is_server_error() => AdminError::Upstream { status: code },
        code => AdminError::Rejected { status: code },
    }
}

#[cfg(test)]
mod tests {
    use wiremock::matchers::method;
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use super::*;

    #[tokio::test]
    async fn a_factory_built_for_shopify_refuses_plain_http() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200))
            .expect(0)
            .mount(&server)
            .await;
        let mut factory =
            AdminFactory::new(AdminEndpoint::Shopify, Duration::from_secs(2)).unwrap();
        // The HTTP client was built for Shopify's endpoint; aim it at plain HTTP.
        factory.endpoint = AdminEndpoint::Base(server.uri());
        let shop = ShopDomain::parse("demo-store.myshopify.com").unwrap();
        let client = factory.client(&shop, SecretString::from("shpat_x"));
        assert_eq!(client.shop().await.unwrap_err(), AdminError::Transport);
        assert!(server.received_requests().await.unwrap().is_empty());
    }

    #[test]
    fn the_shopify_endpoint_is_the_documented_url() {
        let shop = ShopDomain::parse("demo-store.myshopify.com").unwrap();
        assert_eq!(
            AdminEndpoint::Shopify.url(&shop),
            "https://demo-store.myshopify.com/admin/api/2026-10/graphql.json"
        );
    }
}
