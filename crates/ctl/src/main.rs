//! The ctl binary: configuration, telemetry, then the workers and the leader loop until
//! SIGTERM, letting jobs in flight finish.

use std::time::Duration;

use anyhow::Context as _;
use contracts::ShopifyTokenRefresh;
use ctl::config::Config;
use ctl::leader;
use ctl::token_refresh::TokenRefresh;
use db::Db;
use queue::WorkerConfig;
use secrecy::ExposeSecret;
use sqlx::postgres::PgPoolOptions;
use tokio::sync::watch;
use tracing::info;

fn main() -> anyhow::Result<()> {
    let config = Config::from_env().context("configuration")?;
    let _telemetry = telemetry::init(&telemetry::Config::from_env(
        "ctl",
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
    let pool = PgPoolOptions::new()
        .max_connections(config.db_max_connections)
        .acquire_timeout(Duration::from_secs(5))
        .connect_lazy(config.database_url.expose_secret())
        .context("database")?;
    let db = Db::from_pool(pool.clone());
    let auth = shopify_auth::ShopifyAuth::new(
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
            Duration::from_secs(10),
        )
        .map_err(|e| anyhow::anyhow!("Shopify token client: {e}"))?,
    );
    let refresh = TokenRefresh::new(db, auth);

    let (stop, stopped) = watch::channel(false);
    let until_stopped = |mut rx: watch::Receiver<bool>| async move {
        let _ = rx.wait_for(|stop| *stop).await;
    };

    let leader = tokio::spawn(leader::run(
        pool.clone(),
        leader::Cadence::default(),
        until_stopped(stopped.clone()),
    ));
    let mut worker = WorkerConfig::new(ShopifyTokenRefresh::QUEUE, config.worker_id.clone());
    worker.concurrency = 4;
    let workers = tokio::spawn(queue::run(
        pool,
        worker,
        move |job| {
            let refresh = refresh.clone();
            async move { refresh.handle(job).await }
        },
        until_stopped(stopped),
    ));
    info!(worker = %config.worker_id, version = %config.service_version, "ctl started");

    shutdown_signal().await;
    info!("ctl stopping; waiting for jobs in flight");
    let _ = stop.send(true);
    leader.await.context("leader task")?;
    workers.await.context("worker task")?.context("worker")?;
    info!("ctl stopped");
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
