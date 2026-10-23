# ADR-312: Scheduled rescans run at the plan's cadence, spread and shared fairly

- Status: Accepted
- Date: 2026-10-23
- Stream: R2 (daily monitoring)
- Supersedes: the weekly interval of ADR-279 (the rest of ADR-279 stands)

## Context

ADR-279 starts a scan for each shop with the weekly rescan on after a week without one. PLAN §20
gives Free monthly, Starter weekly and Growth and Pro daily scans, and the plan table already says
so (`billing::entitlements::ScanCadence`).

## Decision

1. The cadence is mirrored to `shop_billing.render_cadence` by `shop_billing::put`, from
   `StoredLimits.render_cadence`, next to the other limits SQL needs. A shop with no stored plan is
   on Free's, monthly.
2. The leader asks `due_scheduled_rescans(limit, per_tenant, only)` (the old function stays for the
   previous ctl version; expand only). A shop is due when it is installed, has the setting on
   (`weekly_rescan` in `sites.settings`, kept under its old name, shown as "Scheduled rescans"), and
   the plan's interval (1, 7 or 30 days) plus its **delay** has passed since its last queued, running
   or finished scan. A scan of any outcome inside the last day holds the next back, so a failed scan
   is retried tomorrow, not every tick. Verification scans do not count.
3. **Jitter**: the delay is a fixed share, up to a twelfth of the interval, derived from a hash of
   the shop id. It is stable, so a shop keeps its rhythm, and shops switched on together spread over
   two hours (daily), fourteen (weekly) or sixty (monthly).
4. **Fair share**: due shops are numbered within their tenant by how overdue they are, and the
   result is ordered by that number first, so every tenant's most overdue shop comes before any
   tenant's second. A round starts at most 100 scans and at most 5 per tenant; the rest wait for the
   next 15-minute round, oldest first.
5. **Idempotent per period**: the leader decides again inside the shop's tenant transaction, under
   the site lock, with the same SQL (`only` = that shop), so two leaders that listed the same shop
   start one scan; the scan that exists makes the shop not due. Tested with two concurrent rounds.
6. Every plan may switch the setting on (it used to be refused on Free). The settings screen says the
   cadence of the plan and names Growth for daily rescans; the overview's "next scan" uses the cadence.
   The weekly summary email's `nextScanAt` uses it too.

## Consequences

The setting is still off by default. Making scheduled monitoring default-on for paid plans changes
what merchants did not ask for; it is a product decision for the founder, not made here.

## Rejected alternatives

- A period table with a unique key: a second tenant table for what the site lock and the due rule
  already guarantee.
- Random jitter at scan time: not stable, and untestable.
