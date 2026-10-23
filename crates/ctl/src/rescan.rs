//! The scheduled rescan (PLAN §9, ADR-279, ADR-312): the leader starts a scan for each shop that
//! switched scheduled rescans on and has gone its plan's interval (Free a month, Starter a week,
//! Growth and Pro a day, each with a fixed delay per shop) without one.
//!
//! The database says which shops are due (`due_scheduled_rescans`, across tenants, fairly); each scan is
//! then started in that shop's own transaction, the way the app starts one by hand, with the
//! same rules: the plan must include it, a scan already under way means no second one, and the
//! site is locked while the decision is made so two leaders (or a leader and a merchant) cannot
//! both start one. A scheduled scan is not counted against the plan's manual scans per day.

use contracts::ShopifyReadStore;
use db::repo::{app_views, audit, data_fixes, jobs as job_repo, rescans, scans};
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

/// Most scans one round starts; the shops left over are picked up by the next round.
pub const MAX_STARTS_PER_ROUND: usize = 100;

/// Most scans one tenant gets in a round, so one tenant with many shops cannot use up a round
/// (ADR-312). Every tenant's most overdue shop is started before any tenant's second.
pub const MAX_PER_TENANT_PER_ROUND: usize = 5;

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

/// Starts the scheduled rescans that are due, at most [`MAX_STARTS_PER_ROUND`].
pub async fn start_due(db: &Db) -> Result<Round, DbError> {
    let mut round = Round::default();
    let mut tx = db.public().await?;
    let due = rescans::due(
        &mut tx,
        i32::try_from(MAX_STARTS_PER_ROUND).unwrap_or(i32::MAX),
        i32::try_from(MAX_PER_TENANT_PER_ROUND).unwrap_or(i32::MAX),
    )
    .await?;
    tx.commit().await?;
    for due in &due {
        match start_one(db, due).await {
            Ok(Outcome::Started) => round.started += 1,
            Ok(Outcome::Skipped(reason)) => {
                round.skipped += 1;
                info!(reason, "scheduled rescan skipped");
            }
            // One shop's failure must not stop the others; it is due again next round.
            Err(error) => {
                round.skipped += 1;
                warn!(%error, "scheduled rescan could not be started");
            }
        }
    }
    if round.started > 0 {
        info!(started = round.started, "started scheduled rescans");
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
    // Due is decided again here, under the lock and on the plan's cadence as stored now (a
    // downgrade lengthens the interval): a period gets one scheduled scan however many leaders
    // listed the shop.
    if !rescans::still_due(&mut tx, due.shop).await? {
        return Ok(Outcome::Skipped("not_due"));
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
