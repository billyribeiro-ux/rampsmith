//! The free scanner's anonymous scans (PLAN §16, ADR-267).
//!
//! The web server is the only caller. It authenticates with `FREE_SCAN_SERVICE_TOKEN` (a shared
//! secret on the private network), forwards the visitor's address and Turnstile token, and
//! shows the result. Everything that protects the scanner happens here, so none of it depends
//! on the web process staying up or on one replica:
//!
//! 1. The address is parsed the way the web form parses it (one public host, no address, port or
//!    credentials) and refused otherwise. The engine's egress guard still runs on every request.
//! 2. The visitor's day budget is read, then Turnstile is verified server-side (failing closed),
//!    then everything else happens in one transaction under advisory locks for the address and
//!    the domain: a cached result is returned without cost; otherwise 3 scans per address and 1
//!    per domain per day, and a ceiling on scans in flight, are enforced from the database.
//! 3. The scan is recorded and enqueued in that transaction, for no tenant.
//!
//! The address is never stored: a keyed hash of it (its /64 for IPv6) is, for 24 hours, under a
//! key derived from the Turnstile secret, which only the api holds (audit L4).

use std::net::IpAddr;
use std::time::Duration;

use axum::Json;
use axum::extract::{FromRequestParts, Path, State};
use axum::http::request::Parts;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use contracts::FreeScanResult;
use db::repo::free_scans::{self, FreeScan};
use hmac::{Hmac, KeyInit, Mac};
use http_kit::{ApiError, FieldError, ProblemCode};
use secrecy::{ExposeSecret, SecretString};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use tracing::{error, warn};
use url::{Host, Url};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::AppState;
use crate::rate_limit::normalise;

/// Scans one address may start per day (PLAN §16).
const PER_ADDRESS: i64 = 3;
/// The `action` the free scanner's widget is rendered with and `siteverify` must report
/// (Cloudflare: letters, digits, `_` and `-`, at most 32). The web form uses the same value.
pub const TURNSTILE_ACTION: &str = "free_scan";
/// Scans one domain may have per day (PLAN §16).
const PER_DOMAIN: i64 = 1;
/// Free scans that may be queued or running at once, across everyone.
const IN_FLIGHT_CEILING: i64 = 40;
/// How long a Turnstile check may take.
const TURNSTILE_TIMEOUT: Duration = Duration::from_secs(5);
/// A Turnstile token is at most this long (Cloudflare's documentation).
const MAX_TOKEN: usize = 2048;
/// The shortest service token the api accepts at boot.
pub const MIN_SERVICE_TOKEN: usize = 32;

/// Cloudflare's origin; tests and the end-to-end fake may replace it.
pub const TURNSTILE_ORIGIN: &str = "https://challenges.cloudflare.com";

type HmacSha256 = Hmac<Sha256>;

/// What the free scanner needs from its environment (LAUNCH.md section C).
#[derive(Debug)]
pub struct FreeScanSettings {
    /// The secret the web server presents (`FREE_SCAN_SERVICE_TOKEN`).
    pub service_token: SecretString,
    /// The Turnstile widget's secret (`TURNSTILE_SECRET_KEY`).
    pub turnstile_secret: SecretString,
    /// Where `siteverify` lives (`TURNSTILE_ORIGIN`).
    pub turnstile_origin: Url,
    /// The hostnames the widget may be served from (`TURNSTILE_HOSTNAMES`), lowercase. Cloudflare
    /// reports the hostname the visitor solved the challenge on; one that is not listed is
    /// refused (audit L3). Empty checks no hostname, which only a development setup should do.
    pub turnstile_hostnames: Vec<String>,
}

/// The free scanner's service: authentication, address hashing and the Turnstile check.
#[derive(Debug, Clone)]
pub struct FreeScans {
    token: SecretString,
    ip_key: [u8; 32],
    turnstile_secret: SecretString,
    turnstile_hostnames: Vec<String>,
    siteverify: Url,
    http: reqwest::Client,
}

