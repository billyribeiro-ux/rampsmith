//! The HTTP client: authentication, the pinned REST API version, spans, metrics, response
//! limits and error mapping shared by every operation (ADR-125).
//!
//! REST conventions checked on docs.github.com on 2026-10-17:
//! - `X-GitHub-Api-Version: 2026-03-10`, the newest supported version
//!   (<https://docs.github.com/en/rest/about-the-rest-api/api-versions>); requests without the
//!   header get 2022-11-28, and an unsupported version answers 410.
//! - `Accept: application/vnd.github+json`; `Authorization: Bearer` for both App JWTs and
//!   installation tokens.
//! - Rate limits answer 403 or 429; primary limits set `x-ratelimit-remaining: 0` and
//!   `x-ratelimit-reset`, secondary limits may set `retry-after`, and without it clients wait at
//!   least one minute
//!   (<https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api>).

use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use opentelemetry::KeyValue;
use opentelemetry::metrics::{Counter, Histogram};
use secrecy::ExposeSecret;
use secrecy::zeroize::Zeroizing;
use serde::Serialize;
use serde::de::DeserializeOwned;
use tokio::sync::Mutex;
use tracing::Instrument;
use url::Url;

use crate::app::AppCredentials;
use crate::clock::Clock;
use crate::error::{DecodeError, GitHubError, RateLimitKind, TransportKind};
use crate::install::{
    InstallationInfo, InstalledRepository, Listing, MAX_PAGES, OAuthApp, OAuthError,
    RepositoriesPage, TokenAnswer, UserInstallations, UserLogin, UserToken,
};
use crate::markdown::{one_line, truncate};
use crate::token::{InstallationToken, TokenResponse, TokenScope};
use crate::types::InstallationId;

/// The pinned REST API version.
pub const API_VERSION: &str = "2026-03-10";

/// GitHub's recommended media type.
pub const ACCEPT_JSON: &str = "application/vnd.github+json";

/// The raw media type, which returns blob bytes instead of base64 JSON.
pub const ACCEPT_RAW: &str = "application/vnd.github.raw+json";

/// Longest wait accepted from rate-limit headers; a primary window is one hour.
const MAX_RATE_LIMIT_WAIT: u64 = 3600;

/// Client settings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientConfig {
    /// The API root: `https://api.github.com`, or a loopback `http` URL in tests.
    pub base_url: String,
    /// The `User-Agent`, which GitHub requires.
    pub user_agent: String,
    /// Per-request timeout.
    pub timeout: Duration,
    /// Largest response body read, in bytes. Theme files and API responses are far smaller.
    pub max_response_bytes: usize,
    /// Where the user authorization code is exchanged: `https://github.com`, or a loopback
    /// `http` URL in tests.
    pub oauth_base_url: String,
}

impl Default for ClientConfig {
    fn default() -> Self {
        Self {
            base_url: "https://api.github.com".to_owned(),
            user_agent: "rampsmith".to_owned(),
            timeout: Duration::from_secs(30),
            max_response_bytes: 16 * 1024 * 1024,
            oauth_base_url: "https://github.com".to_owned(),
        }
    }
}

/// Accepts `https` URLs, and `http` only on loopback, without credentials, query or fragment.
fn validate_base_url(raw: &str) -> Result<String, GitHubError> {
    let url = Url::parse(raw).map_err(|_| GitHubError::Config("the base URL does not parse"))?;
    let loopback = matches!(
        url.host(),
        Some(url::Host::Ipv4(ip)) if ip.is_loopback()
    ) || matches!(url.host(), Some(url::Host::Ipv6(ip)) if ip.is_loopback())
        || url.host_str() == Some("localhost");
    let scheme_ok = url.scheme() == "https" || (url.scheme() == "http" && loopback);
    if !scheme_ok {
        return Err(GitHubError::Config(
            "the base URL must be https (http only on loopback)",
        ));
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(GitHubError::Config(
            "the base URL must not carry credentials, a query or a fragment",
        ));
    }
    Ok(url.as_str().trim_end_matches('/').to_owned())
}

/// The body of the code exchange. Borrowed, so the secret is not copied into another string.
#[derive(Serialize)]
struct Exchange<'a> {
    client_id: &'a str,
    client_secret: &'a str,
    code: &'a str,
}

