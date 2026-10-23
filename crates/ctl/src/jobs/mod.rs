//! The R1 queues `ctl` serves besides `shopify.token_refresh` (ADR-035, ADR-036, ADR-080 to
//! ADR-083).
//!
//! Every handler that talks to Shopify gets its token from [`ShopifyAuth`] (refreshed when
//! due) and its client from the shared [`AdminFactory`], so one process paces every call for a
//! shop through one cost bucket.

use std::sync::Arc;

use contracts::{
    GithubCheckRepository, GithubOpenPullRequest, GithubPlanBatch, GithubProcessEvent,
    GithubSyncInstallation, GithubSyncPullRequest, JobError, ShopifyApplyDataFix, ShopifyReadStore,
    ShopifyRevertDataFix, WebhookProcess,
};
use db::Db;
use queue::{ClaimedJob, Failure};
use shopify_admin::AdminFactory;
use shopify_auth::{RefreshError, ShopifyAuth};

pub mod apply_data_fix;
pub mod code_fix;
pub(crate) mod data_fix;
pub mod github;
pub mod read_store;
pub mod revert_data_fix;
pub mod scan_secret;
pub mod webhook;

/// The queues this registry serves.
pub const QUEUES: [&str; 4] = [
    ShopifyReadStore::QUEUE,
    ShopifyApplyDataFix::QUEUE,
    ShopifyRevertDataFix::QUEUE,
    WebhookProcess::QUEUE,
];

/// What the R1 handlers share: the database, the token lifecycle and the Admin API client
/// factory.
#[derive(Debug, Clone)]
pub struct Jobs {
    db: Db,
    auth: ShopifyAuth,
    admin: AdminFactory,
    scan_secrets: Option<scan_secret::ScanSecrets>,
    /// The GitHub client, holding the App's private key, while the pull-request channel is on
    /// (`CODE_FIX_CHANNEL_ENABLED`, ADR-290).
    github: Option<Arc<::github::GitHub>>,
    /// The app's public origin, for the evidence links in pull requests (`APP_ORIGIN`).
    app_origin: Option<String>,
}

impl Jobs {
    /// Handlers over `db` (connected as `rampsmith_worker`).
    #[must_use]
    pub fn new(db: Db, auth: ShopifyAuth, admin: AdminFactory) -> Self {
        Self {
            db,
            auth,
            admin,
            scan_secrets: None,
            github: None,
            app_origin: None,
        }
    }

    /// Switches the GitHub pull-request channel on: its jobs can run once this client exists.
    #[must_use]
    pub fn with_github(mut self, client: ::github::GitHub) -> Self {
        self.github = Some(Arc::new(client));
        self
    }

    /// Sets the app's public origin, which the evidence links in pull requests start with.
    #[must_use]
    pub fn with_app_origin(mut self, origin: impl Into<String>) -> Self {
        self.app_origin = Some(origin.into());
        self
    }

    /// The queues to serve: the R1 queues, and the GitHub channel's while it is on.
    #[must_use]
    pub fn queues(&self) -> Vec<&'static str> {
        let mut queues = QUEUES.to_vec();
        if self.github.is_some() {
            queues.extend(github::QUEUES);
        }
        queues
    }

    /// Lets scans of a password-protected store reach the engine (ADR-266). Without it the
    /// engine reports such a store as blocked.
    #[must_use]
    pub fn with_scan_secrets(mut self, secrets: scan_secret::ScanSecrets) -> Self {
        self.scan_secrets = Some(secrets);
        self
    }

    /// Hands `job` to its queue's handler. The queue is the one the worker claimed from, so a
    /// queue outside [`QUEUES`] is a wiring mistake and fails permanently.
    pub async fn dispatch(&self, job: ClaimedJob) -> Result<(), Failure> {
        match job.queue.as_str() {
            ShopifyReadStore::QUEUE => read_store::handle(self, job).await,
            ShopifyApplyDataFix::QUEUE => apply_data_fix::handle(self, job).await,
            ShopifyRevertDataFix::QUEUE => revert_data_fix::handle(self, job).await,
            WebhookProcess::QUEUE => webhook::handle(self, job).await,
            GithubSyncInstallation::QUEUE => github::sync_installation(self, job).await,
            GithubProcessEvent::QUEUE => github::process_event(self, job).await,
            GithubCheckRepository::QUEUE => github::check_repository(self, job).await,
            GithubPlanBatch::QUEUE => code_fix::plan_batch(self, job).await,
            GithubOpenPullRequest::QUEUE => code_fix::open_pr(self, job).await,
            GithubSyncPullRequest::QUEUE => code_fix::sync_pr(self, job).await,
            other => Err(Failure::Permanent(JobError {
                code: "queue_unknown".to_owned(),
                message: format!("ctl does not serve {other}"),
                retryable: false,
            })),
        }
    }
}

