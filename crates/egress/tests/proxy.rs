//! The proxy end to end over real sockets, with a test resolver (ADR-025).

// Integration tests are test code: PLAN §8 denies these lints outside tests only.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::collections::HashMap;
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use egress::{AddressPolicy, Proxy, ProxyConfig, Resolve, ScanToken, TokenKey};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const SECRET: &[u8] = b"proxy-tests-secret-0123456789abcdef";

/// Names that resolve the way each test needs, including to private addresses.
#[derive(Clone, Default)]
struct Names(Arc<HashMap<String, Vec<IpAddr>>>);

impl Resolve for Names {
    fn resolve(
        &self,
        host: &str,
        port: u16,
    ) -> impl Future<Output = io::Result<Vec<SocketAddr>>> + Send {
        std::future::ready(
            self.0
                .get(host)
                .map(|ips| ips.iter().map(|ip| SocketAddr::new(*ip, port)).collect())
                .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "unknown name")),
        )
    }
}

fn ip(text: &str) -> IpAddr {
    text.parse().unwrap()
}

/// An upstream that answers HTTP with what it received and echoes raw bytes otherwise.
async fn upstream() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            tokio::spawn(async move {
                let mut buf = vec![0_u8; 4096];
                let n = socket.read(&mut buf).await.unwrap_or(0);
                let got = String::from_utf8_lossy(&buf[..n]).to_string();
                if got.starts_with("GET ") {
                    let body = format!(
                        "path={} host={} saw_proxy_auth={}",
                        got.split_whitespace().nth(1).unwrap_or(""),
                        got.lines()
                            .find_map(|l| l
                                .strip_prefix("host: ")
                                .or_else(|| l.strip_prefix("Host: ")))
                            .unwrap_or(""),
                        got.to_ascii_lowercase().contains("proxy-authorization")
                    );
                    let reply = format!(
                        "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = socket.write_all(reply.as_bytes()).await;
                } else {
                    let _ = socket.write_all(format!("echo:{got}").as_bytes()).await;
                }
            });
        }
    });
    port
}

struct Harness {
    proxy: SocketAddr,
    upstream: u16,
    key: TokenKey,
}

async fn harness(policy: AddressPolicy) -> Harness {
    let upstream = upstream().await;
    let names = Names(Arc::new(HashMap::from([
        ("shop.test".to_owned(), vec![ip("127.0.0.1")]),
        ("private.test".to_owned(), vec![ip("10.0.0.5")]),
        (
            "rebind.test".to_owned(),
            vec![ip("8.8.8.8"), ip("10.0.0.9")],
        ),
        ("metadata.test".to_owned(), vec![ip("169.254.169.254")]),
    ])));
    let key = TokenKey::new(SECRET).unwrap();
    let mut config = ProxyConfig::new(policy, key.clone());
    config.tunnel_ports = vec![upstream];
    config.http_ports = vec![upstream];
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy = listener.local_addr().unwrap();
    tokio::spawn(Proxy::new(config, names).serve(listener, std::future::pending()));
    Harness {
        proxy,
        upstream,
        key,
    }
}

/// The test network: loopback opened as an explicit exception, everything else default.
async fn test_network() -> Harness {
    harness(AddressPolicy::default().allowing(&["127.0.0.0/8".parse().unwrap()])).await
}

/// The expiry of a freshly signed token: the engine's two minutes (ADR-025). Egress refuses
/// tokens that expire more than five minutes ahead (audit L14).
fn two_minutes_from_now() -> i64 {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    i64::try_from(now).unwrap() + 120
}

fn token(h: &Harness, hosts: &[&str], budget: u32) -> String {
    h.key
        .sign(&ScanToken {
            v: 1,
            scan: "test-scan".to_owned(),
            hosts: hosts.iter().map(|s| (*s).to_owned()).collect(),
            budget,
            exp: two_minutes_from_now(),
        })
        .unwrap()
}

fn auth(token: &str) -> String {
    format!(
        "Proxy-Authorization: Basic {}\r\n",
        STANDARD.encode(format!("rampsmith:{token}"))
    )
}

/// Sends a raw request head; returns the status code and the stream for further use.
async fn send(h: &Harness, head: &str) -> (u16, String, TcpStream) {
    let mut stream = TcpStream::connect(h.proxy).await.unwrap();
    stream.write_all(head.as_bytes()).await.unwrap();
    let mut buf = vec![0_u8; 4096];
    let n = stream.read(&mut buf).await.unwrap();
    let text = String::from_utf8_lossy(&buf[..n]).to_string();
    let status = text.split_whitespace().nth(1).unwrap().parse().unwrap();
    (status, text, stream)
}

