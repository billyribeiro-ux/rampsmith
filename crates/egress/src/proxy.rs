//! The proxy server: authenticate, authorise, resolve, check, connect, relay.

use std::collections::HashMap;
use std::convert::Infallible;
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use bytes::Bytes;
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Empty, Full};
use hyper::body::Incoming;
use hyper::header::{self, HeaderMap, HeaderName, HeaderValue};
use hyper::{Method, Request, Response, StatusCode, Uri};
use hyper_util::rt::TokioIo;
use opentelemetry::KeyValue;
use opentelemetry::metrics::Counter;
use tokio::net::{TcpListener, TcpStream};
use tracing::{Instrument, debug, info, info_span, warn};

use crate::{AddressPolicy, Refusal, ScanToken, TokenKey};

type Body = BoxBody<Bytes, hyper::Error>;

/// Resolves a host name. The default uses the system resolver; tests substitute their own.
pub trait Resolve: Send + Sync + 'static {
    /// Every address `host` resolves to, with `port`.
    fn resolve(
        &self,
        host: &str,
        port: u16,
    ) -> impl Future<Output = io::Result<Vec<SocketAddr>>> + Send;
}

/// The operating system's resolver.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemResolver;

impl Resolve for SystemResolver {
    async fn resolve(&self, host: &str, port: u16) -> io::Result<Vec<SocketAddr>> {
        Ok(tokio::net::lookup_host((host, port)).await?.collect())
    }
}

/// How egress behaves.
#[derive(Debug, Clone)]
pub struct ProxyConfig {
    /// Which addresses may be reached.
    pub policy: AddressPolicy,
    /// Verifies scan tokens.
    pub key: TokenKey,
    /// Per-address connect timeout.
    pub connect_timeout: Duration,
    /// The longest a tunnel or forwarded request may stay open.
    pub max_connection: Duration,
    /// Ports `CONNECT` may reach: 443.
    pub tunnel_ports: Vec<u16>,
    /// Ports plain `http://` requests may reach: 80.
    pub http_ports: Vec<u16>,
}

impl ProxyConfig {
    /// Defaults: 10-second connects, five-minute connections, ports 443 and 80.
    #[must_use]
    pub fn new(policy: AddressPolicy, key: TokenKey) -> Self {
        Self {
            policy,
            key,
            connect_timeout: Duration::from_secs(10),
            max_connection: Duration::from_mins(5),
            tunnel_ports: vec![443],
            http_ports: vec![80],
        }
    }
}

struct Inner<R> {
    config: ProxyConfig,
    resolver: R,
    /// Connections used per token (keyed by the token's signature), with its expiry.
    budgets: Mutex<HashMap<String, (u32, i64)>>,
    requests: Counter<u64>,
}

/// The egress proxy.
pub struct Proxy<R: Resolve> {
    inner: Arc<Inner<R>>,
}

impl<R: Resolve> Clone for Proxy<R> {
    fn clone(&self) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
        }
    }
}

impl<R: Resolve> std::fmt::Debug for Proxy<R> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Proxy").finish_non_exhaustive()
    }
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
}

fn empty() -> Body {
    Empty::<Bytes>::new()
        .map_err(|never| match never {})
        .boxed()
}

fn text(status: StatusCode, message: &'static str) -> Response<Body> {
    let mut response = Response::new(
        Full::new(Bytes::from_static(message.as_bytes()))
            .map_err(|never| match never {})
            .boxed(),
    );
    *response.status_mut() = status;
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain"));
    response
}

fn refusal_response(refusal: &Refusal) -> Response<Body> {
    match refusal {
        Refusal::BadToken => {
            let mut response = text(
                StatusCode::PROXY_AUTHENTICATION_REQUIRED,
                "scan token required",
            );
            response.headers_mut().insert(
                header::PROXY_AUTHENTICATE,
                HeaderValue::from_static("Basic realm=\"rampsmith-egress\""),
            );
            response
        }
        Refusal::HostNotAllowed | Refusal::PortNotAllowed | Refusal::NonPublicAddress(_) => {
            text(StatusCode::FORBIDDEN, "destination not allowed")
        }
        Refusal::BudgetExhausted => text(StatusCode::TOO_MANY_REQUESTS, "request budget exhausted"),
        Refusal::Malformed => text(StatusCode::BAD_REQUEST, "malformed proxy request"),
        Refusal::NoAddress | Refusal::Unreachable | Refusal::Misconfigured(_) => {
            text(StatusCode::BAD_GATEWAY, "upstream unreachable")
        }
    }
}