/// The operations, named for spans and metrics. `template` is the documented path with its
/// placeholders, never the concrete path, so spans carry no repository or file names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Op {
    GetApp,
    CreateInstallationToken,
    GetRef,
    GetCommit,
    GetTree,
    GetBlob,
    CreateBlob,
    CreateTree,
    CreateCommit,
    CreateRef,
    UpdateRef,
    ListPulls,
    CreatePull,
    UpdatePull,
    CreateCheckRun,
    UpdateCheckRun,
    GetInstallation,
    ListInstallationRepositories,
    ListUserInstallations,
    ListUserInstallationRepositories,
    GetUser,
    GetPull,
    ExchangeOAuthCode,
}

impl Op {
    pub(crate) const fn name(self) -> &'static str {
        match self {
            Self::GetApp => "github.app.get",
            Self::CreateInstallationToken => "github.app.create_installation_token",
            Self::GetRef => "github.git.get_ref",
            Self::GetCommit => "github.git.get_commit",
            Self::GetTree => "github.git.get_tree",
            Self::GetBlob => "github.git.get_blob",
            Self::CreateBlob => "github.git.create_blob",
            Self::CreateTree => "github.git.create_tree",
            Self::CreateCommit => "github.git.create_commit",
            Self::CreateRef => "github.git.create_ref",
            Self::UpdateRef => "github.git.update_ref",
            Self::ListPulls => "github.pulls.list",
            Self::CreatePull => "github.pulls.create",
            Self::UpdatePull => "github.pulls.update",
            Self::CreateCheckRun => "github.checks.create",
            Self::UpdateCheckRun => "github.checks.update",
            Self::GetInstallation => "github.app.get_installation",
            Self::ListInstallationRepositories => "github.apps.list_installation_repositories",
            Self::ListUserInstallations => "github.apps.list_user_installations",
            Self::ListUserInstallationRepositories => {
                "github.apps.list_user_installation_repositories"
            }
            Self::GetUser => "github.users.get_authenticated",
            Self::GetPull => "github.pulls.get",
            Self::ExchangeOAuthCode => "github.oauth.exchange_code",
        }
    }

    pub(crate) const fn template(self) -> &'static str {
        match self {
            Self::GetApp => "/app",
            Self::CreateInstallationToken => "/app/installations/{installation_id}/access_tokens",
            Self::GetRef => "/repos/{owner}/{repo}/git/ref/{ref}",
            Self::GetCommit => "/repos/{owner}/{repo}/git/commits/{commit_sha}",
            Self::GetTree => "/repos/{owner}/{repo}/git/trees/{tree_sha}",
            Self::GetBlob => "/repos/{owner}/{repo}/git/blobs/{file_sha}",
            Self::CreateBlob => "/repos/{owner}/{repo}/git/blobs",
            Self::CreateTree => "/repos/{owner}/{repo}/git/trees",
            Self::CreateCommit => "/repos/{owner}/{repo}/git/commits",
            Self::CreateRef => "/repos/{owner}/{repo}/git/refs",
            Self::UpdateRef => "/repos/{owner}/{repo}/git/refs/{ref}",
            Self::ListPulls | Self::CreatePull => "/repos/{owner}/{repo}/pulls",
            Self::UpdatePull | Self::GetPull => "/repos/{owner}/{repo}/pulls/{pull_number}",
            Self::CreateCheckRun => "/repos/{owner}/{repo}/check-runs",
            Self::UpdateCheckRun => "/repos/{owner}/{repo}/check-runs/{check_run_id}",
            Self::GetInstallation => "/app/installations/{installation_id}",
            Self::ListInstallationRepositories => "/installation/repositories",
            Self::ListUserInstallations => "/user/installations",
            Self::ListUserInstallationRepositories => {
                "/user/installations/{installation_id}/repositories"
            }
            Self::GetUser => "/user",
            Self::ExchangeOAuthCode => "/login/oauth/access_token",
        }
    }
}

