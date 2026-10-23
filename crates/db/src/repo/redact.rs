//! `shop/redact`: delete all of a shop's data (PLAN §19; ADR-080).
//!
//! Keeps what the law or the product's own integrity needs and nothing a merchant or a
//! shopper put into the store:
//!
//! - the tenant, site and shop rows, with the shop's token, scopes, primary domain and
//!   locales removed and its status `redacted` (so a repeated `shop/redact` is recognised and a
//!   later reinstall of the same domain starts clean through `reinstall`);
//! - the append-only audit log, which never holds tokens or personal data (and which the
//!   database refuses to change);
//! - the webhook digests, so a replay of this very request is recognised.
//!
//! The tenant's other unprocessed webhook events are closed in the same transaction, with their
//! bodies cleared, and their ready `webhook.process` jobs are cancelled: a pending event whose
//! body and job payload were cleared could otherwise never be processed, and its job would die
//! and its event would raise the "unprocessed for 24 hours" alert for ever (re-audit M-1,
//! ADR-269).

use domain::ShopId;
use serde::Serialize;

use crate::repo::{audit, data_fixes, github, jobs, shopify};
use crate::{Db, DbError, TenantTx};

/// How many rows each step removed. Counts only, for the audit entry.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct Redacted {
    /// Applied-fix snapshots (the values before and after, which are store content).
    pub snapshots: u64,
    /// Fixes and their finding links.
    pub fixes: u64,
    /// Findings and their occurrences.
    pub findings: u64,
    /// Scans, their pages and the store data read for them.
    pub scans: u64,
    /// Evidence crops.
    pub evidence: u64,
    /// Statements, AI call records and budgets, and the email contact and delivery records.
    pub other: u64,
    /// Stored webhook bodies of other events.
    pub webhooks: u64,
    /// The GitHub channel's rows: installation links, repositories, pull request records and
    /// stored deliveries (ADR-290).
    pub github: u64,
    /// Other unprocessed webhook events closed without being handled, because the shop they
    /// are about no longer has any data.
    pub events_closed: u64,
    /// `webhook.process` jobs of those events cancelled before they could run.
    pub jobs_cancelled: u64,
}