/// The password of a `Proxy-Authorization: Basic` header.
fn proxy_password(headers: &HeaderMap) -> Option<String> {
    let value = headers.get(header::PROXY_AUTHORIZATION)?.to_str().ok()?;
    let (scheme, encoded) = value.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("basic") {
        return None;
    }
    let decoded = String::from_utf8(STANDARD.decode(encoded.trim()).ok()?).ok()?;
    let (_, password) = decoded.split_once(':')?;
    Some(password.to_owned())
}

/// Where a request wants to go: CONNECT authority, or an absolute `http://` URI.
fn destination(req: &Request<Incoming>, config: &ProxyConfig) -> Result<(String, u16), Refusal> {
    let uri = req.uri();
    if req.method() == Method::CONNECT {
        let authority = uri.authority().ok_or(Refusal::Malformed)?;
        let port = authority.port_u16().ok_or(Refusal::Malformed)?;
        if !config.tunnel_ports.contains(&port) {
            return Err(Refusal::PortNotAllowed);
        }
        return Ok((authority.host().to_owned(), port));
    }
    if uri.scheme_str() != Some("http") {
        return Err(Refusal::Malformed);
    }
    let host = uri.host().ok_or(Refusal::Malformed)?;
    let port = uri.port_u16().unwrap_or(80);
    if !config.http_ports.contains(&port) {
        return Err(Refusal::PortNotAllowed);
    }
    Ok((host.to_owned(), port))
}

/// Railway's deploy health check (ADR-264): `GET /healthz` in origin form, exactly. A proxy
/// request always names its destination (a `CONNECT` authority or an absolute `http://` URI),
/// so a request with neither scheme nor authority can never be a proxy target: this path
/// answers for the process itself and forwards nothing. Anything else, including a query, a
/// trailing slash or another method, takes the normal path and needs a scan token.
fn is_health_check(req: &Request<Incoming>) -> bool {
    let uri = req.uri();
    req.method() == Method::GET
        && uri.scheme().is_none()
        && uri.authority().is_none()
        && uri.path() == "/healthz"
        && uri.query().is_none()
}

/// Headers that belong to one hop and never travel on (RFC 9110 §7.6.1).
const HOP_BY_HOP: &[HeaderName] = &[
    header::CONNECTION,
    header::PROXY_AUTHENTICATE,
    header::PROXY_AUTHORIZATION,
    header::TE,
    header::TRAILER,
    header::TRANSFER_ENCODING,
    header::UPGRADE,
];

fn strip_hop_by_hop(headers: &mut HeaderMap) {
    let named: Vec<HeaderName> = headers
        .get_all(header::CONNECTION)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .filter_map(|name| HeaderName::from_bytes(name.trim().as_bytes()).ok())
        .collect();
    for name in HOP_BY_HOP.iter().chain(named.iter()) {
        headers.remove(name);
    }
    headers.remove("proxy-connection");
    headers.remove("keep-alive");
}

impl<R: Resolve> Proxy<R> {
    /// A proxy with `config`, resolving names with `resolver`.
    pub fn new(config: ProxyConfig, resolver: R) -> Self {
        let requests = opentelemetry::global::meter("rampsmith.egress")
            .u64_counter("rampsmith.egress.requests")
            .with_description("Proxy requests by outcome")
            .build();
        Self {
            inner: Arc::new(Inner {
                config,
                resolver,
                budgets: Mutex::new(HashMap::new()),
                requests,
            }),
        }
    }

    /// Accepts connections on `listener` until `shutdown` resolves.
    pub async fn serve(self, listener: TcpListener, shutdown: impl Future<Output = ()>) {
        tokio::pin!(shutdown);
        loop {
            let accepted = tokio::select! {
                () = &mut shutdown => return,
                accepted = listener.accept() => accepted,
            };
            let (stream, peer) = match accepted {
                Ok(pair) => pair,
                Err(error) => {
                    warn!(%error, "accept failed");
                    continue;
                }
            };
            let proxy = self.clone();
            tokio::spawn(async move {
                let service = hyper::service::service_fn(move |req| {
                    let proxy = proxy.clone();
                    async move { Ok::<_, Infallible>(proxy.handle(req).await) }
                });
                if let Err(error) = hyper::server::conn::http1::Builder::new()
                    .serve_connection(TokioIo::new(stream), service)
                    .with_upgrades()
                    .await
                {
                    debug!(%error, %peer, "client connection ended with an error");
                }
            });
        }
    }

    async fn handle(&self, req: Request<Incoming>) -> Response<Body> {
        if is_health_check(&req) {
            return text(StatusCode::OK, "ok");
        }
        let span = info_span!(
            "egress.request",
            http.request.method = %req.method(),
            scan = tracing::field::Empty,
            outcome = tracing::field::Empty,
        );
        let result = self.route(req).instrument(span.clone()).await;
        let outcome = match &result {
            Ok(_) => "allowed",
            Err(refusal) => refusal.reason(),
        };
        span.record("outcome", outcome);
        self.inner
            .requests
            .add(1, &[KeyValue::new("outcome", outcome)]);
        match result {
            Ok(response) => response,
            Err(refusal) => {
                info!(parent: &span, %refusal, "refused");
                refusal_response(&refusal)
            }
        }
    }

