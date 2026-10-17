//! The api binary: configuration, telemetry, then the HTTP server with graceful shutdown.

use anyhow::Context as _;
use api::AppState;
use api::config::Config;
use db::Db;
use secrecy::ExposeSecret;
use tracing::info;

fn main() -> anyhow::Result<()> {
    let config = Config::from_env().context("configuration")?;
    let _telemetry = telemetry::init(&telemetry::Config::from_env(
        "api",
        config.service_version.clone(),
    ))
    .context("telemetry")?;
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .context("runtime")?
        .block_on(serve(config))
}

async fn serve(config: Config) -> anyhow::Result<()> {
    let db = Db::connect_lazy(
        config.database_url.expose_secret(),
        config.db_max_connections,
    )
    .context("database")?;
    let listener = tokio::net::TcpListener::bind(config.bind)
        .await
        .with_context(|| format!("bind {}", config.bind))?;
    let shopify = shopify_auth::ShopifyAuth::new(
        db.clone(),
        config.master_keys.clone(),
        shopify::SessionTokenVerifier::new(
            &config.shopify_client_id,
            &config.shopify_client_secret,
        ),
        shopify::TokenClient::new(
            &config.shopify_client_id,
            config.shopify_client_secret.clone(),
            shopify::TokenEndpoint::Shopify,
            std::time::Duration::from_secs(10),
        )
        .map_err(|e| anyhow::anyhow!("Shopify token client: {e}"))?,
    );
    info!(address = %config.bind, version = %config.service_version, "api listening");
    axum::serve(listener, api::app(AppState::new(db).with_shopify(shopify)))
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("server")?;
    info!("api stopped");
    Ok(())
}

/// Resolves on SIGTERM (Railway's stop signal) or Ctrl-C.
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