async fn connect(h: &Harness, host: &str, token: Option<&str>) -> (u16, String, TcpStream) {
    let target = format!("{host}:{}", h.upstream);
    let auth = token.map(auth).unwrap_or_default();
    send(
        h,
        &format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n{auth}\r\n"),
    )
    .await
}

#[tokio::test]
async fn a_tunnel_to_an_allowed_host_relays_bytes() {
    let h = test_network().await;
    let t = token(&h, &["shop.test"], 10);
    let (status, _, mut stream) = connect(&h, "shop.test", Some(&t)).await;
    assert_eq!(status, 200);
    stream.write_all(b"ping").await.unwrap();
    let mut buf = vec![0_u8; 64];
    let n = stream.read(&mut buf).await.unwrap();
    assert_eq!(&buf[..n], b"echo:ping");
}

#[tokio::test]
async fn plain_http_is_forwarded_without_the_proxy_credentials() {
    let h = test_network().await;
    let t = token(&h, &["shop.test"], 10);
    let url = format!("http://shop.test:{}/products/a?x=1", h.upstream);
    let (status, text, _) = send(
        &h,
        &format!(
            "GET {url} HTTP/1.1\r\nHost: shop.test\r\nConnection: close\r\n{}\r\n",
            auth(&t)
        ),
    )
    .await;
    assert_eq!(status, 200, "{text}");
    assert!(text.contains("path=/products/a?x=1"), "{text}");
    assert!(text.contains("host=shop.test"), "{text}");
    assert!(text.contains("saw_proxy_auth=false"), "{text}");
}

#[tokio::test]
async fn requests_without_a_valid_token_must_authenticate() {
    let h = test_network().await;
    let (status, text, _) = connect(&h, "shop.test", None).await;
    assert_eq!(status, 407);
    assert!(
        text.to_ascii_lowercase()
            .contains("proxy-authenticate: basic"),
        "{text}"
    );
    let forged = TokenKey::new(b"another-secret-another-secret-0123")
        .unwrap()
        .sign(&ScanToken {
            v: 1,
            scan: "x".to_owned(),
            hosts: vec!["shop.test".to_owned()],
            budget: 10,
            exp: two_minutes_from_now(),
        })
        .unwrap();
    let (status, _, _) = connect(&h, "shop.test", Some(&forged)).await;
    assert_eq!(status, 407);
}

/// Audit L14: a correctly signed token that expires more than five minutes ahead is not one
/// the engine would have made, and gets the same 407 as a forged one.
#[tokio::test]
async fn a_token_that_expires_too_far_ahead_must_authenticate_again() {
    let h = test_network().await;
    let distant = h
        .key
        .sign(&ScanToken {
            v: 1,
            scan: "test-scan".to_owned(),
            hosts: vec!["shop.test".to_owned()],
            budget: 10,
            exp: two_minutes_from_now() + 3_600,
        })
        .unwrap();
    let (status, _, _) = connect(&h, "shop.test", Some(&distant)).await;
    assert_eq!(status, 407);
    let (status, _, _) = connect(&h, "shop.test", Some(&token(&h, &["shop.test"], 10))).await;
    assert_eq!(status, 200);
}

#[tokio::test]
async fn hosts_off_the_token_list_are_refused() {
    let h = test_network().await;
    let t = token(&h, &["other.test"], 10);
    let (status, _, _) = connect(&h, "shop.test", Some(&t)).await;
    assert_eq!(status, 403);
    // An IP literal is a host like any other: not on the list, not reachable.
    let (status, _, _) = connect(&h, "127.0.0.1", Some(&t)).await;
    assert_eq!(status, 403);
}

#[tokio::test]
async fn names_resolving_to_non_public_addresses_are_refused() {
    let h = test_network().await;
    let t = token(
        &h,
        &["private.test", "rebind.test", "metadata.test", "10.0.0.5"],
        10,
    );
    for host in ["private.test", "rebind.test", "metadata.test", "10.0.0.5"] {
        let (status, _, _) = connect(&h, host, Some(&t)).await;
        assert_eq!(status, 403, "{host}");
    }
}

#[tokio::test]
async fn loopback_is_refused_without_an_explicit_exception() {
    let h = harness(AddressPolicy::default()).await;
    let t = token(&h, &["shop.test"], 10);
    let (status, _, _) = connect(&h, "shop.test", Some(&t)).await;
    assert_eq!(status, 403);
}

