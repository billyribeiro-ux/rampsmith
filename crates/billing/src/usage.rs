//! Remaining AI alt-text drafts (PLAN §20) from recorded usage. Paid plans renew monthly in
//! windows anchored to the shop's usage anchor; Free's 25 drafts are granted once, ever
//! (ADR-133).

use time::{Date, Month, OffsetDateTime, UtcOffset};

use crate::entitlements::{DraftAllowance, entitlements};
use crate::plan::Plan;

/// A usage window could not be computed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum UsageError {
    /// A window boundary falls outside the dates `time` can represent.
    #[error("the allowance window falls outside the supported date range")]
    OutOfRange,
}

/// One recorded use of alt-text drafting: `quantity` drafts produced at `at`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DraftUsage {
    /// When the drafts were produced.
    pub at: OffsetDateTime,
    /// How many drafts.
    pub quantity: u32,
}

/// A half-open span of time, `[start, end)`, in UTC.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UsageWindow {
    /// The first instant inside the window.
    pub start: OffsetDateTime,
    /// The first instant after the window: when the allowance renews.
    pub end: OffsetDateTime,
}

impl UsageWindow {
    /// Whether `at` falls inside the window.
    #[must_use]
    pub fn contains(&self, at: OffsetDateTime) -> bool {
        self.start <= at && at < self.end
    }
}

/// Where a shop stands against its alt-text draft allowance.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DraftQuota {
    /// The allowance of the plan the quota was computed for.
    pub allowance: DraftAllowance,
    /// Drafts counted against the allowance.
    pub used: u64,
    /// Drafts still available now.
    pub remaining: u32,
    /// The current monthly window, or `None` for a lifetime allowance, which never renews.
    pub window: Option<UsageWindow>,
}

impl DraftQuota {
    /// When the allowance renews, if it ever does.
    #[must_use]
    pub fn renews_at(&self) -> Option<OffsetDateTime> {
        self.window.map(|window| window.end)
    }

    /// Whether `drafts` more drafts may be produced now.
    #[must_use]
    pub const fn permits(&self, drafts: u32) -> bool {
        drafts <= self.remaining
    }
}

/// `anchor` moved by `months` calendar months, keeping its day of month (clamped to the
/// length of shorter months) and its time of day, in UTC.
fn add_months(anchor: OffsetDateTime, months: i64) -> Result<OffsetDateTime, UsageError> {
    let anchor = anchor.to_offset(UtcOffset::UTC);
    let index = i64::from(anchor.year()) * 12 + i64::from(u8::from(anchor.month())) - 1 + months;
    let year = i32::try_from(index.div_euclid(12)).map_err(|_| UsageError::OutOfRange)?;
    let month_number =
        u8::try_from(index.rem_euclid(12) + 1).map_err(|_| UsageError::OutOfRange)?;
    let month = Month::try_from(month_number).map_err(|_| UsageError::OutOfRange)?;
    let day = anchor.day().min(month.length(year));
    let date = Date::from_calendar_date(year, month, day).map_err(|_| UsageError::OutOfRange)?;
    Ok(date.with_time(anchor.time()).assume_utc())
}

/// The monthly window containing `now`. Windows start each month on the anchor's day of
/// month at the anchor's UTC time of day; in months too short for that day, they start on
/// the month's last day (an anchor on 31 January gives 28 or 29 February, then 31 March).
pub fn monthly_window(
    anchor: OffsetDateTime,
    now: OffsetDateTime,
) -> Result<UsageWindow, UsageError> {
    let anchor = anchor.to_offset(UtcOffset::UTC);
    let now = now.to_offset(UtcOffset::UTC);
    let month_index =
        |at: OffsetDateTime| i64::from(at.year()) * 12 + i64::from(u8::from(at.month()));
    // The window starting in now's calendar month begins on or before now unless now is
    // earlier in the month than the anchor day; then the window began the month before.
    let mut months = month_index(now) - month_index(anchor);
    if add_months(anchor, months)? > now {
        months -= 1;
    }
    Ok(UsageWindow {
        start: add_months(anchor, months)?,
        end: add_months(anchor, months + 1)?,
    })
}