impl FreeScans {
    /// Builds the service.
    ///
    /// # Errors
    ///
    /// The token is shorter than [`MIN_SERVICE_TOKEN`] or the HTTP client cannot be built.
    pub fn new(settings: FreeScanSettings) -> Result<Self, String> {
        if settings.service_token.expose_secret().len() < MIN_SERVICE_TOKEN {
            return Err(format!(
                "the service token must be at least {MIN_SERVICE_TOKEN} characters"
            ));
        }
        let siteverify = settings
            .turnstile_origin
            .join("turnstile/v0/siteverify")
            .map_err(|e| e.to_string())?;
        let http = reqwest::Client::builder()
            .timeout(TURNSTILE_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| e.without_url().to_string())?;
        // The key comes from the Turnstile secret, which only the api holds. The web server
        // holds the service token, so a key derived from the token would let a compromised web
        // server hash any address it knows and test it against the table (audit L4, ADR-287).
        let ip_key = keyed(
            settings.turnstile_secret.expose_secret().as_bytes(),
            b"rampsmith/free-scan/address-hash/v2",
        );
        Ok(Self {
            token: settings.service_token,
            ip_key,
            turnstile_secret: settings.turnstile_secret,
            turnstile_hostnames: settings.turnstile_hostnames,
            siteverify,
            http,
        })
    }

    /// Whether `presented` is the service token, compared in constant time.
    fn authenticates(&self, presented: &str) -> bool {
        let key = self.token.expose_secret().as_bytes();
        let expected = keyed(key, key);
        let Ok(mut mac) = <HmacSha256 as KeyInit>::new_from_slice(key) else {
            return false;
        };
        mac.update(presented.as_bytes());
        // `verify_slice` compares in constant time.
        mac.verify_slice(&expected).is_ok()
    }

    /// The keyed hash of a visitor's address, as stored.
    fn hash_address(&self, address: IpAddr) -> [u8; 32] {
        let text = normalise(address).to_string();
        keyed(&self.ip_key, text.as_bytes())
    }

    /// Asks Cloudflare whether the token is a solved challenge. Anything but a clear yes fails.
    async fn verify(&self, token: &str, address: IpAddr) -> Result<(), Challenge> {
        if token.is_empty() {
            return Err(Challenge::Invalid);
        }
        if token.len() > MAX_TOKEN {
            return Err(Challenge::Invalid);
        }
        let remote = address.to_string();
        let response = self
            .http
            .post(self.siteverify.clone())
            .form(&[
                ("secret", self.turnstile_secret.expose_secret()),
                ("response", token),
                ("remoteip", remote.as_str()),
            ])
            .send()
            .await
            .map_err(|e| {
                warn!(error = %e.without_url(), "Turnstile could not be reached");
                Challenge::Unavailable
            })?;
        let payload: serde_json::Value = response.json().await.map_err(|e| {
            warn!(error = %e.without_url(), "Turnstile answered with something unreadable");
            Challenge::Unavailable
        })?;
        if payload.get("success").and_then(serde_json::Value::as_bool) == Some(true) {
            return self.accepts_widget(&payload);
        }
        let codes: Vec<&str> = payload
            .get("error-codes")
            .and_then(serde_json::Value::as_array)
            .map(|codes| codes.iter().filter_map(serde_json::Value::as_str).collect())
            .unwrap_or_default();
        let visitor_fault = !codes.is_empty()
            && codes.iter().all(|code| {
                matches!(
                    *code,
                    "missing-input-response" | "invalid-input-response" | "timeout-or-duplicate"
                )
            });
        if visitor_fault {
            Err(Challenge::Invalid)
        } else {
            // Our secret is wrong or Cloudflare is unwell: the visitor can do nothing about it.
            warn!(
                ?codes,
                "Turnstile refused the request for a reason on our side"
            );
            Err(Challenge::Unavailable)
        }
    }
}