#[tokio::test]
async fn only_the_configured_ports_are_proxied() {
    let h = test_network().await;
    let t = token(&h, &["shop.test"], 10);
    let (status, _, _) = send(
        &h,
        &format!(
            "CONNECT shop.test:22 HTTP/1.1\r\nHost: shop.test:22\r\n{}\r\n",
            auth(&t)
        ),
    )
    .await;
    assert_eq!(status, 403);
    // HTTPS in absolute form (not CONNECT) is not a proxy request egress serves.
    let (status, _, _) = send(
        &h,
        &format!(
            "GET https://shop.test/ HTTP/1.1\r\nHost: shop.test\r\n{}\r\n",
            auth(&t)
        ),
    )
    .await;
    assert_eq!(status, 400);
}

#[tokio::test]
async fn the_connection_budget_is_enforced_per_token() {
    let h = test_network().await;
    let t = token(&h, &["shop.test"], 2);
    for _ in 0..2 {
        let (status, _, _) = connect(&h, "shop.test", Some(&t)).await;
        assert_eq!(status, 200);
    }
    let (status, _, _) = connect(&h, "shop.test", Some(&t)).await;
    assert_eq!(status, 429);
    // Another token has its own budget.
    let other = token(&h, &["shop.test"], 1);
    let (status, _, _) = connect(&h, "shop.test", Some(&other)).await;
    assert_eq!(status, 200);
}

// --- Log hygiene (audit L7, PLAN §19) ------------------------------------------------------

/// Records every span and event it is told about as one line of text each: the name, then each
/// field as `name=value`.
struct Capture {
    lines: Arc<Mutex<Vec<String>>>,
    next_span: AtomicU64,
    /// Each span's metadata and the stack of entered spans, so `Span::current()` works the way
    /// it does under the production subscriber (the proxy records the scan id through it).
    spans: Mutex<HashMap<u64, &'static tracing::Metadata<'static>>>,
    stack: Mutex<Vec<u64>>,
}

struct Fields<'a>(&'a mut String);

impl tracing::field::Visit for Fields<'_> {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        use std::fmt::Write as _;
        let _ = write!(self.0, " {}={value:?}", field.name());
    }
}

impl Capture {
    fn push(&self, line: String) {
        self.lines.lock().unwrap().push(line);
    }
}

impl tracing::Subscriber for Capture {
    fn enabled(&self, _: &tracing::Metadata<'_>) -> bool {
        true
    }

    fn new_span(&self, attributes: &tracing::span::Attributes<'_>) -> tracing::span::Id {
        let mut line = format!("span {}", attributes.metadata().name());
        attributes.record(&mut Fields(&mut line));
        self.push(line);
        let id = self.next_span.fetch_add(1, Ordering::Relaxed);
        self.spans.lock().unwrap().insert(id, attributes.metadata());
        tracing::span::Id::from_u64(id)
    }

    fn record(&self, _: &tracing::span::Id, values: &tracing::span::Record<'_>) {
        let mut line = String::from("record");
        values.record(&mut Fields(&mut line));
        self.push(line);
    }

    fn record_follows_from(&self, _: &tracing::span::Id, _: &tracing::span::Id) {}

    fn event(&self, event: &tracing::Event<'_>) {
        let mut line = format!("event {}", event.metadata().name());
        event.record(&mut Fields(&mut line));
        self.push(line);
    }

    fn enter(&self, span: &tracing::span::Id) {
        self.stack.lock().unwrap().push(span.into_u64());
    }

    fn exit(&self, span: &tracing::span::Id) {
        let mut stack = self.stack.lock().unwrap();
        if let Some(at) = stack.iter().rposition(|id| *id == span.into_u64()) {
            stack.remove(at);
        }
    }

    fn current_span(&self) -> tracing_core::span::Current {
        let top = self.stack.lock().unwrap().last().copied();
        match top.and_then(|id| self.spans.lock().unwrap().get(&id).map(|meta| (id, *meta))) {
            Some((id, meta)) => {
                tracing_core::span::Current::new(tracing::span::Id::from_u64(id), meta)
            }
            None => tracing_core::span::Current::none(),
        }
    }
}

