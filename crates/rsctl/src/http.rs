//! The one HTTP client every probe uses (ADR-151).
//!
//! - Credentials go only over HTTPS. A plain-HTTP URL is accepted only for a loopback host,
//!   which is how the substitute tests reach their fake servers.
//! - Redirects are never followed: a custom credential header (`x-api-key`,
//!   `X-Shopify-Access-Token`, ...) would travel with them.
//! - Errors are a closed set with fixed messages. The text of a transport error can contain
//!   the URL, so it is never kept.
//! - Bodies are read up to a limit, so a hostile or broken endpoint cannot exhaust memory.

use std::time::Duration;

use reqwest::{Method, RequestBuilder};
use serde::de::DeserializeOwned;
use url::{Host, Url};

/// Largest response body a probe reads.
pub const MAX_BODY: usize = 1024 * 1024;

/// Why a request produced no response. Messages are fixed text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum HttpError {
    /// The URL is not usable (bad syntax, no host).
    #[error("the endpoint URL is not valid")]
    BadUrl,
    /// Credentials would travel over plain HTTP to a non-loopback host.
    #[error("the endpoint must use https")]
    Insecure,
    /// No answer within the timeout.
    #[error("timed out")]
    Timeout,
    /// DNS, TCP or TLS failed.
    #[error("could not connect (DNS, TCP or TLS)")]
    Connect,
    /// The connection broke while the response was being read.
    #[error("the connection broke while reading the response")]
    Body,
    /// Any other client failure.
    #[error("the request could not be sent")]
    Request,
}

/// A response: status, selected headers and the (capped) body.
#[derive(Debug, Clone)]
pub struct Reply {
    /// The HTTP status code.
    pub status: u16,
    /// Header names (lower-case) and values that were valid text.
    pub headers: Vec<(String, String)>,
    /// The body, at most [`MAX_BODY`] bytes.
    pub body: Vec<u8>,
    /// Whether the body was cut at [`MAX_BODY`].
    pub truncated: bool,
}

impl Reply {
    /// Whether the status is 2xx.
    #[must_use]
    pub const fn is_success(&self) -> bool {
        self.status >= 200 && self.status < 300
    }

    /// A header's value.
    #[must_use]
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    /// The body parsed as JSON, or `None` when it is not valid JSON of type `T`.
    #[must_use]
    pub fn json<T: DeserializeOwned>(&self) -> Option<T> {
        serde_json::from_slice(&self.body).ok()
    }

    /// The body as text, with invalid UTF-8 replaced.
    #[must_use]
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

/// The shared client.
#[derive(Debug, Clone)]
pub struct Http {
    client: reqwest::Client,
}

impl Http {
    /// A client whose requests time out after `timeout`.
    pub fn new(timeout: Duration) -> Result<Self, HttpError> {
        let client = reqwest::Client::builder()
            .timeout(timeout)
            .connect_timeout(timeout)
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(concat!("rsctl/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|_| HttpError::Request)?;
        Ok(Self { client })
    }

    /// A request builder for `url`, after checking that credentials may be sent there.
    pub fn request(&self, method: Method, url: &str) -> Result<RequestBuilder, HttpError> {
        let parsed = check_url(url)?;
        Ok(self.client.request(method, parsed))
    }

    /// Sends a request and reads the response.
    pub async fn send(&self, request: RequestBuilder) -> Result<Reply, HttpError> {
        let mut response = request.send().await.map_err(|e| classify(&e))?;
        let status = response.status().as_u16();
        let headers = response
            .headers()
            .iter()
            .filter_map(|(name, value)| {
                value
                    .to_str()
                    .ok()
                    .map(|v| (name.as_str().to_ascii_lowercase(), v.to_owned()))
            })
            .collect();
        let mut body = Vec::new();
        let mut truncated = false;
        while let Some(chunk) = response.chunk().await.map_err(|e| classify(&e))? {
            let room = MAX_BODY.saturating_sub(body.len());
            if chunk.len() > room {
                body.extend_from_slice(chunk.get(..room).unwrap_or_default());
                truncated = true;
                break;
            }
            body.extend_from_slice(&chunk);
        }
        Ok(Reply {
            status,
            headers,
            body,
            truncated,
        })
    }
}

fn classify(error: &reqwest::Error) -> HttpError {
    if error.is_timeout() {
        HttpError::Timeout
    } else if error.is_connect() {
        HttpError::Connect
    } else if error.is_body() || error.is_decode() {
        HttpError::Body
    } else {
        HttpError::Request
    }
}

/// Parses `url` and applies the transport rule: HTTPS, or HTTP to a loopback host.
pub fn check_url(url: &str) -> Result<Url, HttpError> {
    let parsed = Url::parse(url).map_err(|_| HttpError::BadUrl)?;
    let host = parsed.host().ok_or(HttpError::BadUrl)?;
    match parsed.scheme() {
        "https" => Ok(parsed),
        "http" if is_loopback(&host) => Ok(parsed),
        "http" => Err(HttpError::Insecure),
        _ => Err(HttpError::BadUrl),
    }
}

fn is_loopback(host: &Host<&str>) -> bool {
    match host {
        Host::Domain(name) => name.eq_ignore_ascii_case("localhost"),
        Host::Ipv4(ip) => ip.is_loopback(),
        Host::Ipv6(ip) => ip.is_loopback(),
    }
}

/// `host` or `host:port`, as the `Host` header carries it. `SigV4` signs exactly this.
#[must_use]
pub fn authority(url: &Url) -> String {
    let host = url.host_str().unwrap_or_default();
    match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credentials_only_travel_over_https_or_loopback() {
        assert!(check_url("https://api.anthropic.com/v1/models").is_ok());
        assert!(check_url("http://127.0.0.1:8080/x").is_ok());
        assert!(check_url("http://localhost:8080/x").is_ok());
        assert!(check_url("http://[::1]:8080/x").is_ok());
        assert_eq!(
            check_url("http://api.anthropic.com/").unwrap_err(),
            HttpError::Insecure
        );
        assert_eq!(
            check_url("http://10.0.0.5/").unwrap_err(),
            HttpError::Insecure
        );
        assert_eq!(
            check_url("ftp://example.com/").unwrap_err(),
            HttpError::BadUrl
        );
        assert_eq!(check_url("not a url").unwrap_err(), HttpError::BadUrl);
    }

    #[test]
    fn authority_includes_a_non_default_port_only() {
        assert_eq!(
            authority(&Url::parse("https://a.example.com/x").unwrap()),
            "a.example.com"
        );
        assert_eq!(
            authority(&Url::parse("https://a.example.com:443/x").unwrap()),
            "a.example.com"
        );
        assert_eq!(
            authority(&Url::parse("http://127.0.0.1:8080/x").unwrap()),
            "127.0.0.1:8080"
        );
    }
}
