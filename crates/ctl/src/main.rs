//! The ctl binary: configuration, telemetry, then the workers and the leader loop until
//! SIGTERM, letting jobs in flight finish.

use std::time::Duration;

use anyhow::Context as _;
use contracts::ShopifyTokenRefresh;
use ctl::config::Config;
use ctl::token_refresh::TokenRefresh;
use ctl::{jobs, leader, startup};
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
    // The deploy health check (ADR-264) is answered from the first moment, before the database
    // role check, which can wait for the database; it stops with everything else.
    let health = ctl::health::bind(config.health_bind)
        .await
        .with_context(|| format!("bind {}", config.health_bind))?;
    info!(address = %config.health_bind, "ctl health listener");
    let (stop, stopped) = watch::channel(false);
    let health = tokio::spawn(ctl::health::serve(health, {
        let mut rx = stopped.clone();
        async move {
            let _ = rx.wait_for(|stop| *stop).await;
        }
    }));
    let pool = PgPoolOptions::new()
        .max_connections(config.db_max_connections)
        .acquire_timeout(Duration::from_secs(5))
        .connect_lazy(config.database_url.expose_secret())
        .context("database")?;
    let db = Db::from_pool(pool.clone());
    // Never claim a job as a role that row-level security does not bind (ADR-040).
    if !startup::require_worker_role(&db, Duration::from_secs(5), shutdown_signal())
        .await
        .context("database role")?
    {
        info!("ctl stopped before it started");
        let _ = stop.send(true);
        let _ = health.await;
        return Ok(());
    }
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
    let refresh = TokenRefresh::new(db.clone(), auth.clone());
    let handlers = job_handlers(&config, &db, auth)?;

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
    let mut workers = vec![tokio::spawn(queue::run(
        pool.clone(),
        worker,
        move |job| {
            let refresh = refresh.clone();
            async move { refresh.handle(job).await }
        },
        until_stopped(stopped.clone()),
    ))];
    for name in jobs::QUEUES {
        let mut worker = WorkerConfig::new(name, config.worker_id.clone());
        worker.concurrency = 2;
        let handlers = handlers.clone();
        workers.push(tokio::spawn(queue::run(
            pool.clone(),
            worker,
            move |job| {
                let handlers = handlers.clone();
                async move { handlers.dispatch(job).await }
            },
            until_stopped(stopped.clone()),
        )));
    }
    info!(worker = %config.worker_id, version = %config.service_version, "ctl started");

    shutdown_signal().await;
    info!("ctl stopping; waiting for jobs in flight");
    let _ = stop.send(true);
    leader.await.context("leader task")?;
    for worker in workers {
        worker.await.context("worker task")?.context("worker")?;
    }
    let _ = health.await;
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

/// The handlers of the job queues, with the scan-secret hand-off when its ring is configured.
fn job_handlers(
    config: &Config,
    db: &Db,
    auth: shopify_auth::ShopifyAuth,
) -> anyhow::Result<jobs::Jobs> {
    let handlers = jobs::Jobs::new(
        db.clone(),
        auth,
        shopify_admin::AdminFactory::new(
            shopify_admin::AdminEndpoint::Shopify,
            Duration::from_secs(20),
        )
        .map_err(|e| anyhow::anyhow!("Admin API client: {e}"))?,
    )
    .with_app_origin(config.app_origin.clone());
    Ok(match config.scan_secret_keys.clone() {
        Some(scan) => handlers.with_scan_secrets(jobs::scan_secret::ScanSecrets::new(
            config.master_keys.clone(),
            scan,
        )),
        None => handlers,
    })
}