/// How a request authenticates.
#[derive(Debug, Clone, Copy)]
pub(crate) enum Auth<'a> {
    /// As the App, with a fresh JWT.
    App,
    /// As an installation, with a cached installation token for this scope.
    Installation(InstallationId, &'a TokenScope),
    /// As a person who authorised the App, with their user access token.
    User(&'a UserToken),
}

/// One request. `path` is built only from validated identifiers. No `Debug`: the body can
/// hold file content.
pub(crate) struct Request<'a> {
    pub(crate) op: Op,
    pub(crate) method: Method,
    pub(crate) path: String,
    pub(crate) query: Vec<(&'static str, String)>,
    pub(crate) body: Option<Vec<u8>>,
    pub(crate) accept: &'static str,
    pub(crate) auth: Auth<'a>,
}

impl<'a> Request<'a> {
    pub(crate) fn new(op: Op, method: Method, path: String, auth: Auth<'a>) -> Self {
        Self {
            op,
            method,
            path,
            query: Vec::new(),
            body: None,
            accept: ACCEPT_JSON,
            auth,
        }
    }

    pub(crate) fn json<T: Serialize>(mut self, body: &T) -> Result<Self, GitHubError> {
        self.body = Some(
            serde_json::to_vec(body)
                .map_err(|_| GitHubError::InvalidRequest("the request body cannot be encoded"))?,
        );
        Ok(self)
    }

    pub(crate) fn query(mut self, key: &'static str, value: impl Into<String>) -> Self {
        self.query.push((key, value.into()));
        self
    }

    pub(crate) const fn accept(mut self, accept: &'static str) -> Self {
        self.accept = accept;
        self
    }
}

/// A successful response. The body is wiped on drop because some bodies hold tokens. No
/// `Debug`, for the same reason.
pub(crate) struct Response {
    pub(crate) body: Zeroizing<Vec<u8>>,
}

impl Response {
    pub(crate) fn decode<T: DeserializeOwned>(&self) -> Result<T, GitHubError> {
        serde_json::from_slice(&self.body).map_err(|e| GitHubError::Decode(DecodeError::from(&e)))
    }
}

struct Metrics {
    requests: Counter<u64>,
    duration: Histogram<f64>,
}

/// GitHub client instruments (PLAN §21), from the global meter provider `telemetry::init`
/// installs.
fn metrics() -> &'static Metrics {
    static METRICS: OnceLock<Metrics> = OnceLock::new();
    METRICS.get_or_init(|| {
        let meter = opentelemetry::global::meter("rampsmith.github");
        Metrics {
            requests: meter
                .u64_counter("rampsmith.github.requests")
                .with_description("GitHub API requests, by operation and outcome")
                .build(),
            duration: meter
                .f64_histogram("rampsmith.github.request.duration")
                .with_unit("s")
                .with_description("GitHub API request duration, by operation")
                .build(),
        }
    })
}

fn record(op: Op, outcome: &'static str, started: Instant) {
    let m = metrics();
    m.requests.add(
        1,
        &[
            KeyValue::new("operation", op.name()),
            KeyValue::new("outcome", outcome),
        ],
    );
    m.duration.record(
        started.elapsed().as_secs_f64(),
        &[KeyValue::new("operation", op.name())],
    );
}

fn header_str<'h>(headers: &'h HeaderMap, name: &str) -> Option<&'h str> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
}

/// Decides whether a 403 or 429 is a rate limit and how long to wait, per GitHub's rules:
/// `retry-after` wins; otherwise `x-ratelimit-remaining: 0` waits until `x-ratelimit-reset`;
/// otherwise a 429, or a 403 whose message mentions a rate limit, waits one minute.
pub(crate) fn rate_limit(
    status: StatusCode,
    headers: &HeaderMap,
    message: &str,
    now_unix: i64,
) -> Option<(RateLimitKind, Duration)> {
    if status != StatusCode::FORBIDDEN && status != StatusCode::TOO_MANY_REQUESTS {
        return None;
    }
    let exhausted = header_str(headers, "x-ratelimit-remaining") == Some("0");
    let kind = if exhausted {
        RateLimitKind::Primary
    } else {
        RateLimitKind::Secondary
    };
    let clamp = |secs: u64| Duration::from_secs(secs.clamp(1, MAX_RATE_LIMIT_WAIT));
    if let Some(secs) = header_str(headers, "retry-after").and_then(|v| v.parse::<u64>().ok()) {
        return Some((kind, clamp(secs)));
    }
    if exhausted {
        let wait = header_str(headers, "x-ratelimit-reset")
            .and_then(|v| v.parse::<i64>().ok())
            .and_then(|reset| u64::try_from(reset.saturating_sub(now_unix)).ok())
            .unwrap_or(60);
        return Some((kind, clamp(wait)));
    }
    let mentions = message.to_ascii_lowercase().contains("rate limit");
    if status == StatusCode::TOO_MANY_REQUESTS || mentions {
        return Some((RateLimitKind::Secondary, Duration::from_mins(1)));
    }
    None
}

#[derive(serde::Deserialize)]
struct ErrorBody {
    message: Option<String>,
}

/// GitHub's error `message`, one line and at most 300 characters.
fn error_message(body: &[u8]) -> String {
    serde_json::from_slice::<ErrorBody>(body)
        .ok()
        .and_then(|b| b.message)
        .map(|m| truncate(&one_line(&m), 300))
        .unwrap_or_default()
}