/// Deletes the tenant's data for `shop` and marks the shop `redacted`. Returns `None` when
/// the shop is not this tenant's. Idempotent: running it again removes nothing and returns
/// zero counts.
pub async fn shop(tx: &mut TenantTx, shop: ShopId) -> Result<Option<Redacted>, DbError> {
    let tenant = tx.tenant_uuid();
    let exists = sqlx::query_scalar!(
        r#"select exists (select 1 from shopify_shops where tenant_id = $1 and id = $2) as "e!""#,
        tenant,
        shop.as_uuid(),
    )
    .fetch_one(tx.conn())
    .await?;
    if !exists {
        return Ok(None);
    }
    let snapshots = sqlx::query!(
        "delete from data_fix_snapshots where tenant_id = $1",
        tenant
    )
    .execute(tx.conn())
    .await?
    .rows_affected();
    sqlx::query!("delete from fix_findings where tenant_id = $1", tenant)
        .execute(tx.conn())
        .await?;
    // The pull requests' links to fixes go first: they reference the fixes deleted below.
    let github = clear_github(tx, tenant).await?;
    // Fixes point at each other (`reverts`) and at evidence; one statement removes them all.
    let fixes = sqlx::query!("delete from fixes where tenant_id = $1", tenant)
        .execute(tx.conn())
        .await?
        .rows_affected();
    let evidence = sqlx::query!("delete from evidence where tenant_id = $1", tenant)
        .execute(tx.conn())
        .await?
        .rows_affected();
    sqlx::query!(
        "delete from finding_occurrences where tenant_id = $1",
        tenant
    )
    .execute(tx.conn())
    .await?;
    let findings = sqlx::query!("delete from findings where tenant_id = $1", tenant)
        .execute(tx.conn())
        .await?
        .rows_affected();
    sqlx::query!("delete from scan_inputs where tenant_id = $1", tenant)
        .execute(tx.conn())
        .await?;
    sqlx::query!("delete from scan_pages where tenant_id = $1", tenant)
        .execute(tx.conn())
        .await?;
    // Regression records name the scans they compare (ADR-310).
    sqlx::query!("delete from regressions where tenant_id = $1", tenant)
        .execute(tx.conn())
        .await?;
    let scans = sqlx::query!("delete from scans where tenant_id = $1", tenant)
        .execute(tx.conn())
        .await?
        .rows_affected();
    let other = sqlx::query!("delete from statements where tenant_id = $1", tenant)
        .execute(tx.conn())
        .await?
        .rows_affected()
        + sqlx::query!("delete from ai_reservations where tenant_id = $1", tenant)
            .execute(tx.conn())
            .await?
            .rows_affected()
        + sqlx::query!("delete from ai_budgets where tenant_id = $1", tenant)
            .execute(tx.conn())
            .await?
            .rows_affected()
        + sqlx::query!("delete from ai_draft_holds where tenant_id = $1", tenant)
            .execute(tx.conn())
            .await?
            .rows_affected()
        // Only `ctl`'s role may delete call records, and only through this function (audit L7).
        + u64::try_from(
            sqlx::query_scalar!(r#"select redact_ai_calls() as "n!""#)
                .fetch_one(tx.conn())
                .await?,
        )
        .unwrap_or(0);
    // The owner's address and the store's name, which only email needed (ADR-272).
    let contacts = sqlx::query!("delete from shop_contacts where tenant_id = $1", tenant)
        .execute(tx.conn())
        .await?
        .rows_affected();
    // The sender's idempotency records: codes and keys only, but they name the shop's messages.
    let deliveries = sqlx::query!("delete from email_deliveries where tenant_id = $1", tenant)
        .execute(tx.conn())
        .await?
        .rows_affected();
    let (jobs_cancelled, events_closed, webhooks) = clear_webhooks(tx, tenant).await?;
    close_shop(tx, tenant, shop).await?;
    Ok(Some(Redacted {
        snapshots,
        fixes,
        findings,
        scans,
        evidence,
        other: other + contacts + deliveries,
        webhooks,
        github,
        events_closed,
        jobs_cancelled,
    }))
}

/// Removes the GitHub channel's rows (its jobs are cancelled with the others). The merchant's repository is theirs
/// and stays as it is; only Rampsmith's record of it goes. Returns how many rows were removed.
async fn clear_github(tx: &mut TenantTx, tenant: uuid::Uuid) -> Result<u64, DbError> {
    let mut removed = 0;
    // Children before parents: the foreign keys are composite and unconditional.
    for statement in [
        "delete from github_pr_fixes where tenant_id = $1",
        "delete from github_pull_requests where tenant_id = $1",
        "delete from github_events where tenant_id = $1",
        "delete from github_repos where tenant_id = $1",
        "delete from github_installations where tenant_id = $1",
        "delete from github_install_states where tenant_id = $1",
    ] {
        removed += sqlx::query(sqlx::AssertSqlSafe(statement))
            .bind(tenant)
            .execute(tx.conn())
            .await?
            .rows_affected();
    }
    Ok(removed)
}

/// Cancels, closes and clears the shop's webhook events and their jobs. Returns the jobs
/// cancelled, the events closed and the other bodies cleared.
async fn clear_webhooks(tx: &mut TenantTx, tenant: uuid::Uuid) -> Result<(u64, u64, u64), DbError> {
    // Another pending event of the shop (a `customers/redact` that arrived with this
    // `shop/redact`, say) has nothing left to act on, and its body is about to be cleared below.
    // Close it and cancel its job first, so the payload clearing does not turn the job into a
    // dead one. The running job of the event being handled is not `ready`, and the caller
    // marks that event processed itself.
    let jobs_cancelled = sqlx::query!(
        "update jobs set state = 'cancelled', finished_at = now()
          where tenant_id = $1 and queue = 'webhook.process' and state = 'ready'",
        tenant
    )
    .execute(tx.conn())
    .await?
    .rows_affected();
    let events_closed = sqlx::query!(
        "update webhook_events set processed_at = now(), body = null
          where tenant_id = $1 and processed_at is null",
        tenant
    )
    .execute(tx.conn())
    .await?
    .rows_affected();
    // Payloads can carry store content; the rows stay as the queue's own history.
    sqlx::query!(
        "update jobs set payload = '{}'::jsonb where tenant_id = $1 and payload <> '{}'::jsonb",
        tenant
    )
    .execute(tx.conn())
    .await?;
    // Other events' bodies can hold store content; their digests stay for replay detection.
    let webhooks = sqlx::query!(
        "update webhook_events set body = null where tenant_id = $1 and body is not null",
        tenant
    )
    .execute(tx.conn())
    .await?
    .rows_affected();
    Ok((jobs_cancelled, events_closed, webhooks))
}

/// Removes the shop's credentials and settings and marks it `redacted`.
async fn close_shop(tx: &mut TenantTx, tenant: uuid::Uuid, shop: ShopId) -> Result<(), DbError> {
    sqlx::query!("delete from shopify_tokens where tenant_id = $1", tenant)
        .execute(tx.conn())
        .await?;
    sqlx::query!(
        r#"update sites set settings = '{}'::jsonb, storefront_password_ct = null,
                            storefront_password_key_id = null
            where tenant_id = $1"#,
        tenant
    )
    .execute(tx.conn())
    .await?;
    sqlx::query!(
        r#"update shopify_shops
              set status = 'redacted', scopes = '{}', name = null, primary_domain = null,
                  locales = '{}', shop_gid = null,
                  synced_at = null, uninstalled_at = coalesce(uninstalled_at, now())
            where tenant_id = $1 and id = $2"#,
        tenant,
        shop.as_uuid(),
    )
    .execute(tx.conn())
    .await?;
    Ok(())
}

/// What ending an installation changed.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct Ended {
    /// The shop's status changed (it was installed).
    pub changed: bool,
    /// Queued jobs cancelled.
    pub cancelled: u64,
    /// Approved or applying fixes ended as failed (`shop_uninstalled`).
    pub fixes_failed: u64,
}

