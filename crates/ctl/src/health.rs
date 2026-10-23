//! The deploy health listener (ADR-264): `GET /healthz` answers 200 while the process runs.
//!
//! Railway's deploy-time health check needs an HTTP endpoint on `PORT` before it marks a
//! deployment active. `ctl` is a worker with no public port, so this is the whole surface: one
//! path, no data, no other route, and no dependence on the database (a database outage must
//! not fail a deploy of the process that waits for it). The listener is bound before anything
//! else starts, so the check passes while the role check and the workers come up.

use std::io;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Semaphore;
use tracing::debug;

/// The most connections served at once; the rest wait in the kernel's backlog.
const MAX_CONNECTIONS: usize = 32;
/// How long a client may take to send its request line.
const READ_TIMEOUT: Duration = Duration::from_secs(5);
/// The request head is never read past this many bytes.
const MAX_HEAD: usize = 2048;

const OK: &[u8] = b"HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok";
const NOT_FOUND: &[u8] =
    b"HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n";

/// Binds the health address.
///
/// # Errors
/// When the address cannot be bound.
pub async fn bind(address: SocketAddr) -> io::Result<TcpListener> {
    TcpListener::bind(address).await
}

/// Serves health checks on `listener` until `shutdown` resolves.
pub async fn serve(listener: TcpListener, shutdown: impl Future<Output = ()>) {
    let permits = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    tokio::pin!(shutdown);
    loop {
        let permit = tokio::select! {
            () = &mut shutdown => return,
            permit = Arc::clone(&permits).acquire_owned() => match permit {
                Ok(permit) => permit,
                Err(_) => return,
            },
        };
        let accepted = tokio::select! {
            () = &mut shutdown => return,
            accepted = listener.accept() => accepted,
        };
        match accepted {
            Ok((stream, _)) => {
                tokio::spawn(async move {
                    let _permit = permit;
                    if let Err(error) = respond(stream).await {
                        debug!(%error, "health connection ended with an error");
                    }
                });
            }
            Err(error) => debug!(%error, "health accept failed"),
        }
    }
}

/// Whether the request head's first line is exactly `GET /healthz HTTP/1.x`.
fn is_health_request(head: &[u8]) -> bool {
    let line = head.split(|b| *b == b'\n').next().unwrap_or_default();
    let line = line.strip_suffix(b"\r").unwrap_or(line);
    matches!(line, b"GET /healthz HTTP/1.1" | b"GET /healthz HTTP/1.0")
}

async fn respond(mut stream: TcpStream) -> io::Result<()> {
    let mut head = Vec::with_capacity(256);
    let mut chunk = [0_u8; 512];
    let read = tokio::time::timeout(READ_TIMEOUT, async {
        // Only the request line decides the answer; stop at its end.
        while !head.contains(&b'\n') && head.len() < MAX_HEAD {
            let n = stream.read(&mut chunk).await?;
            if n == 0 {
                break;
            }
            head.extend_from_slice(chunk.get(..n).unwrap_or_default());
        }
        io::Result::Ok(())
    })
    .await;
    let reply = match read {
        Ok(Ok(())) if is_health_request(&head) => OK,
        _ => NOT_FOUND,
    };
    stream.write_all(reply).await?;
    stream.shutdown().await
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn start() -> SocketAddr {
        let listener = bind("127.0.0.1:0".parse().unwrap()).await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(serve(listener, std::future::pending()));
        address
    }

    async fn request(address: SocketAddr, raw: &str) -> String {
        let mut stream = TcpStream::connect(address).await.unwrap();
        stream.write_all(raw.as_bytes()).await.unwrap();
        let mut reply = String::new();
        stream.read_to_string(&mut reply).await.unwrap();
        reply
    }

    #[tokio::test]
    async fn healthz_answers_200_and_nothing_else_does() {
        let address = start().await;
        let ok = request(
            address,
            "GET /healthz HTTP/1.1\r\nHost: healthcheck.railway.app\r\n\r\n",
        )
        .await;
        assert!(ok.starts_with("HTTP/1.1 200 OK"), "{ok}");
        assert!(ok.ends_with("ok"), "{ok}");
        for raw in [
            "GET / HTTP/1.1\r\n\r\n",
            "GET /readyz HTTP/1.1\r\n\r\n",
            "GET /healthz/ HTTP/1.1\r\n\r\n",
            "GET /healthz?x=1 HTTP/1.1\r\n\r\n",
            "POST /healthz HTTP/1.1\r\n\r\n",
            "GET http://x/healthz HTTP/1.1\r\n\r\n",
            "garbage\r\n\r\n",
        ] {
            let reply = request(address, raw).await;
            assert!(reply.starts_with("HTTP/1.1 404"), "{raw:?} -> {reply}");
        }
    }

    #[tokio::test]
    async fn a_client_that_sends_nothing_is_answered_or_dropped_without_blocking_others() {
        let address = start().await;
        let _idle = TcpStream::connect(address).await.unwrap();
        let ok = request(address, "GET /healthz HTTP/1.0\r\n\r\n").await;
        assert!(ok.starts_with("HTTP/1.1 200 OK"), "{ok}");
    }
}