/// A failure with a stable code. Messages never carry tokens, response bodies or personal data.
pub(crate) fn failure(retryable: bool, code: &str, message: impl Into<String>) -> Failure {
    let error = JobError {
        code: code.to_owned(),
        message: message.into(),
        retryable,
    };
    if retryable {
        Failure::Retryable(error)
    } else {
        Failure::Permanent(error)
    }
}

/// A database failure: worth another attempt.
pub(crate) fn database(error: &db::DbError) -> Failure {
    failure(true, "database", error.to_string())
}

/// An Admin API failure, classified by whether a retry can help.
pub(crate) fn admin(error: &shopify_admin::AdminError) -> Failure {
    failure(error.is_retryable(), error.code(), error.to_string())
}

/// A token lifecycle failure.
pub(crate) fn token(error: &RefreshError) -> Failure {
    match error {
        RefreshError::Retryable(e) => failure(true, "shopify_unavailable", e.to_string()),
        RefreshError::Rejected(e) => failure(false, "shopify_rejected", e.to_string()),
        RefreshError::Database(e) => failure(true, "database", e.to_string()),
        RefreshError::Crypto(e) => failure(false, "crypto", e.to_string()),
    }
}

/// The job's tenant, which every R1 job needs.
pub(crate) fn tenant_of(job: &ClaimedJob) -> Result<domain::TenantId, Failure> {
    job.tenant_id
        .map(domain::TenantId::from_uuid)
        .ok_or_else(|| {
            failure(
                false,
                "tenant_missing",
                format!("{} needs a tenant", job.queue),
            )
        })
}

/// Parses the job's payload against the schema its handler expects.
pub(crate) fn payload<T: serde::de::DeserializeOwned>(
    job: &ClaimedJob,
    schema: &'static str,
) -> Result<T, Failure> {
    if job.payload_schema != schema {
        return Err(failure(
            false,
            "payload_schema_unknown",
            format!("expected {schema}"),
        ));
    }
    serde_json::from_value(job.payload.clone())
        .map_err(|e| failure(false, "payload_invalid", e.to_string()))
}

impl Jobs {
    /// An Admin API client for `shop`, with a token refreshed if due. `None` when the shop is
    /// not installed or its grant was revoked.
    pub(crate) async fn client(
        &self,
        tenant: domain::TenantId,
        shop: domain::ShopId,
    ) -> Result<Option<shopify_admin::AdminClient>, Failure> {
        let mut tx = self.db.tenant(tenant).await.map_err(|e| database(&e))?;
        let row = db::repo::shopify::get(&mut tx, shop)
            .await
            .map_err(|e| database(&e))?;
        tx.rollback().await.map_err(|e| database(&e))?;
        let Some(row) = row else {
            return Ok(None);
        };
        let domain = shopify::ShopDomain::parse(&row.shop_domain).map_err(|_| {
            failure(
                false,
                "shop_domain_invalid",
                "the stored shop domain is invalid",
            )
        })?;
        let Some(token) = self
            .auth
            .access_token(tenant, shop)
            .await
            .map_err(|e| token(&e))?
        else {
            return Ok(None);
        };
        Ok(Some(self.admin.client(&domain, token)))
    }
}