impl FreeScans {
    /// A solved challenge counts only if it came from our widget on our site (audit L3): Cloudflare
    /// reports the `action` the widget was rendered with and the `hostname` it was served on, and
    /// a token solved on another site or for another form is not ours. Neither value is logged
    /// with the token.
    fn accepts_widget(&self, payload: &serde_json::Value) -> Result<(), Challenge> {
        let text = |field: &str| payload.get(field).and_then(serde_json::Value::as_str);
        if text("action") != Some(TURNSTILE_ACTION) {
            warn!("Turnstile token solved for another action");
            return Err(Challenge::Invalid);
        }
        if !self.turnstile_hostnames.is_empty() {
            let listed = text("hostname").is_some_and(|host| {
                self.turnstile_hostnames
                    .iter()
                    .any(|allowed| allowed.eq_ignore_ascii_case(host))
            });
            if !listed {
                warn!("Turnstile token solved on a hostname that is not ours");
                return Err(Challenge::Invalid);
            }
        }
        Ok(())
    }
}

fn keyed(key: &[u8], message: &[u8]) -> [u8; 32] {
    // An HMAC accepts a key of any length, so this cannot fail; a zero tag would make every
    // address hash alike, which the quota would turn into a refusal, never into a pass.
    let Ok(mut mac) = <HmacSha256 as KeyInit>::new_from_slice(key) else {
        return [0; 32];
    };
    mac.update(message);
    mac.finalize().into_bytes().into()
}

enum Challenge {
    Invalid,
    Unavailable,
}

// ---------------------------------------------------------------------------------------------
// The address

/// Why an address was refused; the web form shows the same reasons.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UrlRefusal {
    /// Nothing was typed.
    Empty,
    /// Not an address a browser would open.
    Invalid,
    /// A scheme other than http and https.
    Scheme,
    /// A user name or password.
    Credentials,
    /// A port.
    Port,
    /// An IP address.
    Address,
    /// A name that cannot be on the public internet.
    Private,
    /// A public suffix itself (`co.uk`, `myshopify.com`): no one site, so nothing to scan.
    Suffix,
}

impl UrlRefusal {
    const fn code(self) -> &'static str {
        match self {
            Self::Empty => "empty",
            Self::Invalid => "invalid",
            Self::Scheme => "scheme",
            Self::Credentials => "credentials",
            Self::Port => "port",
            Self::Address => "address",
            Self::Private => "private",
            Self::Suffix => "suffix",
        }
    }
}

/// A public website to scan at its home page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublicSite {
    /// `scheme://host/`.
    pub origin: String,
    /// The host without a leading `www.`: the key for the cache and the join of a running scan.
    pub domain: String,
    /// The registrable domain of `domain` by the Public Suffix List: the key for the per-domain
    /// daily limit, so subdomains of one shop share a day (audit L1).
    pub registrable: String,
}

const RESERVED_SUFFIXES: [&str; 13] = [
    "localhost",
    "local",
    "internal",
    "intranet",
    "lan",
    "home",
    "corp",
    "private",
    "test",
    "example",
    "invalid",
    "onion",
    "arpa",
];

