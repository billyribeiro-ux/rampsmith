use std::fmt;
use std::time::Duration;

use reqwest::StatusCode;
use secrecy::{ExposeSecret, SecretString};
use serde::Deserialize;
use tracing::{debug, instrument};

use crate::ShopDomain;

const TOKEN_EXCHANGE: &str = "urn:ietf:params:oauth:grant-type:token-exchange";
const ID_TOKEN: &str = "urn:ietf:params:oauth:token-type:id_token";
const OFFLINE_TOKEN: &str = "urn:shopify:params:oauth:token-type:offline-access-token";

/// Where token requests go.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TokenEndpoint {
    /// `https://<shop>/admin/oauth/access_token`.
    Shopify,
    /// `<base>/<shop>/admin/oauth/access_token`, for tests against a mock server.
    Base(String),
}

impl TokenEndpoint {
    /// The token URL for `shop`.
    #[must_use]
    pub fn url(&self, shop: &ShopDomain) -> String {
        match self {
            Self::Shopify => format!("https://{shop}/admin/oauth/access_token"),
            Self::Base(base) => format!(
                "{}/{shop}/admin/oauth/access_token",
                base.trim_end_matches('/')
            ),
        }
    }
}

/// An expiring offline token pair. Each refresh returns a new pair; store both.
pub struct OfflineToken {
    /// The Admin API access token.
    pub access_token: SecretString,
    /// The granted scopes, a readback of `shopify.app.toml`.
    pub scopes: Vec<String>,
    /// Seconds until the access token expires, as Shopify reported (3600 today).
    pub expires_in: Duration,
    /// The refresh token.
    pub refresh_token: SecretString,
    /// Seconds until the refresh token expires (90 days when issued).
    pub refresh_token_expires_in: Duration,
}

impl fmt::Debug for OfflineToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OfflineToken")
            .field("scopes", &self.scopes)
            .field("expires_in", &self.expires_in)
            .field("refresh_token_expires_in", &self.refresh_token_expires_in)
            .finish_non_exhaustive()
    }
}

/// Why a token request failed. Response bodies are never kept: they can echo secrets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum TokenError {
    /// Exchange answered 400: the ID token is stale or invalid. Answer the browser 401 with
    /// `X-Shopify-Retry-Invalid-Session-Request: 1` so App Bridge retries with a fresh one.
    #[error("Shopify rejected the session token")]
    InvalidSubjectToken,
    /// Refresh answered 401: the grant is revoked. The merchant must open the app again.
    #[error("Shopify revoked the grant")]
    Revoked,
    /// Shopify refused the request for a reason a retry cannot fix (bad credentials, bad
    /// request). Exchange answers 401 and 403 here: the client credentials are wrong.
    #[error("Shopify rejected the token request with status {status}")]
    Rejected {
        /// The HTTP status.
        status: u16,
    },
    /// 429: try again later.
    #[error("Shopify throttled the token request")]
    RateLimited,
    /// 5xx: try again later.
    #[error("Shopify failed the token request with status {status}")]
    Upstream {
        /// The HTTP status.
        status: u16,
    },
    /// Connection failure or timeout: try again later.
    #[error("the token request did not complete")]
    Transport,
    /// The response was not an expiring offline token.
    #[error("Shopify's token response could not be read")]
    Decode,
}

impl TokenError {
    /// Whether the same request may succeed later.
    #[must_use]
    pub const fn is_retryable(self) -> bool {
        matches!(
            self,
            Self::RateLimited | Self::Upstream { .. } | Self::Transport
        )
    }
}

#[derive(Deserialize)]
struct Response {
    access_token: String,
    scope: String,
    expires_in: u64,
    refresh_token: String,
    refresh_token_expires_in: u64,
}

/// Calls Shopify's token endpoint for one app.
#[derive(Clone)]
pub struct TokenClient {
    http: reqwest::Client,
    client_id: String,
    client_secret: SecretString,
    endpoint: TokenEndpoint,
}