    fn take_budget(&self, token: &ScanToken, signature: &str) -> Result<(), Refusal> {
        let mut budgets = self
            .inner
            .budgets
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let now = now();
        budgets.retain(|_, (_, exp)| *exp > now);
        let used = budgets
            .entry(signature.to_owned())
            .or_insert((0, token.exp));
        if used.0 >= token.budget {
            return Err(Refusal::BudgetExhausted);
        }
        used.0 += 1;
        Ok(())
    }

    async fn connect(&self, host: &str, port: u16) -> Result<TcpStream, Refusal> {
        let addrs: Vec<SocketAddr> = match host.trim_matches(['[', ']']).parse::<IpAddr>() {
            Ok(ip) => vec![SocketAddr::new(ip, port)],
            Err(_) => self
                .inner
                .resolver
                .resolve(host, port)
                .await
                .map_err(|_| Refusal::NoAddress)?,
        };
        let ips: Vec<IpAddr> = addrs.iter().map(SocketAddr::ip).collect();
        self.inner.config.policy.check_all(&ips)?;
        for addr in addrs {
            match tokio::time::timeout(self.inner.config.connect_timeout, TcpStream::connect(addr))
                .await
            {
                Ok(Ok(stream)) => return Ok(stream),
                Ok(Err(error)) => debug!(%error, %addr, "connect failed"),
                Err(_) => debug!(%addr, "connect timed out"),
            }
        }
        Err(Refusal::Unreachable)
    }

    async fn route(&self, req: Request<Incoming>) -> Result<Response<Body>, Refusal> {
        let password = proxy_password(req.headers()).ok_or(Refusal::BadToken)?;
        let token = self.inner.config.key.verify(&password, now())?;
        tracing::Span::current().record("scan", token.scan.as_str());
        let (host, port) = destination(&req, &self.inner.config)?;
        // The host is not recorded: spans and logs carry ids, never merchant domains (PLAN §19,
        // audit L7). The scan id above is how an operator finds the page job.
        if !token.allows(&host) {
            return Err(Refusal::HostNotAllowed);
        }
        let signature = password.rsplit('.').next().unwrap_or_default();
        self.take_budget(&token, signature)?;
        let upstream = self.connect(&host, port).await?;

        if req.method() == Method::CONNECT {
            let max = self.inner.config.max_connection;
            tokio::spawn(
                async move {
                    match hyper::upgrade::on(req).await {
                        Ok(upgraded) => {
                            let mut client = TokioIo::new(upgraded);
                            let mut upstream = upstream;
                            let copied = tokio::time::timeout(
                                max,
                                tokio::io::copy_bidirectional(&mut client, &mut upstream),
                            )
                            .await;
                            debug!(?copied, "tunnel closed");
                        }
                        Err(error) => debug!(%error, "upgrade failed"),
                    }
                }
                .in_current_span(),
            );
            let mut response = Response::new(empty());
            *response.status_mut() = StatusCode::OK;
            return Ok(response);
        }
        self.forward(req, &host, upstream).await
    }

    async fn forward(
        &self,
        req: Request<Incoming>,
        host: &str,
        upstream: TcpStream,
    ) -> Result<Response<Body>, Refusal> {
        let (mut parts, body) = req.into_parts();
        let path = parts
            .uri
            .path_and_query()
            .map_or("/", hyper::http::uri::PathAndQuery::as_str)
            .to_owned();
        parts.uri = Uri::try_from(path).map_err(|_| Refusal::Malformed)?;
        strip_hop_by_hop(&mut parts.headers);
        parts.headers.insert(
            header::HOST,
            HeaderValue::from_str(host).map_err(|_| Refusal::Malformed)?,
        );
        let (mut sender, connection) =
            hyper::client::conn::http1::handshake(TokioIo::new(upstream))
                .await
                .map_err(|_| Refusal::Unreachable)?;
        let max = self.inner.config.max_connection;
        tokio::spawn(async move {
            let _ = tokio::time::timeout(max, connection).await;
        });
        let response = sender
            .send_request(Request::from_parts(parts, body))
            .await
            .map_err(|_| Refusal::Unreachable)?;
        let (mut parts, body) = response.into_parts();
        strip_hop_by_hop(&mut parts.headers);
        Ok(Response::from_parts(parts, body.boxed()))
    }
}