/// The first, syntactic guard (PLAN §16): one public website. Mirrors the web form's rules, so
/// a caller that skips the form meets the same ones.
pub fn parse_public_url(input: &str) -> Result<PublicSite, UrlRefusal> {
    let text = input.trim();
    if text.is_empty() {
        return Err(UrlRefusal::Empty);
    }
    if text.chars().count() > 2048 || text.chars().any(char::is_whitespace) {
        return Err(UrlRefusal::Invalid);
    }
    let lower = text.to_ascii_lowercase();
    let candidate = if lower.starts_with("http://") || lower.starts_with("https://") {
        text.to_owned()
    } else if text.contains("://") {
        return Err(UrlRefusal::Scheme);
    } else {
        format!("https://{text}")
    };
    let url = Url::parse(&candidate).map_err(|_| UrlRefusal::Invalid)?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(UrlRefusal::Scheme);
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(UrlRefusal::Credentials);
    }
    if url.port().is_some() {
        return Err(UrlRefusal::Port);
    }
    let host = match url.host() {
        Some(Host::Domain(name)) => name.to_ascii_lowercase(),
        Some(Host::Ipv4(_) | Host::Ipv6(_)) => return Err(UrlRefusal::Address),
        None => return Err(UrlRefusal::Invalid),
    };
    let host = host.strip_suffix('.').unwrap_or(&host).to_owned();
    if host.is_empty() || host.len() > 253 {
        return Err(UrlRefusal::Invalid);
    }
    let labels: Vec<&str> = host.split('.').collect();
    let tld = labels.last().copied().unwrap_or_default();
    if !tld.is_empty() && tld.bytes().all(|b| b.is_ascii_digit()) {
        return Err(UrlRefusal::Address);
    }
    if tld
        .strip_prefix("0x")
        .is_some_and(|hex| hex.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        return Err(UrlRefusal::Address);
    }
    let label_ok = |label: &&str| {
        (1..=63).contains(&label.len())
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    };
    if !labels.iter().all(label_ok) {
        return Err(UrlRefusal::Invalid);
    }
    if labels.len() < 2 || RESERVED_SUFFIXES.contains(&tld) {
        return Err(UrlRefusal::Private);
    }
    let domain = host.strip_prefix("www.").unwrap_or(&host).to_owned();
    // A public suffix (`co.uk`, `github.io`) has no registrable domain: it is not one site, and
    // it is refused here, before a Turnstile token is spent on it.
    let Some(registrable) = psl::domain_str(&domain) else {
        return Err(UrlRefusal::Suffix);
    };
    Ok(PublicSite {
        origin: format!("{}://{host}/", url.scheme()),
        registrable: registrable.to_owned(),
        domain,
    })
}

// ---------------------------------------------------------------------------------------------
// Authentication

/// Proof that the caller presented the service token.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Service;

impl FromRequestParts<AppState> for Service {
    type Rejection = ApiError;

    // Nothing here awaits, so the future is ready at once (Clippy's unused async trait impl).
    fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> impl Future<Output = Result<Self, ApiError>> + Send {
        let Some(free) = state.free_scans() else {
            return std::future::ready(Err(ApiError::new(ProblemCode::Unavailable)
                .detail("The free scanner is not configured.")));
        };
        let presented = parts
            .headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "));
        std::future::ready(match presented {
            Some(token) if free.authenticates(token) => Ok(Self),
            _ => Err(ApiError::new(ProblemCode::Unauthenticated)),
        })
    }
}

// ---------------------------------------------------------------------------------------------
// Routes

/// A request for a free scan, from the web server.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct CreateFreeScan {
    /// The address the visitor typed.
    url: String,
    /// The visitor's Turnstile token.
    turnstile_token: String,
    /// The visitor's address, as the web server saw it.
    client_ip: String,
}

/// A free scan and, once finished, what it found.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct FreeScanDto {
    id: String,
    domain: String,
    /// `queued`, `running`, `complete`, `refused` or `failed`.
    status: String,
    /// Why a refused scan was refused: `robots`, `bot-challenge` or `unreachable`.
    refusal: Option<String>,
    /// The result, once complete.
    result: Option<FreeScanResult>,
    /// True when an earlier scan of this domain answered the request.
    cached: bool,
}

fn dto(scan: FreeScan, cached: bool) -> FreeScanDto {
    // A row that breaks the limits the engine promises is not shown: the page can show only so
    // much, and a writer other than the engine is a bug worth a log line.
    let result =
        scan.result.and_then(
            |value| match serde_json::from_value::<FreeScanResult>(value) {
                Ok(result) if result.within_limits() => Some(result),
                Ok(_) | Err(_) => {
                    error!(scan = %scan.id, "a stored free scan result is not valid; not served");
                    None
                }
            },
        );
    let status = if scan.status == "complete" && result.is_none() {
        "failed".to_owned()
    } else {
        scan.status
    };
    FreeScanDto {
        id: scan.id.to_string(),
        domain: scan.domain,
        status,
        refusal: scan.refusal,
        result,
        cached,
    }
}