/// The anchor used when a shop has none: calendar months in UTC, starting at midnight on the
/// first of each month.
const CALENDAR_MONTH_ANCHOR: OffsetDateTime = OffsetDateTime::UNIX_EPOCH;

/// Remaining alt-text drafts for a shop on `plan` at `now`.
///
/// - Free's allowance is lifetime: every recorded draft counts, whenever and on whichever plan
///   it was produced ("25, once").
/// - Paid plans count only drafts inside the monthly window containing `now`, anchored at
///   `usage_anchor` (set when the shop moved onto a paid plan and kept across paid plan
///   changes, ADR-133). A mid-window plan change therefore keeps the drafts already used
///   counting against the new plan's limit. Without an anchor, windows are calendar months.
pub fn remaining_alt_text_drafts(
    plan: Plan,
    usage: &[DraftUsage],
    usage_anchor: Option<OffsetDateTime>,
    now: OffsetDateTime,
) -> Result<DraftQuota, UsageError> {
    let allowance = entitlements(plan).alt_text_drafts();
    let (window, counted) = match allowance {
        DraftAllowance::Lifetime(_) => (None, sum(usage.iter())),
        DraftAllowance::Monthly(_) => {
            let window = monthly_window(usage_anchor.unwrap_or(CALENDAR_MONTH_ANCHOR), now)?;
            let inside = usage.iter().filter(|record| window.contains(record.at));
            (Some(window), sum(inside))
        }
    };
    let remaining = u64::from(allowance.limit()).saturating_sub(counted);
    Ok(DraftQuota {
        allowance,
        used: counted,
        remaining: u32::try_from(remaining).unwrap_or(u32::MAX),
        window,
    })
}

fn sum<'a>(records: impl Iterator<Item = &'a DraftUsage>) -> u64 {
    records.fold(0_u64, |total, record| {
        total.saturating_add(u64::from(record.quantity))
    })
}

#[cfg(test)]
mod tests {
    use time::macros::datetime;

    use super::*;

    fn window(start: OffsetDateTime, end: OffsetDateTime) -> UsageWindow {
        UsageWindow { start, end }
    }

    fn used(at: OffsetDateTime, quantity: u32) -> DraftUsage {
        DraftUsage { at, quantity }
    }

    #[test]
    fn windows_start_on_the_anchor_day_and_time() {
        let anchor = datetime!(2026-01-15 10:30 UTC);
        assert_eq!(
            monthly_window(anchor, datetime!(2026-03-20 08:00 UTC)).unwrap(),
            window(
                datetime!(2026-03-15 10:30 UTC),
                datetime!(2026-04-15 10:30 UTC)
            )
        );
        assert_eq!(
            monthly_window(anchor, datetime!(2026-03-15 10:29:59 UTC)).unwrap(),
            window(
                datetime!(2026-02-15 10:30 UTC),
                datetime!(2026-03-15 10:30 UTC)
            ),
            "one second before the boundary is still the previous window"
        );
        assert_eq!(
            monthly_window(anchor, datetime!(2026-03-15 10:30 UTC))
                .unwrap()
                .start,
            datetime!(2026-03-15 10:30 UTC),
            "the boundary instant opens the new window"
        );
    }

    #[test]
    fn the_31st_clamps_to_the_end_of_shorter_months_and_comes_back() {
        let anchor = datetime!(2026-01-31 10:00 UTC);
        assert_eq!(
            monthly_window(anchor, datetime!(2026-02-15 00:00 UTC)).unwrap(),
            window(
                datetime!(2026-01-31 10:00 UTC),
                datetime!(2026-02-28 10:00 UTC)
            )
        );
        assert_eq!(
            monthly_window(anchor, datetime!(2026-02-28 10:00 UTC)).unwrap(),
            window(
                datetime!(2026-02-28 10:00 UTC),
                datetime!(2026-03-31 10:00 UTC)
            )
        );
        assert_eq!(
            monthly_window(anchor, datetime!(2026-04-30 12:00 UTC)).unwrap(),
            window(
                datetime!(2026-04-30 10:00 UTC),
                datetime!(2026-05-31 10:00 UTC)
            )
        );
    }