type TokenKey = (InstallationId, TokenScope);

/// One cache slot: its own lock, so a slow mint for one installation never delays another
/// installation's token (integration audit L2).
type TokenSlot = Arc<Mutex<Option<Arc<InstallationToken>>>>;

/// The GitHub App client. Cheap to share behind an `Arc`; installation tokens are cached per
/// installation and scope, in memory only.
pub struct GitHub {
    http: reqwest::Client,
    base_url: String,
    oauth_base_url: String,
    max_response_bytes: usize,
    credentials: AppCredentials,
    clock: Arc<dyn Clock>,
    tokens: Mutex<HashMap<TokenKey, TokenSlot>>,
}

impl fmt::Debug for GitHub {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("GitHub")
            .field("base_url", &self.base_url)
            .field("issuer", self.credentials.issuer())
            .finish_non_exhaustive()
    }
}

/// The App, as `GET /app` describes it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
pub struct AppInfo {
    /// The numeric app ID.
    pub id: u64,
    /// The URL-friendly name.
    pub slug: Option<String>,
    /// The client ID.
    pub client_id: Option<String>,
}

impl GitHub {
    /// Builds a client. Redirects are never followed (a redirect could carry the
    /// `Authorization` header elsewhere) and no proxy is used.
    pub fn new(
        config: ClientConfig,
        credentials: AppCredentials,
        clock: Arc<dyn Clock>,
    ) -> Result<Self, GitHubError> {
        let base_url = validate_base_url(&config.base_url)?;
        let oauth_base_url = validate_base_url(&config.oauth_base_url)?;
        let http = reqwest::Client::builder()
            .user_agent(config.user_agent)
            .timeout(config.timeout)
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()
            .map_err(|_| GitHubError::Config("the HTTP client cannot be built"))?;
        Ok(Self {
            http,
            base_url,
            oauth_base_url,
            max_response_bytes: config.max_response_bytes,
            credentials,
            clock,
            tokens: Mutex::new(HashMap::new()),
        })
    }

    /// `GET /app` as the App: proves the client ID and private key work (LAUNCH C row 4).
    pub async fn app(&self) -> Result<AppInfo, GitHubError> {
        self.send_as_app(Request::new(
            Op::GetApp,
            Method::GET,
            "/app".to_owned(),
            Auth::App,
        ))
        .await?
        .decode()
    }

    /// `GET /app/installations/{id}` as the App: the installation's current state, or `None`
    /// once it is uninstalled. This, not the webhook that announced a change, is what the
    /// pipeline believes (integration audit M1).
    pub async fn installation(
        &self,
        id: InstallationId,
    ) -> Result<Option<InstallationInfo>, GitHubError> {
        let request = Request::new(
            Op::GetInstallation,
            Method::GET,
            format!("/app/installations/{id}"),
            Auth::App,
        );
        match self.send_as_app(request).await {
            Ok(response) => Ok(Some(response.decode()?)),
            Err(GitHubError::NotFound) => Ok(None),
            Err(error) => Err(error),
        }
    }

    /// `GET /installation/repositories`: the repositories the installation can reach, read with
    /// a metadata-read token.
    pub async fn installation_repositories(
        &self,
        id: InstallationId,
    ) -> Result<Listing<InstalledRepository>, GitHubError> {
        let scope = TokenScope::installation_metadata();
        self.list_repositories(|| {
            Request::new(
                Op::ListInstallationRepositories,
                Method::GET,
                "/installation/repositories".to_owned(),
                Auth::Installation(id, &scope),
            )
        })
        .await
    }

    /// `GET /user/installations`: the App's installations the user can reach.
    pub async fn user_installations(
        &self,
        token: &UserToken,
    ) -> Result<Listing<InstallationInfo>, GitHubError> {
        let mut items = Vec::new();
        for page in 1..=MAX_PAGES {
            let request = Request::new(
                Op::ListUserInstallations,
                Method::GET,
                "/user/installations".to_owned(),
                Auth::User(token),
            )
            .query("per_page", "100")
            .query("page", page.to_string());
            let batch = self.send(request).await?.decode::<UserInstallations>()?;
            let full = batch.installations.len() >= 100;
            items.extend(batch.installations);
            if !full {
                return Ok(Listing {
                    items,
                    truncated: false,
                });
            }
        }
        Ok(Listing {
            items,
            truncated: true,
        })
    }

