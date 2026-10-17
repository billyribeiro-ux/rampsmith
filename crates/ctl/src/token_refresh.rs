//! The `shopify.token_refresh` job (PLAN §10, §14; ADR-022): refresh a shop's offline token
//! when it is within ten minutes of expiry, then schedule the next weekly keep-alive.

use contracts::{JobError, ShopifyTokenRefresh};
use db::Db;
use db::repo::jobs;
use domain::{ShopId, TenantId};
use queue::{ClaimedJob, Failure};
use shopify_auth::{RefreshError, RefreshOutcome, ShopifyAuth, keepalive_job};
use time::OffsetDateTime;
use tracing::{info, instrument};

fn failure(retryable: bool, code: &str, message: impl Into<String>) -> Failure {
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

/// Runs `shopify.token_refresh` jobs.
#[derive(Debug, Clone)]
pub struct TokenRefresh {
    db: Db,
    auth: ShopifyAuth,
}

impl TokenRefresh {
    /// A handler over `db` (connected as `rampsmith_worker`) and `auth`.
    #[must_use]
    pub const fn new(db: Db, auth: ShopifyAuth) -> Self {
        Self { db, auth }
    }

    /// Handles one job now.
    pub async fn handle(&self, job: ClaimedJob) -> Result<(), Failure> {
        self.handle_at(&job, OffsetDateTime::now_utc())
            .await
            .map(|_| ())
    }

    /// Handles one job as of `now`, returning what the refresh did.
    #[instrument(skip_all, fields(job = %job.lease.job_id), err(Debug))]
    pub async fn handle_at(
        &self,
        job: &ClaimedJob,
        now: OffsetDateTime,
    ) -> Result<RefreshOutcome, Failure> {
        if job.payload_schema != ShopifyTokenRefresh::SCHEMA {
            return Err(failure(
                false,
                "payload_schema_unknown",
                format!("expected {}", ShopifyTokenRefresh::SCHEMA),
            ));
        }
        let payload: ShopifyTokenRefresh = serde_json::from_value(job.payload.clone())
            .map_err(|e| failure(false, "payload_invalid", e.to_string()))?;
        let tenant = job
            .tenant_id
            .map(TenantId::from_uuid)
            .ok_or_else(|| failure(false, "tenant_missing", "token refresh needs a tenant"))?;
        let shop = ShopId::from_uuid(payload.shop_id);

        let outcome = self
            .auth
            .refresh_if_due(tenant, shop, now)
            .await
            .map_err(|e| match e {
                RefreshError::Retryable(e) => failure(true, "shopify_unavailable", e.to_string()),
                RefreshError::Rejected(e) => failure(false, "shopify_rejected", e.to_string()),
                RefreshError::Database(e) => failure(true, "database", e.to_string()),
                RefreshError::Crypto(e) => failure(false, "crypto", e.to_string()),
            })?;
        info!(?outcome, %shop, "token refresh job ran");

        if matches!(outcome, RefreshOutcome::Fresh | RefreshOutcome::Refreshed) {
            self.schedule_next(tenant, shop, now)
                .await
                .map_err(|e| failure(true, "database", e.to_string()))?;
        }
        Ok(outcome)
    }

    async fn schedule_next(
        &self,
        tenant: TenantId,
        shop: ShopId,
        now: OffsetDateTime,
    ) -> Result<(), db::DbError> {
        let mut tx = self.db.tenant(tenant).await?;
        jobs::enqueue(&mut tx, keepalive_job(shop, now)).await?;
        tx.commit().await
    }
}
