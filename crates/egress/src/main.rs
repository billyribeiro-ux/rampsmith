//! The egress binary: configuration, telemetry, then the proxy until SIGTERM.

use std::net::SocketAddr;

use anyhow::Context as _;
use egress::{AddressPolicy, Proxy, ProxyConfig, SystemResolver, TokenKey};
use tracing::{info, warn};

struct Config {
    bind: SocketAddr,
    key: TokenKey,
    exceptions: Vec<ipnet::IpNet>,
    tunnel_ports: Vec<u16>,
    http_ports: Vec<u16>,
    service_version: String,
}

fn ports(value: Option<String>, default: u16) -> anyhow::Result<Vec<u16>> {
    value.map_or(Ok(vec![default]), |list| {
        list.split(',')
            .map(|p| p.trim().parse::<u16>().map_err(anyhow::Error::from))
            .collect()
    })
}

fn config() -> anyhow::Result<Config> {
    let get = |name: &str| std::env::var(name).ok().filter(|v| !v.trim().is_empty());
    let bind = get("EGRESS_BIND")
        .unwrap_or_else(|| "0.0.0.0:8888".to_owned())
        .parse()
        .context("EGRESS_BIND")?;
    let secret = get("EGRESS_TOKEN_SECRET").context("EGRESS_TOKEN_SECRET must be set")?;
    let key = TokenKey::new(secret.as_bytes()).map_err(|e| anyhow::anyhow!("{e}"))?;
    // Test and staging networks only: production leaves this unset.
    let exceptions = get("EGRESS_ALLOWED_CIDRS")
        .map(|list| {
            list.split(',')
                .map(|net| net.trim().parse::<ipnet::IpNet>())
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()
        .context("EGRESS_ALLOWED_CIDRS")?
        .unwrap_or_default();
    Ok(Config {
        bind,
        key,
        exceptions,
        // Test and staging only; production proxies 443 tunnels and port-80 HTTP.
        tunnel_ports: ports(get("EGRESS_TUNNEL_PORTS"), 443).context("EGRESS_TUNNEL_PORTS")?,
        http_ports: ports(get("EGRESS_HTTP_PORTS"), 80).context("EGRESS_HTTP_PORTS")?,
        service_version: get("SERVICE_VERSION")
            .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_owned()),
    })
}

fn main() -> anyhow::Result<()> {
    let config = config().context("configuration")?;
    let _telemetry = telemetry::init(&telemetry::Config::from_env(
        "egress",
        config.service_version.clone(),
    ))
    .context("telemetry")?;
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .context("runtime")?
        .block_on(run(config))
}

async fn run(config: Config) -> anyhow::Result<()> {
    for net in &config.exceptions {
        warn!(%net, "EGRESS_ALLOWED_CIDRS opens a non-public range; never set this in production");
    }
    let policy = AddressPolicy::default().allowing(&config.exceptions);
    let mut proxy_config = ProxyConfig::new(policy, config.key);
    proxy_config.tunnel_ports = config.tunnel_ports;
    proxy_config.http_ports = config.http_ports;
    let proxy = Proxy::new(proxy_config, SystemResolver);
    let listener = tokio::net::TcpListener::bind(config.bind)
        .await
        .with_context(|| format!("bind {}", config.bind))?;
    info!(address = %config.bind, "egress listening");
    proxy.serve(listener, shutdown_signal()).await;
    info!("egress stopped");
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
}