    /// `GET /user/installations/{id}/repositories`: the installation's repositories the user can
    /// reach, each with the user's own permissions.
    pub async fn user_installation_repositories(
        &self,
        token: &UserToken,
        id: InstallationId,
    ) -> Result<Listing<InstalledRepository>, GitHubError> {
        self.list_repositories(|| {
            Request::new(
                Op::ListUserInstallationRepositories,
                Method::GET,
                format!("/user/installations/{id}/repositories"),
                Auth::User(token),
            )
        })
        .await
    }

    /// `GET /user`: the login of the person who authorised, recorded as who connected.
    pub async fn user_login(&self, token: &UserToken) -> Result<String, GitHubError> {
        let request = Request::new(
            Op::GetUser,
            Method::GET,
            "/user".to_owned(),
            Auth::User(token),
        );
        Ok(self.send(request).await?.decode::<UserLogin>()?.login)
    }

    async fn list_repositories<'a>(
        &self,
        build: impl Fn() -> Request<'a>,
    ) -> Result<Listing<InstalledRepository>, GitHubError> {
        let mut items = Vec::new();
        for page in 1..=MAX_PAGES {
            let request = build()
                .query("per_page", "100")
                .query("page", page.to_string());
            let batch = self.send(request).await?.decode::<RepositoriesPage>()?;
            let full = batch.repositories.len() >= 100;
            items.extend(batch.repositories);
            if !full {
                return Ok(Listing {
                    items,
                    truncated: false,
                });
            }
        }
        Ok(Listing {
            items,
            truncated: true,
        })
    }

    /// Exchanges the `code` GitHub put on the callback URL for a user access token. The code is
    /// single-use and short-lived; the token is returned to the caller to use once and drop.
    pub async fn exchange_oauth_code(
        &self,
        app: &OAuthApp,
        code: &str,
    ) -> Result<UserToken, OAuthError> {
        let code_ok = (1..=128).contains(&code.len())
            && code
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
        if !code_ok {
            return Err(OAuthError::Refused("bad_verification_code".to_owned()));
        }
        // The buffer moves into the request, so there is no second copy of the secret to wipe;
        // the HTTP stack drops it when the request completes.
        let body = serde_json::to_vec(&Exchange {
            client_id: &app.client_id,
            client_secret: app.client_secret.expose_secret(),
            code,
        })
        .map_err(|_| GitHubError::InvalidRequest("the request body cannot be encoded"))?;
        let url = format!("{}/login/oauth/access_token", self.oauth_base_url);
        let span = tracing::info_span!(
            "github.request",
            otel.kind = "client",
            github.operation = Op::ExchangeOAuthCode.name(),
            http.request.method = "POST",
            url.template = Op::ExchangeOAuthCode.template(),
        );
        async {
            let started = Instant::now();
            let mut response = match self
                .http
                .post(url)
                .header(header::ACCEPT, "application/json")
                .header(header::CONTENT_TYPE, "application/json")
                .body(body)
                .send()
                .await
            {
                Ok(response) => response,
                Err(error) => {
                    record(Op::ExchangeOAuthCode, "transport_error", started);
                    return Err(GitHubError::Transport(TransportKind::from(&error)).into());
                }
            };
            let status = response.status();
            let headers = response.headers().clone();
            let answer = self.read_body(&mut response).await?;
            let outcome = self.map_status(status, &headers, &answer);
            record(
                Op::ExchangeOAuthCode,
                outcome_label(status, outcome.as_ref().err()),
                started,
            );
            outcome?;
            let parsed: TokenAnswer = serde_json::from_slice(&answer)
                .map_err(|e| GitHubError::Decode(DecodeError::from(&e)))?;
            if let Some(error) = parsed.error {
                return Err(OAuthError::Refused(crate::install::error_name(&error)));
            }
            match parsed.access_token {
                Some(token) if !token.is_empty() => {
                    Ok(UserToken::new(secrecy::SecretString::from(token)))
                }
                _ => Err(OAuthError::Refused("no_access_token".to_owned())),
            }
        }
        .instrument(span)
        .await
    }

    /// An installation token for `scope`, from the cache while it has more than
    /// [`crate::TOKEN_REFRESH_SKEW`] left, otherwise newly minted. Concurrent callers for the
    /// same installation and scope wait for one refresh instead of minting several; callers for
    /// other installations or scopes are never held up by it.
    pub async fn installation_token(
        &self,
        installation: InstallationId,
        scope: &TokenScope,
    ) -> Result<Arc<InstallationToken>, GitHubError> {
        scope.validate()?;
        let key = (installation, scope.clone());
        let slot = {
            let mut cache = self.tokens.lock().await;
            // Forget slots that hold only an expired token and that nobody is waiting on.
            let now = self.clock.now();
            cache.retain(|k, slot| {
                *k == key
                    || Arc::strong_count(slot) > 1
                    || slot
                        .try_lock()
                        .map_or(true, |t| t.as_ref().is_some_and(|t| t.is_fresh(now)))
            });
            Arc::clone(cache.entry(key).or_default())
        };
        let mut held = slot.lock().await;
        let now = self.clock.now();
        if let Some(token) = held.as_ref().filter(|t| t.is_fresh(now)) {
            return Ok(Arc::clone(token));
        }
        let request = Request::new(
            Op::CreateInstallationToken,
            Method::POST,
            format!("/app/installations/{installation}/access_tokens"),
            Auth::App,
        )
        .json(scope)?;
        let response = self.send_as_app(request).await?;
        let token = Arc::new(response.decode::<TokenResponse>()?.into_token()?);
        *held = Some(Arc::clone(&token));
        Ok(token)
    }

    /// Drops a cached token, after GitHub rejected it.
    async fn evict(&self, installation: InstallationId, scope: &TokenScope) {
        let slot = self
            .tokens
            .lock()
            .await
            .get(&(installation, scope.clone()))
            .cloned();
        if let Some(slot) = slot {
            *slot.lock().await = None;
        }
    }

    fn url(&self, request: &Request<'_>) -> Result<Url, GitHubError> {
        let mut url = Url::parse(&format!("{}{}", self.base_url, request.path))
            .map_err(|_| GitHubError::InvalidRequest("the request path does not form a URL"))?;
        if !request.query.is_empty() {
            let mut pairs = url.query_pairs_mut();
            for (key, value) in &request.query {
                pairs.append_pair(key, value);
            }
        }
        Ok(url)
    }

    /// Sends one request inside a client span, authenticating as the request says.
    pub(crate) async fn send(&self, request: Request<'_>) -> Result<Response, GitHubError> {
        let span = request_span(&request);
        let result = async {
            let bearer = match request.auth {
                Auth::App => self.app_bearer()?,
                Auth::Installation(id, scope) => {
                    let token = self.installation_token(id, scope).await?;
                    Zeroizing::new(format!("Bearer {}", token.bearer()))
                }
                Auth::User(token) => Zeroizing::new(format!("Bearer {}", token.bearer())),
            };
            self.execute(request, &bearer).await
        }
        .instrument(span.clone())
        .await;
        finish(&span, result.as_ref().err());
        result
    }

    /// Sends one request as the App. Kept apart from [`Self::send`] so minting a token never
    /// recurses into the token cache.
    async fn send_as_app(&self, request: Request<'_>) -> Result<Response, GitHubError> {
        let span = request_span(&request);
        let result = async {
            let bearer = self.app_bearer()?;
            self.execute(request, &bearer).await
        }
        .instrument(span.clone())
        .await;
        finish(&span, result.as_ref().err());
        result
    }

    fn app_bearer(&self) -> Result<Zeroizing<String>, GitHubError> {
        let jwt = self.credentials.jwt(self.clock.now())?;
        Ok(Zeroizing::new(format!("Bearer {}", jwt.expose_secret())))
    }

    async fn execute(&self, request: Request<'_>, bearer: &str) -> Result<Response, GitHubError> {
        let url = self.url(&request)?;
        let mut authorization = HeaderValue::from_str(bearer)
            .map_err(|_| GitHubError::InvalidRequest("the credential is not a valid header"))?;
        authorization.set_sensitive(true);
        let mut builder = self
            .http
            .request(request.method.clone(), url)
            .header(header::ACCEPT, request.accept)
            .header("x-github-api-version", API_VERSION)
            .header(header::AUTHORIZATION, authorization);
        if let Some(body) = request.body {
            builder = builder
                .header(header::CONTENT_TYPE, "application/json")
                .body(body);
        }
        let started = Instant::now();
        let mut response = match builder.send().await {
            Ok(response) => response,
            Err(error) => {
                record(request.op, "transport_error", started);
                return Err(GitHubError::Transport(TransportKind::from(&error)));
            }
        };
        let status = response.status();
        let headers = response.headers().clone();
        let span = tracing::Span::current();
        span.record("http.response.status_code", status.as_u16());
        if let Some(id) = header_str(&headers, "x-github-request-id") {
            span.record("github.request_id", id);
        }
        let body = match self.read_body(&mut response).await {
            Ok(body) => body,
            Err(error) => {
                record(request.op, "transport_error", started);
                return Err(error);
            }
        };
        let outcome = self.map_status(status, &headers, &body);
        record(
            request.op,
            outcome_label(status, outcome.as_ref().err()),
            started,
        );
        if matches!(outcome, Err(GitHubError::Unauthorized))
            && let Auth::Installation(id, scope) = request.auth
        {
            self.evict(id, scope).await;
        }
        outcome?;
        Ok(Response { body })
    }

    async fn read_body(
        &self,
        response: &mut reqwest::Response,
    ) -> Result<Zeroizing<Vec<u8>>, GitHubError> {
        let limit = self.max_response_bytes;
        if response
            .content_length()
            .is_some_and(|len| len > u64::try_from(limit).unwrap_or(u64::MAX))
        {
            return Err(GitHubError::ResponseTooLarge { limit });
        }
        let mut body = Zeroizing::new(Vec::new());
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|e| GitHubError::Transport(TransportKind::from(&e)))?
        {
            if body.len() + chunk.len() > limit {
                return Err(GitHubError::ResponseTooLarge { limit });
            }
            body.extend_from_slice(&chunk);
        }
        Ok(body)
    }

    fn map_status(
        &self,
        status: StatusCode,
        headers: &HeaderMap,
        body: &[u8],
    ) -> Result<(), GitHubError> {
        if status.is_success() {
            return Ok(());
        }
        let message = error_message(body);
        if let Some((kind, retry_after)) =
            rate_limit(status, headers, &message, self.clock.now().unix_timestamp())
        {
            return Err(GitHubError::RateLimited { kind, retry_after });
        }
        Err(match status.as_u16() {
            401 => GitHubError::Unauthorized,
            403 => GitHubError::Forbidden { message },
            404 => GitHubError::NotFound,
            409 => GitHubError::Conflict { message },
            422 => GitHubError::Validation { message },
            code @ 500..=599 => GitHubError::Server { status: code },
            code => GitHubError::UnexpectedStatus { status: code },
        })
    }
}