    #[test]
    fn leap_years_give_february_its_29th() {
        let anchor = datetime!(2028-01-31 00:00 UTC);
        assert_eq!(
            monthly_window(anchor, datetime!(2028-02-29 12:00 UTC)).unwrap(),
            window(
                datetime!(2028-02-29 00:00 UTC),
                datetime!(2028-03-31 00:00 UTC)
            )
        );
        let leap_day = datetime!(2028-02-29 00:00 UTC);
        assert_eq!(
            monthly_window(leap_day, datetime!(2029-02-28 12:00 UTC)).unwrap(),
            window(
                datetime!(2029-02-28 00:00 UTC),
                datetime!(2029-03-29 00:00 UTC)
            ),
            "a leap-day anchor uses 28 February in common years"
        );
        assert_eq!(
            monthly_window(leap_day, datetime!(2029-02-27 23:59 UTC)).unwrap(),
            window(
                datetime!(2029-01-29 00:00 UTC),
                datetime!(2029-02-28 00:00 UTC)
            )
        );
        assert_eq!(
            monthly_window(leap_day, datetime!(2032-02-29 00:00 UTC)).unwrap(),
            window(
                datetime!(2032-02-29 00:00 UTC),
                datetime!(2032-03-29 00:00 UTC)
            )
        );
        assert_eq!(
            monthly_window(
                datetime!(2100-01-31 00:00 UTC),
                datetime!(2100-02-10 00:00 UTC)
            )
            .unwrap()
            .end,
            datetime!(2100-02-28 00:00 UTC),
            "2100 is not a leap year"
        );
    }

    #[test]
    fn windows_cross_year_boundaries() {
        let anchor = datetime!(2026-12-15 00:00 UTC);
        assert_eq!(
            monthly_window(anchor, datetime!(2027-01-10 00:00 UTC)).unwrap(),
            window(
                datetime!(2026-12-15 00:00 UTC),
                datetime!(2027-01-15 00:00 UTC)
            )
        );
    }

    #[test]
    fn a_now_before_the_anchor_still_finds_its_window() {
        let anchor = datetime!(2026-05-10 00:00 UTC);
        assert_eq!(
            monthly_window(anchor, datetime!(2026-04-20 00:00 UTC)).unwrap(),
            window(
                datetime!(2026-04-10 00:00 UTC),
                datetime!(2026-05-10 00:00 UTC)
            )
        );
    }

    #[test]
    fn offsets_are_normalised_to_utc() {
        let anchor = datetime!(2026-03-01 01:00 +02:00); // 2026-02-28 23:00 UTC
        assert_eq!(
            monthly_window(anchor, datetime!(2026-03-10 00:00 UTC)).unwrap(),
            window(
                datetime!(2026-02-28 23:00 UTC),
                datetime!(2026-03-28 23:00 UTC)
            )
        );
    }

    #[test]
    fn without_an_anchor_windows_are_utc_calendar_months() {
        let quota =
            remaining_alt_text_drafts(Plan::Starter, &[], None, datetime!(2026-12-31 23:59:59 UTC))
                .unwrap();
        assert_eq!(
            quota.window,
            Some(window(
                datetime!(2026-12-01 00:00 UTC),
                datetime!(2027-01-01 00:00 UTC)
            ))
        );
    }

    #[test]
    fn dates_beyond_the_supported_range_are_errors_not_panics() {
        let end_of_range = datetime!(9999-12-15 00:00 UTC);
        assert_eq!(
            monthly_window(end_of_range, datetime!(9999-12-20 00:00 UTC)),
            Err(UsageError::OutOfRange)
        );
    }

    #[test]
    fn free_drafts_are_granted_once_for_the_lifetime_of_the_shop() {
        let now = datetime!(2026-10-17 12:00 UTC);
        let fresh = remaining_alt_text_drafts(Plan::Free, &[], None, now).unwrap();
        assert_eq!((fresh.remaining, fresh.used, fresh.window), (25, 0, None));
        assert_eq!(fresh.renews_at(), None);

        let history = [
            used(datetime!(2025-01-05 00:00 UTC), 10),
            used(datetime!(2026-09-30 00:00 UTC), 10),
        ];
        let quota = remaining_alt_text_drafts(Plan::Free, &history, None, now).unwrap();
        assert_eq!((quota.used, quota.remaining), (20, 5));
        assert!(quota.permits(5) && !quota.permits(6));

        let a_year_later = datetime!(2027-10-17 12:00 UTC);
        let later = remaining_alt_text_drafts(Plan::Free, &history, None, a_year_later).unwrap();
        assert_eq!(
            later.remaining, 5,
            "a new month or year does not renew Free"
        );
    }

