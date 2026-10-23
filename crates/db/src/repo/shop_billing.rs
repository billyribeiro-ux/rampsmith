//! The plan Shopify confirmed for a shop (ADR-084). The columns are the stored form of
//! `billing::BillingState` (`billing::stored`). Only a Partner API answer writes here.

use billing::stored::StoredBilling;
use domain::ShopId;

use crate::{DbError, TenantTx};

/// The shop's stored plan state, if any was ever stored.
pub async fn get(tx: &mut TenantTx, shop: ShopId) -> Result<Option<StoredBilling>, DbError> {
    let tenant = tx.tenant_uuid();
    Ok(sqlx::query_as!(
        StoredBilling,
        r#"select standing, plan, plan_interval, cancel_at_end_of_cycle, trial_ends_at,
                  cycle_start, cycle_end, scheduled_plan, scheduled_interval,
                  unrecognized_handle, usage_anchor, last_confirmed_at, last_attempt_at,
                  consecutive_failures
             from shop_billing where tenant_id = $1 and shop_id = $2"#,
        tenant,
        shop.as_uuid(),
    )
    .fetch_optional(tx.conn())
    .await?)
}

/// Replaces the shop's stored plan state.
pub async fn put(tx: &mut TenantTx, shop: ShopId, state: &StoredBilling) -> Result<(), DbError> {
    let tenant = tx.tenant_uuid();
    // The limits the engine enforces are derived here, in the one place every plan state is
    // stored, so they cannot lag behind the plan the api shows (security audit M2, M3).
    let limits = billing::stored::limits_of(&billing::stored::state_of(Some(state)));
    sqlx::query!(
        r#"insert into shop_billing
             (shop_id, tenant_id, standing, plan, plan_interval, cancel_at_end_of_cycle,
              trial_ends_at, cycle_start, cycle_end, scheduled_plan, scheduled_interval,
              unrecognized_handle, usage_anchor, last_confirmed_at, last_attempt_at,
              consecutive_failures, effective_plan, ai_budget_max_micro_usd,
              alt_text_draft_limit, alt_text_draft_lifetime, regression_alerts, updated_at)
           values ($2, $1, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
                   $17, $18, $19, $20, $21, now())
           on conflict (shop_id) do update set
              standing = excluded.standing, plan = excluded.plan,
              plan_interval = excluded.plan_interval,
              cancel_at_end_of_cycle = excluded.cancel_at_end_of_cycle,
              trial_ends_at = excluded.trial_ends_at, cycle_start = excluded.cycle_start,
              cycle_end = excluded.cycle_end, scheduled_plan = excluded.scheduled_plan,
              scheduled_interval = excluded.scheduled_interval,
              unrecognized_handle = excluded.unrecognized_handle,
              usage_anchor = excluded.usage_anchor,
              last_confirmed_at = excluded.last_confirmed_at,
              last_attempt_at = excluded.last_attempt_at,
              consecutive_failures = excluded.consecutive_failures,
              effective_plan = excluded.effective_plan,
              ai_budget_max_micro_usd = excluded.ai_budget_max_micro_usd,
              alt_text_draft_limit = excluded.alt_text_draft_limit,
              alt_text_draft_lifetime = excluded.alt_text_draft_lifetime,
              regression_alerts = excluded.regression_alerts,
              updated_at = now()"#,
        tenant,
        shop.as_uuid(),
        state.standing,
        state.plan,
        state.plan_interval,
        state.cancel_at_end_of_cycle,
        state.trial_ends_at,
        state.cycle_start,
        state.cycle_end,
        state.scheduled_plan,
        state.scheduled_interval,
        state.unrecognized_handle,
        state.usage_anchor,
        state.last_confirmed_at,
        state.last_attempt_at,
        state.consecutive_failures,
        limits.plan.handle(),
        limits.ai_budget_max_micro_usd,
        limits.alt_text_draft_limit,
        limits.alt_text_draft_lifetime,
        limits.regression_alerts,
    )
    .execute(tx.conn())
    .await?;
    Ok(())
}
