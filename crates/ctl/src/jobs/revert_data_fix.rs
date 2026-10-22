//! `shopify.revert_data_fix@1` (ADR-035, ADR-082): the one-click undo of an applied data fix.
//!
//! The undo writes the snapshot's `before` value back, but only if the live value still equals
//! what the fix wrote. If the merchant (or an app) changed the field since, writing `before`
//! would destroy that edit, so the undo refuses with the typed conflict
//! `conflict_live_value_changed`, leaves the fix `applied` and records the refusal. A job that
//! runs twice, or one that finds the field already restored, finishes the revert without writing.

use contracts::ShopifyRevertDataFix;
use db::repo::{audit, data_fixes};
use domain::{ActorKind, FixId, FixStatus, ShopId, TenantId};
use queue::{ClaimedJob, Failure};
use serde_json::json;
use shopify_admin::{AdminError, same_value};
use tracing::{info, instrument};

use super::data_fix::{self, Loaded, Refused};
use super::{Jobs, admin, database, failure, payload, tenant_of};

/// Handles one `shopify.revert_data_fix@1` job.
#[instrument(skip_all, fields(job = %job.lease.job_id), err(Debug))]
pub async fn handle(jobs: &Jobs, job: ClaimedJob) -> Result<(), Failure> {
    let ShopifyRevertDataFix { fix_id, shop_id } = payload(&job, ShopifyRevertDataFix::SCHEMA)?;
    let tenant = tenant_of(&job)?;
    let fix = FixId::from_uuid(fix_id);
    let shop = ShopId::from_uuid(shop_id);
    let loaded = match data_fix::load(jobs, tenant, fix, shop).await {
        Ok(loaded) => loaded,
        Err(Refused::Job(f)) => return Err(f),
        // An unreadable fix cannot be applied, so there is nothing of it in the store to undo.
        Err(Refused::Fix(code, message)) => return Err(failure(false, code, message)),
    };
    match loaded.fix.status {
        FixStatus::Reverted => return Ok(()),
        FixStatus::Applied | FixStatus::Verified => {}
        other => {
            return Err(failure(
                false,
                "fix_not_applied",
                format!("the fix is {other}; only an applied fix can be undone"),
            ));
        }
    }
    revert(jobs, tenant, fix, shop, &loaded).await
}

async fn revert(
    jobs: &Jobs,
    tenant: TenantId,
    fix: FixId,
    shop: ShopId,
    loaded: &Loaded,
) -> Result<(), Failure> {
    let Some(client) = jobs.client(tenant, shop).await? else {
        return Err(failure(
            false,
            "shop_not_connected",
            "the shop is not installed or its grant was revoked",
        ));
    };
    let plan = &loaded.plan;
    let field = plan.target.field();
    let live = match client.live_value(&plan.target).await {
        Ok(live) => live,
        Err(AdminError::ResourceMissing) => {
            return Err(failure(
                false,
                "resource_gone",
                "the resource no longer exists, so there is nothing to restore",
            ));
        }
        Err(e) => return Err(admin(&e)),
    };
    let restored = same_value(field, live.value.as_deref(), plan.before.as_deref());
    if !restored {
        if !same_value(field, live.value.as_deref(), Some(&plan.after)) {
            return Err(refuse_revert(jobs, tenant, fix, loaded).await);
        }
        if let Err(e) = client
            .write_value(&plan.target, plan.before.as_deref().unwrap_or(""))
            .await
        {
            return Err(admin(&e));
        }
    }
    let mut tx = jobs.db.tenant(tenant).await.map_err(|e| database(&e))?;
    let moved = data_fixes::finish_revert(&mut tx, fix)
        .await
        .map_err(|e| database(&e))?;
    if moved {
        let reopened = data_fixes::reopen_findings(&mut tx, fix)
            .await
            .map_err(|e| database(&e))?;
        audit::append(
            &mut tx,
            &audit::NewEntry {
                actor_kind: ActorKind::System,
                actor_id: None,
                action: "shopify.data_fix_reverted".to_owned(),
                subject_type: "fix".to_owned(),
                subject_id: fix.as_uuid(),
                data: json!({
                    "resource": plan.target.gid(),
                    "field": field.as_str(),
                    "findings_reopened": reopened,
                    "already_restored": restored,
                }),
            },
        )
        .await
        .map_err(|e| database(&e))?;
    }
    tx.commit().await.map_err(|e| database(&e))?;
    info!(%fix, "data fix reverted");
    Ok(())
}

/// Records the refusal and returns the typed conflict. The fix stays `applied`.
async fn refuse_revert(jobs: &Jobs, tenant: TenantId, fix: FixId, loaded: &Loaded) -> Failure {
    let result = async {
        let mut tx = jobs.db.tenant(tenant).await?;
        audit::append(
            &mut tx,
            &audit::NewEntry {
                actor_kind: ActorKind::System,
                actor_id: None,
                action: "shopify.data_fix_revert_refused".to_owned(),
                subject_type: "fix".to_owned(),
                subject_id: fix.as_uuid(),
                data: json!({
                    "code": "conflict_live_value_changed",
                    "resource": loaded.plan.target.gid(),
                    "field": loaded.plan.target.field().as_str(),
                }),
            },
        )
        .await?;
        tx.commit().await
    }
    .await;
    match result {
        Ok(()) => failure(
            false,
            "conflict_live_value_changed",
            "the live value changed since the fix was applied; nothing was restored",
        ),
        Err(e) => database(&e),
    }
}
