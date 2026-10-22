//! What `shopify.apply_data_fix@1` and `shopify.revert_data_fix@1` share (ADR-082): loading a
//! fix with its target, deciding what it changes, and recording a refusal.

use db::repo::{audit, data_fixes, shopify as shops};
use domain::{ActorKind, FixId, FixKind, ShopId, TenantId};
use queue::Failure;
use serde_json::{Value, json};
use shopify_admin::Target;

use super::{Jobs, database, failure};

/// A fix, its shop and the change it makes, loaded in one read.
#[derive(Debug)]
pub(crate) struct Loaded {
    /// The fix.
    pub(crate) fix: data_fixes::DataFix,
    /// The snapshot, when one is stored.
    pub(crate) snapshot: Option<data_fixes::Snapshot>,
    /// The site's HTTPS origin.
    pub(crate) base_url: String,
    /// The change.
    pub(crate) plan: Plan,
}

/// One field of one resource, from a value to a value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Plan {
    /// The validated target.
    pub(crate) target: Target,
    /// The value when the fix was proposed; `None` when the field was unset.
    pub(crate) before: Option<String>,
    /// The value the fix writes.
    pub(crate) after: String,
}

/// A JSON snapshot value as text: `null` is an unset field.
fn text(value: &Value) -> Result<Option<String>, &'static str> {
    match value {
        Value::Null => Ok(None),
        Value::String(s) => Ok(Some(s.clone())),
        _ => Err("diff_invalid"),
    }
}

/// Reads the plan from the snapshot, else from the diff (`resource_gid` or `resource`, `field`,
/// `before`, `after`). An error is the stable code to record on the fix.
fn plan_of(
    snapshot: Option<&data_fixes::Snapshot>,
    diff: Option<&Value>,
) -> Result<(Plan, data_fixes::Snapshot), &'static str> {
    let (gid, field, before, after) = if let Some(s) = snapshot {
        (
            s.resource_gid.clone(),
            s.field.clone(),
            s.before_value.clone(),
            s.after_value.clone(),
        )
    } else {
        let diff = diff.ok_or("diff_missing")?;
        let gid = diff
            .get("resource_gid")
            .or_else(|| diff.get("resource"))
            .and_then(Value::as_str)
            .ok_or("diff_invalid")?;
        let field = diff
            .get("field")
            .and_then(Value::as_str)
            .ok_or("diff_invalid")?;
        (
            gid.to_owned(),
            field.to_owned(),
            diff.get("before").cloned().unwrap_or(Value::Null),
            diff.get("after").cloned().ok_or("diff_invalid")?,
        )
    };
    let target = Target::parse(&gid, &field).map_err(|_| "target_unsupported")?;
    let before_text = text(&before)?;
    let after_text = text(&after)?.ok_or("diff_invalid")?;
    let stored = data_fixes::Snapshot {
        resource_gid: gid,
        field,
        before_value: before,
        after_value: after,
    };
    Ok((
        Plan {
            target,
            before: before_text,
            after: after_text,
        },
        stored,
    ))
}

/// Why a fix cannot be loaded. `Fail` carries a code to record on the fix itself.
pub(crate) enum Refused {
    /// A job failure with nothing to record on the fix.
    Job(Failure),
    /// The fix is unusable; record `code` on it and fail permanently.
    Fix(&'static str, String),
}

impl From<Failure> for Refused {
    fn from(f: Failure) -> Self {
        Self::Job(f)
    }
}

/// Loads the fix for a job. `Ok(None)` is not used: a missing fix is a permanent failure.
pub(crate) async fn load(
    jobs: &Jobs,
    tenant: TenantId,
    fix: FixId,
    shop: ShopId,
) -> Result<Loaded, Refused> {
    let mut tx = jobs.db.tenant(tenant).await.map_err(|e| database(&e))?;
    let found = data_fixes::get(&mut tx, fix)
        .await
        .map_err(|e| database(&e))?;
    let snapshot = data_fixes::snapshot(&mut tx, fix)
        .await
        .map_err(|e| database(&e))?;
    let shop_row = shops::get(&mut tx, shop).await.map_err(|e| database(&e))?;
    let site = match &found {
        Some(f) => db::repo::sites::get(&mut tx, f.site_id)
            .await
            .map_err(|e| database(&e))?,
        None => None,
    };
    tx.rollback().await.map_err(|e| database(&e))?;
    let Some(found) = found else {
        return Err(failure(false, "fix_not_found", "no such fix for this tenant").into());
    };
    if found.kind != FixKind::Data {
        return Err(failure(false, "fix_not_data", "only data fixes are written here").into());
    }
    let (Some(shop_row), Some(site)) = (shop_row, site) else {
        return Err(failure(
            false,
            "shop_mismatch",
            "the fix does not belong to this shop",
        )
        .into());
    };
    if shop_row.site_id != found.site_id {
        return Err(failure(
            false,
            "shop_mismatch",
            "the fix does not belong to this shop",
        )
        .into());
    }
    let (plan, _) = plan_of(snapshot.as_ref(), found.diff.as_ref())
        .map_err(|code| Refused::Fix(code, format!("the fix cannot be read: {code}")))?;
    Ok(Loaded {
        fix: found,
        snapshot,
        base_url: site.base_url,
        plan,
    })
}

/// The snapshot to store for a fix that has none.
pub(crate) fn snapshot_of(loaded: &Loaded) -> Option<data_fixes::Snapshot> {
    if loaded.snapshot.is_some() {
        return None;
    }
    plan_of(None, loaded.fix.diff.as_ref()).ok().map(|(_, s)| s)
}

/// Records `code` on a fix that cannot be applied, writes the audit entry and returns the
/// permanent failure for the job.
pub(crate) async fn refuse_fix(
    jobs: &Jobs,
    tenant: TenantId,
    fix: FixId,
    code: &'static str,
    message: impl Into<String>,
) -> Failure {
    let message = message.into();
    let result = async {
        let mut tx = jobs.db.tenant(tenant).await?;
        data_fixes::fail(&mut tx, fix, code).await?;
        audit::append(
            &mut tx,
            &audit::NewEntry {
                actor_kind: ActorKind::System,
                actor_id: None,
                action: "shopify.data_fix_failed".to_owned(),
                subject_type: "fix".to_owned(),
                subject_id: fix.as_uuid(),
                data: json!({"code": code}),
            },
        )
        .await?;
        tx.commit().await
    }
    .await;
    match result {
        Ok(()) => failure(false, code, message),
        Err(e) => database(&e),
    }
}
