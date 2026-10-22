//! The api binary: configuration, telemetry, then the HTTP server with graceful shutdown.

use anyhow::Context as _;
use api::AppState;
use api::config::Config;
use api::webhooks::{self, WebhookState};
use db::{Db, RoleError, RuntimeRole};
use secrecy::ExposeSecret;
use tracing::{info, warn};

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
    // Refuse to serve tenants as a role that row-level security does not bind (ADR-040). A
    // database that is down right now cannot be asked; /readyz asks again before any traffic.
    match db.verify_runtime_role(RuntimeRole::App).await {
        Ok(()) => {}
        Err(refused @ RoleError::Refused { .. }) => {
            return Err(anyhow::Error::new(refused).context("database role"));
        }
        Err(RoleError::Unreachable(error)) => {
            warn!(%error, "could not check the database role at startup; /readyz will");
        }
    }
    let (send_stop, stop) = tokio::sync::watch::channel(false);
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
    let identity = identity::Identity::new(
        db.clone(),
        &config.webauthn_rp_id,
        &config.webauthn_rp_origin,
        "Rampsmith",
    )
    .map_err(|e| anyhow::anyhow!("WebAuthn: {e}"))?;
    info!(address = %config.bind, version = %config.service_version, "api listening");
    // The webhook host reaches this listener only (ADR-182): its router serves /webhooks/*.
    let webhook_server = if let Some(address) = config.webhook_bind {
        {
            let listener = tokio::net::TcpListener::bind(address)
                .await
                .with_context(|| format!("bind {address}"))?;
            info!(%address, "webhook listener ready");
            let router = webhooks::router(WebhookState::new(
                db.clone(),
                config.shopify_client_secret.clone(),
            ));
            let stop = stop.clone();
            Some(tokio::spawn(async move {
                axum::serve(listener, router)
                    .with_graceful_shutdown(async move {
                        let _ = stop.clone().wait_for(|stop| *stop).await;
                    })
                    .await
            }))
        }
    } else {
        warn!("WEBHOOK_BIND_ADDR is not set; no webhook listener runs");
        None
    };
    let state = AppState::new(db)
        .with_shopify(shopify)
        .with_identity(identity);
    axum::serve(listener, api::app(state))
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("server")?;
    let _ = send_stop.send(true);
    if let Some(server) = webhook_server {
        server
            .await
            .context("webhook task")?
            .context("webhook server")?;
    }
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
