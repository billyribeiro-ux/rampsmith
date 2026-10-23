//! Serving an axum router with a header-read timeout (re-audit L-6, ADR-269).
//!
//! `axum::serve` gives hyper no timer, so a client that opens a connection and sends its request
//! head one byte at a time, or never finishes it, holds that connection (and a file descriptor)
//! until the platform's proxy gives up. The webhook listener's unverified-read pool and its body
//! deadline only start once the head is complete. Both listeners are therefore served here, with
//! hyper's `header_read_timeout`, which needs a timer: [`TokioTimer`].
//!
//! Protocols are those `axum::serve` offered (HTTP/1.1 and HTTP/2, with upgrades). On shutdown
//! the listener stops accepting, connections finish their requests, and anything still open
//! after [`DRAIN`] is dropped.

use std::io;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use hyper_util::rt::{TokioExecutor, TokioIo, TokioTimer};
use hyper_util::server::conn::auto::Builder;
use hyper_util::server::graceful::GracefulShutdown;
use hyper_util::service::TowerToHyperService;
use tokio::net::TcpListener;
use tracing::{debug, warn};

/// How long a client may take to send a request's head, from its first byte or from the end of
/// the previous request on the connection. Shopify's own limit for a whole delivery is five
/// seconds, so a client that needs longer than this to send headers is not Shopify.
pub const HEADER_READ_TIMEOUT: Duration = Duration::from_secs(5);

/// How long connections that are still busy get to finish after the shutdown signal.
pub const DRAIN: Duration = Duration::from_secs(30);

/// Serves `router` on `listener` until `shutdown` resolves, closing connections whose request
/// head takes longer than [`HEADER_READ_TIMEOUT`].
///
/// # Errors
/// Never in practice: accept errors are logged and retried. The `Result` keeps the signature of
/// `axum::serve(..).await` so callers did not change shape.
pub async fn serve(
    listener: TcpListener,
    router: Router,
    shutdown: impl Future<Output = ()>,
) -> io::Result<()> {
    serve_with(listener, router, HEADER_READ_TIMEOUT, shutdown).await
}

/// [`serve`] with an explicit header-read timeout, for tests.
///
/// # Errors
/// See [`serve`].
pub async fn serve_with(
    listener: TcpListener,
    router: Router,
    header_read_timeout: Duration,
    shutdown: impl Future<Output = ()>,
) -> io::Result<()> {
    let mut builder = Builder::new(TokioExecutor::new());
    builder
        .http1()
        .timer(TokioTimer::new())
        .header_read_timeout(Some(header_read_timeout));
    let builder = Arc::new(builder);
    let graceful = GracefulShutdown::new();
    tokio::pin!(shutdown);
    loop {
        let accepted = tokio::select! {
            () = &mut shutdown => break,
            accepted = listener.accept() => accepted,
        };
        let stream = match accepted {
            Ok((stream, _)) => stream,
            Err(error) => {
                // Out of file descriptors or a reset before accept: back off, do not spin.
                warn!(%error, "accept failed");
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
        };
        let service = TowerToHyperService::new(router.clone());
        let builder = Arc::clone(&builder);
        let watcher = graceful.watcher();
        tokio::spawn(async move {
            let connection = builder.serve_connection_with_upgrades(TokioIo::new(stream), service);
            if let Err(error) = watcher.watch(connection.into_owned()).await {
                // Includes a head that did not arrive in time.
                debug!(%error, "connection ended with an error");
            }
        });
    }
    drop(listener);
    tokio::select! {
        () = graceful.shutdown() => {}
        () = tokio::time::sleep(DRAIN) => warn!("connections still open after the drain period were dropped"),
    }
    Ok(())
}