/// Marks the shop uninstalled and removes what an uninstall removes: its tokens, the jobs in
/// line (except `webhook.process`, which carries the compliance topics, PLAN §19) and the
/// fixes waiting for them. Shared by the `app/uninstalled` and `shop/redact` handlers and by
/// the operator path ([`complete_by_operator`]).
pub async fn end_installation(tx: &mut TenantTx, shop: ShopId) -> Result<Ended, DbError> {
    let changed = shopify::mark_uninstalled(tx, shop).await?;
    shopify::delete_tokens(tx, shop).await?;
    let cancelled = jobs::cancel_pending(tx, "webhook.process").await?;
    // Their apply jobs were cancelled with the rest: without this they would stay approved for
    // ever (lane A audit L2).
    let fixes_failed = data_fixes::fail_in_flight(tx, "shop_uninstalled").await?;
    // The store no longer uses the pull-request channel: its jobs were cancelled above and the
    // GitHub link ends. The merchant's repository and the App's installation on GitHub are
    // theirs to remove.
    if let Some(live) = github::live_installation(tx).await? {
        github::unlink_installation(tx, live.id).await?;
    }
    Ok(Ended {
        changed,
        cancelled,
        fixes_failed,
    })
}

/// What [`complete_by_operator`] did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Completed {
    /// The shop's status before.
    pub was: String,
    /// What ending the installation changed.
    pub ended: Ended,
    /// What was deleted.
    pub removed: Redacted,
}

/// Why [`complete_by_operator`] did nothing.
#[derive(Debug, thiserror::Error)]
pub enum OperatorRedactError {
    /// No shop has this domain.
    #[error("no shop has this domain")]
    UnknownShop,
    /// The shop was already redacted; nothing is left to delete.
    #[error("the shop is already redacted")]
    AlreadyRedacted,
    /// The database failed.
    #[error(transparent)]
    Database(#[from] DbError),
}

/// Completes a shop's redaction on an operator's say-so (`rsctl shops redact`): ends the
/// installation if it is still marked installed, deletes the shop's data and records
/// `compliance.shop_redacted_by_operator` with who confirmed what, without asking Shopify.
///
/// Use it when `shop/redact` cannot finish by itself, for example because Shopify answers the
/// grant check with 402 or 423 for a closed store for longer than the retry budget, and a
/// person has confirmed in the Partner Dashboard that the app was uninstalled (ADR-269). The
/// caller must connect as `ctl`'s login: only it may delete the AI call records.
/// `confirmed_by` and `evidence` are free text kept in the audit log; they must not hold
/// personal data or secrets.
pub async fn complete_by_operator(
    db: &Db,
    shop_domain: &str,
    confirmed_by: &str,
    evidence: &str,
) -> Result<Completed, OperatorRedactError> {
    let Some(found) = db.shop_by_domain(shop_domain).await? else {
        return Err(OperatorRedactError::UnknownShop);
    };
    let mut tx = db.tenant(found.tenant).await?;
    // Serialise with the webhook worker, which locks the same row before it deletes.
    let Some(status) = shopify::lock_status(&mut tx, found.shop).await? else {
        return Err(OperatorRedactError::UnknownShop);
    };
    if status == domain::ShopStatus::Redacted {
        tx.rollback().await?;
        return Err(OperatorRedactError::AlreadyRedacted);
    }
    let ended = end_installation(&mut tx, found.shop).await?;
    let removed = shop(&mut tx, found.shop)
        .await?
        .ok_or(OperatorRedactError::UnknownShop)?;
    audit::append(
        &mut tx,
        &audit::NewEntry {
            actor_kind: domain::ActorKind::Operator,
            actor_id: None,
            action: "compliance.shop_redacted_by_operator".to_owned(),
            subject_type: "shop".to_owned(),
            subject_id: found.shop.as_uuid(),
            data: serde_json::json!({
                "was": status.as_str(),
                "confirmed_by": confirmed_by,
                "evidence": evidence,
                "ended": ended,
                "removed": removed,
            }),
        },
    )
    .await?;
    tx.commit().await?;
    Ok(Completed {
        was: status.as_str().to_owned(),
        ended,
        removed,
    })
}