impl fmt::Debug for TokenClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TokenClient")
            .field("client_id", &self.client_id)
            .field("endpoint", &self.endpoint)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Copy)]
enum Grant {
    Exchange,
    Refresh,
}

impl TokenClient {
    /// A client whose requests time out after `timeout`.
    pub fn new(
        client_id: &str,
        client_secret: SecretString,
        endpoint: TokenEndpoint,
        timeout: Duration,
    ) -> Result<Self, TokenError> {
        let http = reqwest::Client::builder()
            .timeout(timeout)
            .connect_timeout(timeout)
            .user_agent(concat!("rampsmith/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|_| TokenError::Transport)?;
        Ok(Self {
            http,
            client_id: client_id.to_owned(),
            client_secret,
            endpoint,
        })
    }

    /// Exchanges a verified session token for an expiring offline token (shopify.dev,
    /// "Authenticate an embedded app without a template"). Retires every other refresh
    /// token of this app on this shop, so never run it concurrently with [`Self::refresh`]
    /// for the same shop.
    #[instrument(skip_all, fields(shop = %shop), err(Display))]
    pub async fn exchange(
        &self,
        shop: &ShopDomain,
        id_token: &str,
    ) -> Result<OfflineToken, TokenError> {
        let form = [
            ("client_id", self.client_id.as_str()),
            ("client_secret", self.client_secret.expose_secret()),
            ("grant_type", TOKEN_EXCHANGE),
            ("subject_token", id_token),
            ("subject_token_type", ID_TOKEN),
            ("requested_token_type", OFFLINE_TOKEN),
            ("expiring", "1"),
        ];
        self.post(shop, &form, Grant::Exchange).await
    }

    /// Trades a refresh token for a new pair. The presented refresh token stays usable
    /// until the new one is used, so a lost response can be retried.
    #[instrument(skip_all, fields(shop = %shop), err(Display))]
    pub async fn refresh(
        &self,
        shop: &ShopDomain,
        refresh_token: &SecretString,
    ) -> Result<OfflineToken, TokenError> {
        let form = [
            ("client_id", self.client_id.as_str()),
            ("client_secret", self.client_secret.expose_secret()),
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token.expose_secret()),
        ];
        self.post(shop, &form, Grant::Refresh).await
    }

    async fn post(
        &self,
        shop: &ShopDomain,
        form: &[(&str, &str)],
        grant: Grant,
    ) -> Result<OfflineToken, TokenError> {
        let response = self
            .http
            .post(self.endpoint.url(shop))
            .header(reqwest::header::ACCEPT, "application/json")
            .form(form)
            .send()
            .await
            .map_err(|_| TokenError::Transport)?;
        let status = response.status();
        debug!(status = status.as_u16(), "token endpoint answered");
        if !status.is_success() {
            return Err(classify(status, grant));
        }
        let body: Response = response.json().await.map_err(|e| {
            if e.is_timeout() {
                TokenError::Transport
            } else {
                TokenError::Decode
            }
        })?;
        if body.access_token.is_empty() || body.refresh_token.is_empty() {
            return Err(TokenError::Decode);
        }
        Ok(OfflineToken {
            access_token: SecretString::from(body.access_token),
            scopes: body
                .scope
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect(),
            expires_in: Duration::from_secs(body.expires_in),
            refresh_token: SecretString::from(body.refresh_token),
            refresh_token_expires_in: Duration::from_secs(body.refresh_token_expires_in),
        })
    }
}

fn classify(status: StatusCode, grant: Grant) -> TokenError {
    match (status.as_u16(), grant) {
        (400, Grant::Exchange) => TokenError::InvalidSubjectToken,
        (401, Grant::Refresh) => TokenError::Revoked,
        (429, _) => TokenError::RateLimited,
        (code, _) if status.is_server_error() => TokenError::Upstream { status: code },
        (code, _) => TokenError::Rejected { status: code },
    }
}