fn invalid(field: &str, message: &str) -> ApiError {
    ApiError::new(ProblemCode::ValidationFailed).errors(vec![FieldError {
        field: field.to_owned(),
        message: message.to_owned(),
    }])
}

/// The 503 answer when no sandboxed engine serves free scans. The `scanner` field tells the web
/// server to show the page's "not connected" state rather than "busy".
fn scanner_unavailable() -> ApiError {
    ApiError::new(ProblemCode::Unavailable)
        .detail("The free scanner is unavailable.")
        .errors(vec![FieldError {
            field: "scanner".to_owned(),
            message: "unavailable".to_owned(),
        }])
}

/// The 429 answer: which budget ran out, and when a place frees up.
pub(crate) struct Limited {
    scope: &'static str,
    seconds: i64,
}

impl IntoResponse for Limited {
    fn into_response(self) -> Response {
        let mut response = ApiError::new(ProblemCode::RateLimited)
            .detail("The free scanner's daily limit for this was reached.")
            .errors(vec![FieldError {
                field: "limit".to_owned(),
                message: self.scope.to_owned(),
            }])
            .into_response();
        if let Ok(value) = HeaderValue::from_str(&self.seconds.max(1).to_string()) {
            response.headers_mut().insert(header::RETRY_AFTER, value);
        }
        response
    }
}

pub(crate) enum Refused {
    Api(ApiError),
    Busy,
    Limited(Limited),
}

impl From<ApiError> for Refused {
    fn from(error: ApiError) -> Self {
        Self::Api(error)
    }
}

impl From<db::DbError> for Refused {
    fn from(error: db::DbError) -> Self {
        Self::Api(error.into())
    }
}

impl IntoResponse for Refused {
    fn into_response(self) -> Response {
        match self {
            Self::Api(error) => error.into_response(),
            Self::Limited(limited) => limited.into_response(),
            Self::Busy => {
                let mut response = ApiError::new(ProblemCode::Unavailable)
                    .detail("The scanner is busy. Try again in a minute.")
                    .into_response();
                response
                    .headers_mut()
                    .insert(header::RETRY_AFTER, HeaderValue::from_static("60"));
                response
            }
        }
    }
}

