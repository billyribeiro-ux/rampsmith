//! `shopify.apply_data_fix@1` (ADR-035, ADR-082): writes an approved data fix to the store.
//!
//! Order, and why:
//!
//! 1. Refuse anything not approved by a person (`approved_at` and an approver are required),
//!    and anything that is not a data fix of this shop.
//! 2. Store the snapshot (if the proposal did not), then move the fix `approved` to
//!    `applying` and commit, so the values around the write are on record before it happens.
//! 3. Read the live value. Equal to the snapshot's `before`: write. Equal to `after`: an earlier
//!    attempt wrote it and crashed; carry on. Anything else: the merchant changed it since the
//!    proposal, so refuse with a typed conflict and write nothing.
//! 4. Write through the Admin API, read the owning resource again, and in one transaction mark
//!    the fix `applied`, store the re-read data as a `verify` input, create the verification
//!    scan and queue `verify.scan@1`.
//!
//! A failure before the write leaves the fix `applying` (retry resumes at step 3) or `failed`
//! with a code. A job that runs twice for an `applied` fix does nothing.

use contracts::{ShopifyApplyDataFix, VerifyScan};
use db::repo::{audit, data_fixes, jobs as job_repo, scan_inputs, scans};
use domain::{ActorKind, FixId, FixStatus, ScanTrigger, ShopId, SiteId, TenantId};
use queue::{ClaimedJob, Failure, NewJob};
use serde_json::{Value, json};
use shopify_admin::{AdminError, Owner, same_value};
use tracing::{info, instrument};

use super::data_fix::{self, Loaded, Refused, refuse_fix};
use super::{Jobs, admin, database, failure, payload, read_store, tenant_of};

/// Handles one `shopify.apply_data_fix@1` job.
#[instrument(skip_all, fields(job = %job.lease.job_id), err(Debug))]
pub async fn handle(jobs: &Jobs, job: ClaimedJob) -> Result<(), Failure> {
    let ShopifyApplyDataFix { fix_id, shop_id } = payload(&job, ShopifyApplyDataFix::SCHEMA)?;
    let tenant = tenant_of(&job)?;
    let fix = FixId::from_uuid(fix_id);
    let shop = ShopId::from_uuid(shop_id);
    let loaded = match data_fix::load(jobs, tenant, fix, shop).await {
        Ok(loaded) => loaded,
        Err(Refused::Job(f)) => return Err(f),
        Err(Refused::Fix(code, message)) => {
            return Err(refuse_fix(jobs, tenant, fix, code, message).await);
        }
    };
    match loaded.fix.status {
        FixStatus::Applied | FixStatus::Verified | FixStatus::Reverted => return Ok(()),
        FixStatus::Approved | FixStatus::Applying => {}
        other => {
            return Err(failure(
                false,
                "fix_not_approved",
                format!("the fix is {other}, not approved"),
            ));
        }
    }
    if loaded.fix.approved_at.is_none()
        || (loaded.fix.approved_by.is_none() && loaded.fix.approved_by_ref.is_none())
    {
        return Err(refuse_fix(
            jobs,
            tenant,
            fix,
            "fix_unapproved",
            "no one approved this fix",
        )
        .await);
    }
    apply(jobs, tenant, fix, shop, &loaded).await
}

async fn apply(
    jobs: &Jobs,
    tenant: TenantId,
    fix: FixId,
    shop: ShopId,
    loaded: &Loaded,
) -> Result<(), Failure> {
    // 2. The snapshot first, then `applying`.
    let mut tx = jobs.db.tenant(tenant).await.map_err(|e| database(&e))?;
    if let Some(snapshot) = data_fix::snapshot_of(loaded) {
        data_fixes::put_snapshot(&mut tx, fix, &snapshot)
            .await
            .map_err(|e| database(&e))?;
    }
    if loaded.fix.status == FixStatus::Approved {
        data_fixes::begin_apply(&mut tx, fix)
            .await
            .map_err(|e| database(&e))?;
    }
    tx.commit().await.map_err(|e| database(&e))?;

    let Some(client) = jobs.client(tenant, shop).await? else {
        return Err(refuse_fix(
            jobs,
            tenant,
            fix,
            "shop_not_connected",
            "the shop is not installed or its grant was revoked",
        )
        .await);
    };

    // 3. The live value decides.
    let plan = &loaded.plan;
    let live = match client.live_value(&plan.target).await {
        Ok(live) => live,
        Err(e) => return Err(admin_or_refuse(jobs, tenant, fix, &e).await),
    };
    let field = plan.target.field();
    if same_value(field, live.value.as_deref(), Some(&plan.after)) {
        // Written already (an earlier attempt, or the merchant typed the same text).
    } else if same_value(field, live.value.as_deref(), plan.before.as_deref()) {
        if live.media_status.as_deref().is_some_and(|s| s != "READY") {
            return Err(failure(
                true,
                "media_not_ready",
                "Shopify is still processing the image",
            ));
        }
        if let Err(e) = client.write_value(&plan.target, &plan.after).await {
            return Err(admin_or_refuse(jobs, tenant, fix, &e).await);
        }
    } else {
        return Err(refuse_fix(
            jobs,
            tenant,
            fix,
            "conflict_value_changed",
            "the live value changed since the fix was proposed; nothing was written",
        )
        .await);
    }

    // 4. Read the owner again, then finish in one transaction.
    let owner_gid = loaded
        .fix
        .owner
        .clone()
        .unwrap_or_else(|| plan.target.gid().to_owned());
    let owner = match client.owner(&owner_gid).await {
        Ok(owner) => Some(owner),
        Err(AdminError::ResourceMissing | AdminError::Decode) => None,
        Err(e) => return Err(admin(&e)),
    };
    finish(jobs, tenant, fix, loaded, owner.as_ref()).await?;
    info!(%fix, "data fix applied");
    Ok(())
}

