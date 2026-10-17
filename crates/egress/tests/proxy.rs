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
use std::sync::Arc;

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
    async fn resolve(&self, host: &str, port: u16) -> io::Result<Vec<SocketAddr>> {
        self.0
            .get(host)
            .map(|ips| ips.iter().map(|ip| SocketAddr::new(*ip, port)).collect())
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "unknown name"))
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

fn token(h: &Harness, hosts: &[&str], budget: u32) -> String {
    h.key
        .sign(&ScanToken {
            v: 1,
            scan: "test-scan".to_owned(),
            hosts: hosts.iter().map(|s| (*s).to_owned()).collect(),
            budget,
            exp: 4_102_444_800, // 2100-01-01
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
            exp: 4_102_444_800,
        })
        .unwrap();
    let (status, _, _) = connect(&h, "shop.test", Some(&forged)).await;
    assert_eq!(status, 407);
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