/// Starts a free scan of one public website, or returns the answer already held for it.
#[utoipa::path(
    post,
    path = "/v1/free-scans",
    tag = "free-scanner",
    operation_id = "createFreeScan",
    security(("free_scan_service" = [])),
    request_body = CreateFreeScan,
    responses(
        (status = ACCEPTED, description = "The scan is queued or running", body = FreeScanDto),
        (status = OK, description = "A scan of this domain from the last 24 hours answers", body = FreeScanDto),
        (status = UNPROCESSABLE_ENTITY, description = "The address or the challenge was refused",
            body = http_kit::Problem, content_type = "application/problem+json"),
        (status = TOO_MANY_REQUESTS, description = "A daily limit was reached",
            body = http_kit::Problem, content_type = "application/problem+json"),
        (status = SERVICE_UNAVAILABLE, description = "The scanner is busy or not configured",
            body = http_kit::Problem, content_type = "application/problem+json")
    )
)]
pub(crate) async fn create_free_scan(
    State(state): State<AppState>,
    _service: Service,
    crate::r1::Body(body): crate::r1::Body<CreateFreeScan>,
) -> Result<(StatusCode, Json<FreeScanDto>), Refused> {
    let Some(free) = state.free_scans() else {
        return Err(ApiError::new(ProblemCode::Unavailable).into());
    };
    // Nothing is spent on a request while no engine with a sandboxed Chromium is serving free
    // scans (ADR-280): not a Turnstile call, not a place in anyone's budget, not a row.
    {
        let mut tx = state.db.public().await?;
        let available = free_scans::engine_available(&mut tx).await?;
        tx.rollback().await?;
        if !available {
            return Err(Refused::Api(scanner_unavailable()));
        }
    }
    let site = parse_public_url(&body.url).map_err(|reason| invalid("url", reason.code()))?;
    let address: IpAddr = body
        .client_ip
        .trim()
        .parse()
        .map_err(|_| invalid("client_ip", "not an address"))?;
    let ip_hash = free.hash_address(address);

    // A complete scan of the domain from the last day answers first, before the address budget
    // is read and before Cloudflare is called: it runs nothing, so it costs the visitor nothing
    // and an address that has used its day (or shares one with many others) can still read it.
    {
        let mut tx = state.db.public().await?;
        let cached = free_scans::cached(&mut tx, &site.domain).await?;
        tx.rollback().await?;
        if let Some(cached) = cached {
            return Ok((StatusCode::OK, Json(dto(cached, true))));
        }
    }

    // The budget is read before the challenge, so an address that has used its day does not
    // spend Cloudflare calls; it is spent only below, under the locks.
    {
        let mut tx = state.db.public().await?;
        let used = free_scans::used_by_ip(&mut tx, &ip_hash).await?;
        tx.rollback().await?;
        if used.count >= PER_ADDRESS {
            return Err(Refused::Limited(Limited {
                scope: "ip",
                seconds: used.frees_in_seconds,
            }));
        }
    }

    match free.verify(&body.turnstile_token, address).await {
        Ok(()) => {}
        Err(Challenge::Invalid) => return Err(invalid("turnstile_token", "failed").into()),
        Err(Challenge::Unavailable) => {
            return Err(ApiError::new(ProblemCode::Unavailable)
                .detail("The challenge could not be checked.")
                .errors(vec![FieldError {
                    field: "turnstile_token".to_owned(),
                    message: "unavailable".to_owned(),
                }])
                .into());
        }
    }

    let mut tx = state.db.public().await?;
    free_scans::lock(&mut tx, &ip_hash, &site.registrable).await?;
    // A complete scan of the domain from the last day answers, and costs the visitor nothing.
    if let Some(cached) = free_scans::cached(&mut tx, &site.domain).await? {
        tx.rollback().await?;
        return Ok((StatusCode::OK, Json(dto(cached, true))));
    }
    // So does one still running: asking again while it runs joins it.
    if let Some(running) = free_scans::in_flight_for(&mut tx, &site.domain).await? {
        tx.rollback().await?;
        return Ok((StatusCode::ACCEPTED, Json(dto(running, true))));
    }
    let by_address = free_scans::used_by_ip(&mut tx, &ip_hash).await?;
    if by_address.count >= PER_ADDRESS {
        return Err(Refused::Limited(Limited {
            scope: "ip",
            seconds: by_address.frees_in_seconds,
        }));
    }
    let by_domain = free_scans::used_by_domain(&mut tx, &site.registrable).await?;
    if by_domain.count >= PER_DOMAIN {
        return Err(Refused::Limited(Limited {
            scope: "domain",
            seconds: by_domain.frees_in_seconds,
        }));
    }
    if free_scans::in_flight_count(&mut tx).await? >= IN_FLIGHT_CEILING {
        return Err(Refused::Busy);
    }
    let id = Uuid::now_v7();
    free_scans::create(
        &mut tx,
        id,
        &site.domain,
        &site.registrable,
        &site.origin,
        &ip_hash,
    )
    .await?;
    free_scans::enqueue(&mut tx, id).await?;
    let created = free_scans::get(&mut tx, id).await?;
    tx.commit().await?;
    let Some(created) = created else {
        error!(scan = %id, "a free scan vanished inside its own transaction");
        return Err(ApiError::new(ProblemCode::Internal).into());
    };
    Ok((StatusCode::ACCEPTED, Json(dto(created, false))))
}

