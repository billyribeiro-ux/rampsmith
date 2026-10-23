//! The listeners close a connection that does not finish its request head (re-audit L-6).

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::time::{Duration, Instant};

use api::serve::serve_with;
use axum::Router;
use axum::routing::get;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;

async fn start(
    timeout: Duration,
) -> (
    std::net::SocketAddr,
    oneshot::Sender<()>,
    tokio::task::JoinHandle<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (stop, stopped) = oneshot::channel::<()>();
    let router = Router::new().route("/ping", get(|| async { "pong" }));
    let task = tokio::spawn(async move {
        serve_with(listener, router, timeout, async move {
            let _ = stopped.await;
        })
        .await
        .unwrap();
    });
    (address, stop, task)
}

#[tokio::test]
async fn a_client_that_never_finishes_its_head_is_disconnected() {
    let (address, stop, task) = start(Duration::from_millis(300)).await;
    let mut slow = TcpStream::connect(address).await.unwrap();
    // The request line and one header, but never the blank line that ends the head.
    slow.write_all(b"GET /ping HTTP/1.1\r\nHost: example.invalid\r\n")
        .await
        .unwrap();
    let started = Instant::now();
    let mut buffer = Vec::new();
    let read = tokio::time::timeout(Duration::from_secs(5), slow.read_to_end(&mut buffer)).await;
    assert!(read.is_ok(), "the server held the connection open");
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "took {:?}",
        started.elapsed()
    );
    let _ = stop.send(());
    task.await.unwrap();
}

#[tokio::test]
async fn a_complete_request_is_answered_and_shutdown_ends_the_server() {
    let (address, stop, task) = start(Duration::from_secs(5)).await;
    let mut client = TcpStream::connect(address).await.unwrap();
    client
        .write_all(b"GET /ping HTTP/1.1\r\nHost: example.invalid\r\nConnection: close\r\n\r\n")
        .await
        .unwrap();
    let mut answer = String::new();
    client.read_to_string(&mut answer).await.unwrap();
    assert!(answer.starts_with("HTTP/1.1 200"), "{answer}");
    assert!(answer.ends_with("pong"), "{answer}");
    let _ = stop.send(());
    tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .expect("the server did not stop")
        .unwrap();
}