/// ADR-264: Railway's health check gets 200 on exactly `GET /healthz` in origin form, without a
/// token, and that path can never be used to reach anything.
#[tokio::test]
async fn the_health_check_answers_for_the_process_and_is_never_proxied() {
    let h = test_network().await;
    let t = token(&h, &["shop.test"], 10);

    // Railway's request: origin form, its own Host header.
    let (status, text, _) = send(
        &h,
        "GET /healthz HTTP/1.1\r\nHost: healthcheck.railway.app\r\nConnection: close\r\n\r\n",
    )
    .await;
    assert_eq!(status, 200, "{text}");
    assert!(text.ends_with("ok"), "{text}");
    // A Host header naming a proxy target does not turn the check into a forward: the upstream
    // answers `path=...`, the health check answers `ok`.
    let (status, text, _) = send(
        &h,
        &format!(
            "GET /healthz HTTP/1.1\r\nHost: shop.test:{}\r\nConnection: close\r\n{}\r\n",
            h.upstream,
            auth(&t)
        ),
    )
    .await;
    assert_eq!(status, 200, "{text}");
    assert!(!text.contains("path="), "forwarded to the upstream: {text}");

    // Every other shape still needs a token: another path, a query, a trailing slash, another
    // method, a proxy-form URI that happens to end in /healthz, and a tunnel.
    let absolute = format!("http://shop.test:{}/healthz", h.upstream);
    for head in [
        "GET /healthz/ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n".to_owned(),
        "GET /healthz?x=1 HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n".to_owned(),
        "GET /healthzz HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n".to_owned(),
        "GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n".to_owned(),
        "POST /healthz HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            .to_owned(),
        format!("GET {absolute} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"),
    ] {
        let (status, text, _) = send(&h, &head).await;
        assert_eq!(status, 407, "{head}\n{text}");
    }
    let (status, _, _) = connect(&h, "shop.test", None).await;
    assert_eq!(status, 407);

    // With a token, origin-form requests other than the health check are malformed proxy
    // requests, not forwards; the absolute form is forwarded only to a host on the token's list.
    let (status, text, _) = send(
        &h,
        &format!(
            "GET /healthz/ HTTP/1.1\r\nHost: shop.test\r\nConnection: close\r\n{}\r\n",
            auth(&t)
        ),
    )
    .await;
    assert_eq!(status, 400, "{text}");
    let (status, text, _) = send(
        &h,
        &format!(
            "GET http://other.test:{}/healthz HTTP/1.1\r\nHost: x\r\nConnection: close\r\n{}\r\n",
            h.upstream,
            auth(&t)
        ),
    )
    .await;
    assert_eq!(status, 403, "{text}");
}

/// The proxy serves allowed and refused requests for named hosts; what it tells `tracing` names
/// the scan and the outcome and never a host.
#[tokio::test]
async fn spans_and_logs_never_contain_the_merchants_host() {
    let lines = Arc::new(Mutex::new(Vec::new()));
    let _guard = tracing::subscriber::set_default(Capture {
        lines: lines.clone(),
        next_span: AtomicU64::new(1),
        spans: Mutex::new(HashMap::new()),
        stack: Mutex::new(Vec::new()),
    });
    // Other tests in this binary may have cached "no interest" for the proxy's callsites while
    // no subscriber was set; ask every callsite again now that this one is.
    tracing::callsite::rebuild_interest_cache();
    let h = test_network().await;
    let t = token(&h, &["shop.test", "private.test"], 20);

    // Allowed: a tunnel, and a plain HTTP request.
    let (status, _, _) = connect(&h, "shop.test", Some(&t)).await;
    assert_eq!(status, 200);
    let url = format!("http://shop.test:{}/products/a", h.upstream);
    let (status, _, _) = send(
        &h,
        &format!(
            "GET {url} HTTP/1.1\r\nHost: shop.test\r\nConnection: close\r\n{}\r\n",
            auth(&t)
        ),
    )
    .await;
    assert_eq!(status, 200);
    // Refused: a host off the token's list, a name that resolves to a private address, and a
    // request with no token at all.
    let (status, _, _) = connect(&h, "other.test", Some(&t)).await;
    assert_eq!(status, 403);
    let (status, _, _) = connect(&h, "private.test", Some(&t)).await;
    assert_eq!(status, 403);
    let (status, _, _) = connect(&h, "shop.test", None).await;
    assert_eq!(status, 407);

    let lines = lines.lock().unwrap().join("\n");
    assert!(lines.contains("span egress.request"), "{lines}");
    assert!(lines.contains("scan=\"test-scan\""), "{lines}");
    assert!(lines.contains("outcome=\"host_not_allowed\""), "{lines}");
    for host in ["shop.test", "other.test", "private.test"] {
        assert!(!lines.contains(host), "{host} was recorded:\n{lines}");
    }
}