/// A free scan's state and result. The id is unguessable and the scan holds nothing about the
/// visitor; it is gone 24 hours after it was asked for.
#[utoipa::path(
    get,
    path = "/v1/free-scans/{id}",
    tag = "free-scanner",
    operation_id = "getFreeScan",
    security(("free_scan_service" = [])),
    params(("id" = String, Path, description = "The scan's id")),
    responses(
        (status = OK, description = "The scan", body = FreeScanDto),
        (status = NOT_FOUND, description = "No such scan, or it expired",
            body = http_kit::Problem, content_type = "application/problem+json")
    )
)]
pub(crate) async fn get_free_scan(
    State(state): State<AppState>,
    _service: Service,
    Path(id): Path<String>,
) -> Result<Json<FreeScanDto>, ApiError> {
    let id = Uuid::parse_str(&id).map_err(|_| ApiError::new(ProblemCode::NotFound))?;
    let mut tx = state.db.public().await?;
    let scan = free_scans::get(&mut tx, id).await?;
    tx.rollback().await?;
    let scan = scan.ok_or_else(|| ApiError::new(ProblemCode::NotFound))?;
    Ok(Json(dto(scan, false)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(input: &str) -> PublicSite {
        parse_public_url(input).unwrap_or_else(|e| panic!("{input}: {e:?}"))
    }

    #[test]
    fn a_bare_domain_becomes_its_https_home_page() {
        let site = ok("  Example-Shop.com  ");
        assert_eq!(site.origin, "https://example-shop.com/");
        assert_eq!(site.domain, "example-shop.com");
    }

    #[test]
    fn www_is_dropped_from_the_domain_only() {
        let site = ok("http://WWW.Shop.co.uk./any/path?x=1");
        assert_eq!(site.origin, "http://www.shop.co.uk/");
        assert_eq!(site.domain, "shop.co.uk");
    }

    #[test]
    fn what_cannot_be_a_public_site_is_refused_with_a_reason() {
        let cases = [
            ("", UrlRefusal::Empty),
            ("a b.com", UrlRefusal::Invalid),
            ("ftp://shop.com", UrlRefusal::Scheme),
            ("https://user:pw@shop.com", UrlRefusal::Credentials),
            ("shop.com:8443", UrlRefusal::Port),
            ("https://127.0.0.1", UrlRefusal::Address),
            ("http://2130706433", UrlRefusal::Address),
            ("http://0x7f.1", UrlRefusal::Address),
            ("https://[::1]/", UrlRefusal::Address),
            ("intranet", UrlRefusal::Private),
            ("printer.local", UrlRefusal::Private),
            ("metadata.internal", UrlRefusal::Private),
            ("-bad-.com", UrlRefusal::Invalid),
        ];
        for (input, reason) in cases {
            assert_eq!(parse_public_url(input), Err(reason), "{input}");
        }
    }

    #[test]
    fn the_daily_limit_is_keyed_on_the_registrable_domain() {
        let cases = [
            ("shop.com", "shop.com"),
            ("www.shop.com", "shop.com"),
            ("a.b.shop.com", "shop.com"),
            ("shop.co.uk", "shop.co.uk"),
            ("blog.shop.co.uk", "shop.co.uk"),
            // A private-section suffix: every `*.myshopify.com` store is its own site.
            ("store.myshopify.com", "store.myshopify.com"),
            ("deep.store.myshopify.com", "store.myshopify.com"),
            ("me.github.io", "me.github.io"),
        ];
        for (input, registrable) in cases {
            assert_eq!(ok(input).registrable, registrable, "{input}");
        }
        assert_eq!(ok("blog.shop.co.uk").domain, "blog.shop.co.uk");
    }

    #[test]
    fn a_public_suffix_is_refused_before_anything_is_spent() {
        for input in [
            "co.uk",
            "www.co.uk",
            "https://myshopify.com/",
            "github.io",
            "com.au",
            "blogspot.com",
        ] {
            assert_eq!(parse_public_url(input), Err(UrlRefusal::Suffix), "{input}");
        }
    }

    fn service() -> FreeScans {
        FreeScans::new(FreeScanSettings {
            service_token: SecretString::from("t".repeat(MIN_SERVICE_TOKEN)),
            turnstile_secret: SecretString::from("secret"),
            turnstile_origin: Url::parse("https://challenges.example/")
                .unwrap_or_else(|e| panic!("{e}")),
            turnstile_hostnames: Vec::new(),
        })
        .unwrap_or_else(|e| panic!("{e}"))
    }

    #[test]
    fn only_the_service_token_authenticates() {
        let free = service();
        assert!(free.authenticates(&"t".repeat(MIN_SERVICE_TOKEN)));
        assert!(!free.authenticates(&"t".repeat(MIN_SERVICE_TOKEN - 1)));
        assert!(!free.authenticates(""));
        assert!(!free.authenticates(&"u".repeat(MIN_SERVICE_TOKEN)));
    }

    #[test]
    fn a_short_service_token_is_refused_at_boot() {
        let refused = FreeScans::new(FreeScanSettings {
            service_token: SecretString::from("short"),
            turnstile_secret: SecretString::from("secret"),
            turnstile_origin: Url::parse("https://challenges.example/")
                .unwrap_or_else(|e| panic!("{e}")),
            turnstile_hostnames: Vec::new(),
        });
        assert!(refused.is_err(), "a short token was accepted");
    }

    #[test]
    fn the_address_hash_key_is_not_derivable_from_the_service_token() {
        let make = |token: &str, turnstile: &str| {
            FreeScans::new(FreeScanSettings {
                service_token: SecretString::from(token.repeat(MIN_SERVICE_TOKEN)),
                turnstile_secret: SecretString::from(turnstile),
                turnstile_origin: Url::parse("https://challenges.example/")
                    .unwrap_or_else(|e| panic!("{e}")),
                turnstile_hostnames: Vec::new(),
            })
            .unwrap_or_else(|e| panic!("{e}"))
        };
        let address: IpAddr = "203.0.113.9".parse().unwrap_or_else(|e| panic!("{e:?}"));
        let api = make("a", "api-only-secret");
        // Whoever holds the service token (the web server) and not the Turnstile secret gets a
        // different hash for the same address.
        assert_ne!(
            api.hash_address(address),
            make("a", "another-secret").hash_address(address)
        );
        // The hash does not depend on the service token at all, so rotating it keeps the day's counts.
        assert_eq!(
            api.hash_address(address),
            make("b", "api-only-secret").hash_address(address)
        );
    }

    #[test]
    fn addresses_in_one_ipv6_prefix_hash_alike_and_others_differ() {
        let free = service();
        let a: IpAddr = "2001:db8:1:2::1"
            .parse()
            .unwrap_or_else(|e| panic!("{e:?}"));
        let b: IpAddr = "2001:db8:1:2:ffff::9"
            .parse()
            .unwrap_or_else(|e| panic!("{e:?}"));
        let c: IpAddr = "2001:db8:1:3::1"
            .parse()
            .unwrap_or_else(|e| panic!("{e:?}"));
        assert_eq!(free.hash_address(a), free.hash_address(b));
        assert_ne!(free.hash_address(a), free.hash_address(c));
        let mapped: IpAddr = "::ffff:203.0.113.9"
            .parse()
            .unwrap_or_else(|e| panic!("{e:?}"));
        let plain: IpAddr = "203.0.113.9".parse().unwrap_or_else(|e| panic!("{e:?}"));
        assert_eq!(free.hash_address(mapped), free.hash_address(plain));
    }
}