/// A retryable Admin failure retries; any other ends the fix with the failure's code.
async fn admin_or_refuse(jobs: &Jobs, tenant: TenantId, fix: FixId, e: &AdminError) -> Failure {
    if e.is_retryable() {
        return admin(e);
    }
    let code = match e {
        AdminError::ResourceMissing => "resource_gone",
        AdminError::AccessDenied => "scope_missing",
        AdminError::Unauthorized => "token_rejected",
        AdminError::User(_) => "shopify_rejected",
        _ => "shopify_error",
    };
    refuse_fix(jobs, tenant, fix, code, e.to_string()).await
}

async fn finish(
    jobs: &Jobs,
    tenant: TenantId,
    fix: FixId,
    loaded: &Loaded,
    owner: Option<&Owner>,
) -> Result<(), Failure> {
    let site: SiteId = loaded.fix.site_id;
    let mut tx = jobs.db.tenant(tenant).await.map_err(|e| database(&e))?;
    let moved = data_fixes::finish_apply(&mut tx, fix)
        .await
        .map_err(|e| database(&e))?;
    if !moved {
        // Someone else finished it between the write and here.
        tx.rollback().await.map_err(|e| database(&e))?;
        return Ok(());
    }
    let ruleset = data_fixes::latest_ruleset(&mut tx, site)
        .await
        .map_err(|e| database(&e))?
        .unwrap_or_else(|| "unknown".to_owned());
    let scan = scans::create(
        &mut tx,
        &scans::NewScan {
            site_id: site,
            trigger: ScanTrigger::Verify,
            ruleset_version: ruleset,
            theme_ref: None,
        },
    )
    .await
    .map_err(|e| database(&e))?;
    let (input_id, urls) = match owner {
        Some(owner) => {
            let batch = read_store::owner_payload(owner);
            let id = scan_inputs::put(&mut tx, scan.id, site, "verify", 0, &batch)
                .await
                .map_err(|e| database(&e))?;
            (
                id,
                vec![format!(
                    "{}{}",
                    loaded.base_url.trim_end_matches('/'),
                    owner.path()
                )],
            )
        }
        None => (None, vec![loaded.base_url.clone()]),
    };
    let planned = i32::try_from(urls.len()).unwrap_or(i32::MAX);
    scans::set_planned(&mut tx, scan.id, planned)
        .await
        .map_err(|e| database(&e))?;
    let verify = VerifyScan {
        scan_id: scan.id.as_uuid(),
        site_id: site.as_uuid(),
        fix_id: fix.as_uuid(),
        input_id,
        urls,
    };
    job_repo::enqueue(
        &mut tx,
        NewJob::new(
            VerifyScan::QUEUE,
            VerifyScan::SCHEMA,
            serde_json::to_value(&verify)
                .map_err(|e| failure(false, "payload_invalid", e.to_string()))?,
        )
        .idempotency_key(format!("{}:{fix}", VerifyScan::QUEUE)),
    )
    .await
    .map_err(|e| database(&e))?;
    audit::append(
        &mut tx,
        &audit::NewEntry {
            actor_kind: ActorKind::System,
            actor_id: None,
            action: "shopify.data_fix_applied".to_owned(),
            subject_type: "fix".to_owned(),
            subject_id: fix.as_uuid(),
            data: applied_audit(loaded),
        },
    )
    .await
    .map_err(|e| database(&e))?;
    tx.commit().await.map_err(|e| database(&e))
}

/// What the audit entry says: the resource, the field and who approved it and when. No values:
/// they are store content, kept in the snapshot, which `shop/redact` deletes.
fn applied_audit(loaded: &Loaded) -> Value {
    json!({
        "resource": loaded.plan.target.gid(),
        "field": loaded.plan.target.field().as_str(),
        "approved_by": loaded.fix.approved_by,
        "approved_by_ref": loaded.fix.approved_by_ref,
        "approved_at": loaded.fix.approved_at
            .and_then(|t| t.format(&time::format_description::well_known::Rfc3339).ok()),
    })
}
