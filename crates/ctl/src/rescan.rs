//! The weekly rescan (PLAN §9, ADR-279): the leader starts a scan for each shop that switched
//! the weekly rescan on and has gone a week without one.
//!
//! The database says which shops are due (`due_weekly_rescans`, across tenants); each scan is
//! then started in that shop's own transaction, the way the app starts one by hand, with the
//! same rules: the plan must include it, a scan already under way means no second one, and the
//! site is locked while the decision is made so two leaders (or a leader and a merchant) cannot
//! both start one. A scheduled scan is not counted against the plan's manual scans per day.

use billing::entitlements::ScanCadence;
use billing::stored::{entitlements_of, state_of};
use contracts::ShopifyReadStore;
use db::repo::{app_views, audit, data_fixes, jobs as job_repo, rescans, scans, shop_billing};
use db::{Db, DbError};
use domain::{ActorKind, ScanTrigger};
use queue::NewJob;
use serde_json::json;
use tracing::{info, warn};

/// A scan that has been queued or running for this long is not "live" any more (the same limit
/// the app applies when a merchant presses the button).
const STALE_SCAN_SECONDS: i64 = 60 * 60;

/// The ruleset recorded when the site has no scan to take it from (the app's own default).
const PLACEHOLDER_RULESET: &str = "axe-core";

/// Shops asked about at a time.
const PAGE: i32 = 100;

/// Most scans one round starts; the shops left over are picked up by the next round.
pub const MAX_STARTS_PER_ROUND: usize = 100;

/// What one round did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Round {
    /// Scans started.
    pub started: usize,
    /// Shops due but passed over: the plan does not include weekly rescans, the merchant
    /// switched the setting off in the meantime, or a scan was already under way.
    pub skipped: usize,
}

/// Why a due shop got no scan.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Outcome {
    Started,
    Skipped(&'static str),
}

/// Starts the weekly rescans that are due, at most [`MAX_STARTS_PER_ROUND`].
pub async fn start_due(db: &Db) -> Result<Round, DbError> {
    let mut round = Round::default();
    let mut after = None;
    'pages: loop {
        let mut tx = db.public().await?;
        let page = rescans::due(&mut tx, after, PAGE).await?;
        tx.commit().await?;
        let Some(last) = page.last().map(|due| due.shop) else {
            break;
        };
        after = Some(last);
        for due in &page {
            if round.started >= MAX_STARTS_PER_ROUND {
                break 'pages;
            }
            match start_one(db, due).await {
                Ok(Outcome::Started) => round.started += 1,
                Ok(Outcome::Skipped(reason)) => {
                    round.skipped += 1;
                    info!(reason, "weekly rescan skipped");
                }
                // One shop's failure must not stop the others; it is due again next round.
                Err(error) => {
                    round.skipped += 1;
                    warn!(%error, "weekly rescan could not be started");
                }
            }
        }
        if page.len() < usize::try_from(PAGE).unwrap_or(usize::MAX) {
            break;
        }
    }
    if round.started > 0 {
        info!(started = round.started, "started weekly rescans");
    }
    Ok(round)
}

async fn start_one(db: &Db, due: &rescans::DueRescan) -> Result<Outcome, DbError> {
    let mut tx = db.tenant(due.tenant).await?;
    // Decided under the site's lock, on what the rows say now rather than when the shop was
    // listed.
    if !app_views::lock_site(&mut tx, due.site).await? {
        return Ok(Outcome::Skipped("no_site"));
    }
    let still_on = app_views::settings(&mut tx, due.site)
        .await?
        .is_some_and(|(settings, _)| {
            settings.get("weekly_rescan") == Some(&serde_json::Value::Bool(true))
        });
    if !still_on {
        return Ok(Outcome::Skipped("switched_off"));
    }
    let state = state_of(shop_billing::get(&mut tx, due.shop).await?.as_ref());
    // A shop with no confirmed plan has Free's entitlements, which are monthly (ADR-084).
    if entitlements_of(&state).render_cadence() < ScanCadence::Weekly {
        return Ok(Outcome::Skipped("plan_without_weekly_rescans"));
    }
    if app_views::has_live_scan(&mut tx, due.site, STALE_SCAN_SECONDS).await? {
        return Ok(Outcome::Skipped("scan_under_way"));
    }
    let ruleset = data_fixes::latest_ruleset(&mut tx, due.site)
        .await?
        .unwrap_or_else(|| PLACEHOLDER_RULESET.to_owned());
    let scan = scans::create(
        &mut tx,
        &scans::NewScan {
            site_id: due.site,
            trigger: ScanTrigger::Scheduled,
            ruleset_version: ruleset,
            theme_ref: None,
        },
    )
    .await?;
    let job = ShopifyReadStore {
        scan_id: scan.id.as_uuid(),
        site_id: due.site.as_uuid(),
        shop_id: due.shop.as_uuid(),
    };
    job_repo::enqueue(
        &mut tx,
        NewJob::new(
            ShopifyReadStore::QUEUE,
            ShopifyReadStore::SCHEMA,
            serde_json::to_value(job).map_err(|e| DbError::Invalid(e.to_string()))?,
        )
        .idempotency_key(format!("{}:{}", ShopifyReadStore::QUEUE, scan.id)),
    )
    .await?;
    audit::append(
        &mut tx,
        &audit::NewEntry {
            actor_kind: ActorKind::System,
            actor_id: None,
            action: "scan.started".to_owned(),
            subject_type: "scan".to_owned(),
            subject_id: scan.id.as_uuid(),
            data: json!({"trigger": "scheduled"}),
        },
    )
    .await?;
    tx.commit().await?;
    Ok(Outcome::Started)
}