    #[test]
    fn returning_to_free_after_a_paid_plan_grants_nothing_new() {
        let history = [used(datetime!(2026-08-01 00:00 UTC), 2_500)];
        let quota = remaining_alt_text_drafts(
            Plan::Free,
            &history,
            Some(datetime!(2026-07-01 00:00 UTC)),
            datetime!(2026-10-17 00:00 UTC),
        )
        .unwrap();
        assert_eq!((quota.used, quota.remaining), (2_500, 0));
    }

    #[test]
    fn paid_plans_count_only_the_current_window() {
        let anchor = Some(datetime!(2026-01-15 00:00 UTC));
        let history = [
            used(datetime!(2026-01-10 00:00 UTC), 1_000), // previous window
            used(datetime!(2026-01-15 00:00 UTC), 700),   // exactly at the window start
            used(datetime!(2026-01-20 00:00 UTC), 800),
            used(datetime!(2026-02-15 00:00 UTC), 50), // exactly at the window end
        ];
        let quota = remaining_alt_text_drafts(
            Plan::Starter,
            &history,
            anchor,
            datetime!(2026-01-25 00:00 UTC),
        )
        .unwrap();
        assert_eq!((quota.used, quota.remaining), (1_500, 500));
        assert_eq!(quota.renews_at(), Some(datetime!(2026-02-15 00:00 UTC)));

        let next = remaining_alt_text_drafts(
            Plan::Starter,
            &history,
            anchor,
            datetime!(2026-02-15 00:00 UTC),
        )
        .unwrap();
        assert_eq!((next.used, next.remaining), (50, 1_950));
    }

    #[test]
    fn a_mid_window_upgrade_keeps_used_drafts_counting() {
        let anchor = Some(datetime!(2026-01-15 00:00 UTC));
        let history = [used(datetime!(2026-01-20 00:00 UTC), 1_500)];
        // Upgraded from Starter to Growth on 25 January; the anchor is unchanged.
        let quota = remaining_alt_text_drafts(
            Plan::Growth,
            &history,
            anchor,
            datetime!(2026-01-26 00:00 UTC),
        )
        .unwrap();
        assert_eq!((quota.used, quota.remaining), (1_500, 8_500));
    }

    #[test]
    fn a_mid_window_downgrade_can_leave_nothing_until_renewal() {
        let anchor = Some(datetime!(2026-01-15 00:00 UTC));
        let history = [used(datetime!(2026-01-16 00:00 UTC), 3_000)];
        let quota = remaining_alt_text_drafts(
            Plan::Starter,
            &history,
            anchor,
            datetime!(2026-02-01 00:00 UTC),
        )
        .unwrap();
        assert_eq!((quota.used, quota.remaining), (3_000, 0));
        assert!(!quota.permits(1));
        assert!(quota.permits(0));
        assert_eq!(quota.renews_at(), Some(datetime!(2026-02-15 00:00 UTC)));
    }

    #[test]
    fn upgrading_from_free_starts_a_fresh_window_at_the_new_anchor() {
        let history = [used(datetime!(2026-01-03 00:00 UTC), 25)];
        let anchor = Some(datetime!(2026-01-10 09:00 UTC));
        let quota = remaining_alt_text_drafts(
            Plan::Starter,
            &history,
            anchor,
            datetime!(2026-01-11 00:00 UTC),
        )
        .unwrap();
        assert_eq!((quota.used, quota.remaining), (0, 2_000));
    }

    #[test]
    fn huge_usage_saturates_instead_of_overflowing() {
        let history = vec![used(datetime!(2026-01-20 00:00 UTC), u32::MAX); 8];
        let quota = remaining_alt_text_drafts(
            Plan::Pro,
            &history,
            Some(datetime!(2026-01-15 00:00 UTC)),
            datetime!(2026-01-21 00:00 UTC),
        )
        .unwrap();
        assert_eq!(quota.used, u64::from(u32::MAX) * 8);
        assert_eq!(quota.remaining, 0);
    }
}