/// The client span: operation, method, documented path template and installation id. No
/// concrete path, repository name, file name, header or body is ever recorded.
fn request_span(request: &Request<'_>) -> tracing::Span {
    let installation = match request.auth {
        Auth::Installation(id, _) => Some(id.get()),
        Auth::App | Auth::User(_) => None,
    };
    tracing::info_span!(
        "github.request",
        otel.kind = "client",
        github.operation = request.op.name(),
        http.request.method = %request.method,
        url.template = request.op.template(),
        github.installation_id = installation,
        http.response.status_code = tracing::field::Empty,
        github.request_id = tracing::field::Empty,
        error.type = tracing::field::Empty,
    )
}

fn finish(span: &tracing::Span, error: Option<&GitHubError>) {
    if let Some(error) = error {
        span.record("error.type", error_type(error));
    }
}

fn outcome_label(status: StatusCode, error: Option<&GitHubError>) -> &'static str {
    match error {
        None => "success",
        Some(GitHubError::RateLimited { .. }) => "rate_limited",
        Some(_) if status.is_server_error() => "server_error",
        Some(_) if status.is_client_error() => "client_error",
        Some(_) => "unexpected",
    }
}

const fn error_type(error: &GitHubError) -> &'static str {
    match error {
        GitHubError::Transport(_) => "transport",
        GitHubError::Unauthorized => "unauthorized",
        GitHubError::Forbidden { .. } => "forbidden",
        GitHubError::NotFound => "not_found",
        GitHubError::Conflict { .. } => "conflict",
        GitHubError::Validation { .. } => "validation",
        GitHubError::RateLimited { .. } => "rate_limited",
        GitHubError::Server { .. } => "server",
        GitHubError::UnexpectedStatus { .. } => "unexpected_status",
        GitHubError::ResponseTooLarge { .. } => "response_too_large",
        GitHubError::Decode(_) => "decode",
        GitHubError::TreeTruncated => "tree_truncated",
        GitHubError::Config(_) => "config",
        GitHubError::InvalidRequest(_) => "invalid_request",
        GitHubError::Key(_) => "key",
        GitHubError::Branch(_) => "branch_guard",
        GitHubError::Path(_) => "path_guard",
        GitHubError::Structure(_) => "theme_structure",
        GitHubError::BranchMoved => "branch_moved",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (k, v) in pairs {
            map.insert(*k, HeaderValue::from_str(v).unwrap());
        }
        map
    }

    #[test]
    fn primary_rate_limit_waits_until_reset() {
        let h = headers(&[
            ("x-ratelimit-remaining", "0"),
            ("x-ratelimit-reset", "1100"),
        ]);
        assert_eq!(
            rate_limit(StatusCode::FORBIDDEN, &h, "API rate limit exceeded", 1000),
            Some((RateLimitKind::Primary, Duration::from_secs(100)))
        );
        assert_eq!(
            rate_limit(StatusCode::TOO_MANY_REQUESTS, &h, "", 1000),
            Some((RateLimitKind::Primary, Duration::from_secs(100)))
        );
    }

    #[test]
    fn retry_after_wins() {
        let h = headers(&[("retry-after", "30"), ("x-ratelimit-remaining", "12")]);
        assert_eq!(
            rate_limit(StatusCode::FORBIDDEN, &h, "secondary rate limit", 0),
            Some((RateLimitKind::Secondary, Duration::from_secs(30)))
        );
    }

    #[test]
    fn secondary_limit_without_headers_waits_a_minute() {
        let none = HeaderMap::new();
        assert_eq!(
            rate_limit(
                StatusCode::FORBIDDEN,
                &none,
                "You have exceeded a secondary rate limit",
                0
            ),
            Some((RateLimitKind::Secondary, Duration::from_mins(1)))
        );
        assert_eq!(
            rate_limit(StatusCode::TOO_MANY_REQUESTS, &none, "", 0),
            Some((RateLimitKind::Secondary, Duration::from_mins(1)))
        );
    }

    #[test]
    fn a_plain_403_is_not_a_rate_limit() {
        let h = headers(&[("x-ratelimit-remaining", "4999")]);
        assert_eq!(
            rate_limit(
                StatusCode::FORBIDDEN,
                &h,
                "Resource not accessible by integration",
                0
            ),
            None
        );
        assert_eq!(rate_limit(StatusCode::NOT_FOUND, &h, "rate limit", 0), None);
    }

    #[test]
    fn rate_limit_waits_are_clamped() {
        let past = headers(&[("x-ratelimit-remaining", "0"), ("x-ratelimit-reset", "5")]);
        assert_eq!(
            rate_limit(StatusCode::FORBIDDEN, &past, "", 1000),
            Some((RateLimitKind::Primary, Duration::from_mins(1)))
        );
        let far = headers(&[("retry-after", "999999")]);
        assert_eq!(
            rate_limit(StatusCode::TOO_MANY_REQUESTS, &far, "", 0),
            Some((RateLimitKind::Secondary, Duration::from_hours(1)))
        );
    }

    #[test]
    fn base_url_must_be_https_except_on_loopback() {
        assert_eq!(
            validate_base_url("https://api.github.com/").unwrap(),
            "https://api.github.com"
        );
        assert!(validate_base_url("http://127.0.0.1:8080").is_ok());
        assert!(validate_base_url("http://[::1]:8080").is_ok());
        assert!(validate_base_url("http://localhost:1").is_ok());
        for bad in [
            "http://api.github.com",
            "http://10.0.0.1",
            "ftp://api.github.com",
            "https://user:pass@api.github.com",
            "https://api.github.com/?x=1",
            "https://api.github.com/#f",
            "not a url",
        ] {
            assert!(validate_base_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn error_messages_are_one_line_and_bounded() {
        let body = format!(
            r#"{{"message":"Reference\nalready exists {}","documentation_url":"x"}}"#,
            "a".repeat(500)
        );
        let message = error_message(body.as_bytes());
        assert!(message.starts_with("Reference already exists"));
        assert_eq!(message.chars().count(), 300);
        assert_eq!(error_message(b"not json"), "");
    }

    #[test]
    fn op_templates_never_contain_concrete_values() {
        for op in [
            Op::GetApp,
            Op::CreateInstallationToken,
            Op::GetRef,
            Op::GetCommit,
            Op::GetTree,
            Op::GetBlob,
            Op::CreateBlob,
            Op::CreateTree,
            Op::CreateCommit,
            Op::CreateRef,
            Op::UpdateRef,
            Op::ListPulls,
            Op::CreatePull,
            Op::UpdatePull,
            Op::CreateCheckRun,
            Op::UpdateCheckRun,
            Op::GetInstallation,
            Op::ListInstallationRepositories,
            Op::ListUserInstallations,
            Op::ListUserInstallationRepositories,
            Op::GetUser,
            Op::GetPull,
            Op::ExchangeOAuthCode,
        ] {
            assert!(op.name().starts_with("github."));
            assert!(op.template().starts_with('/'));
            assert!(!op.template().chars().any(|c| c.is_ascii_digit()));
        }
    }
}
