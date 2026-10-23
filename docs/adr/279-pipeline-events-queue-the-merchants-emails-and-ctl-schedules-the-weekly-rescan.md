# ADR-279: Pipeline events queue the merchant's emails, and ctl schedules the weekly rescan

- Status: Accepted
- Date: 2026-10-23
- Stream: R1 email, triggers (PLAN §5 R1, §9, §16; ADR-272, ADR-275, ADR-276)

## Context

The sender (ADR-270 to ADR-276) can mail a shop's owner by reference, but nothing asked it to: the
welcome, first-scan, weekly-summary and fix-verified templates existed with no caller. The weekly
rescan existed as a setting (`sites.settings.weekly_rescan`, plan-gated in the api) with nothing that
ran it, although PLAN §6 gives `ctl` the "scheduled re-scans under a single leader".

## Decision

**Each email is queued in the transaction of the job that made it true**, as `email.send@1` by
recipient reference (no address travels through the queue). The queue key and the sender's ledger key
are both `email.send:<message key>`, so a retried job queues nothing twice and a replay sends nothing
twice. Whether the merchant wants the mail is not decided at the trigger: the mailer holds the
suppression list and the opt-outs (ADR-275) and records why it dropped a message. A trigger only skips
mail that could never go: no stored contact, or nothing to report.

| Email | Queued by | Message key | When |
| --- | --- | --- | --- |
| `welcome` | `ctl`, `webhook.rs` `store_contact` | `welcome:<shop id>` | The first time the owner contact is stored, which is the shop's first successful read (`shopify.read_store` or `shop/update`). The address is not known earlier: the Admin API gives it only after the grant. Once per shop for life, so a reinstall is not welcomed twice |
| `first_scan_complete` | engine, `scan.finalize` | `first-scan-complete:<site id>` | The site's first finished scan (`succeeded` or `partial`) that ran checks (`checks_run > 0`), whatever started it. Once per site |
| `weekly_summary` | engine, `scan.finalize` | `weekly-summary:<scan id>` | A later scan with trigger `scheduled`. A manual rescan sends neither mail: the merchant is looking at the app |
| `fix_verified` | engine, `verify.scan` | `fix-verified:<fix id>` or `fix-unverified:<fix id>` | When the verification scan settles a fix that was `applied`: one mail per verdict, so a fix that failed and later passed is two facts. A repeated verification of a fix already verified queues nothing |

`checks_run` and `checks_passed` are the scan's own counters (ADR-225): the checks the engine ran and
those that raised no finding. The summary shows them next to the previous scan's, never as a score of
the store.

**Mail for a shop that has left is dropped.** The mailer refuses notification and marketing mail
(`shop_left`) when the shop is not `installed`, so an uninstall between the queueing and the sending
does not mail a stranger's former store. Transactional mail (the uninstall export itself) still goes.

**The mailer builds the admin deep links.** Templates need a URL that opens inside the Shopify admin
(`https://admin.shopify.com/store/<store>/apps/<handle>/<page>`), because the app's own origin cannot be
opened without an App Bridge session. The mailer builds it when it sends, from the shop's permanent
domain and the app handle, so the jobs need to know neither. The handle defaults to `rampsmith`, the
`handle` of `shopify.app.toml`; `SHOPIFY_APP_HANDLE` overrides it for a differently named app (staging).
No new founder input. The format is from memory of Shopify's admin URLs and is a LAUNCH.md section E
item.

**The leader starts the weekly rescans.** `due_weekly_rescans(after, limit)` is a security definer
function only the worker role may execute. It lists, across tenants, the installed shops with the
setting on and no scan other than verification scans that is queued, running or finished in 7 days or
created in the last day (a failed scan is retried the next day, not on every tick). It pages by shop id
so a shop the scheduler skips never hides those behind it. For each shop `ctl` then opens that shop's
tenant transaction, locks the site, and applies the app's own rules again on what the rows say now: the
setting is still on, the plan's render cadence is weekly or better (Free's is monthly; no confirmed plan
has Free's entitlements, ADR-084), no scan is under way. It creates a `scheduled` scan, enqueues
`shopify.read_store` with the key the app uses, and writes `scan.started` with actor `system`. Rounds run
every 15 minutes and start at most 100 scans; the rest wait for the next round. A scheduled scan does not
count toward the plan's manual scans per day.

## Not built (R2)

- `regression_alert`: nothing in the pipeline detects a regression (a finding that was fixed and came
  back, or a new serious finding since the last scan), so there is nothing to trigger on. The template
  stays unwired. The weekly summary carries the new and resolved counts meanwhile.
- `barrier_report_received`, `fix_approved`, `plan_changed`, `usage_limit`, the agency and store-link
  mails, `data_deletion` and `incident_notice`: no feature raises them in R1.
- Daily scans for plans whose cadence is daily: only the weekly opt-in is scheduled.
- Alerts to the merchant when a scheduled scan fails: the scan row and the audit log record it; the
  retry is the next day.

## Consequences

- A merchant who opted in sees one welcome, one first-scan mail and a summary after each scheduled
  scan, and a mail for each verified fix; each can be switched off by category (ADR-275).
- The scheduler never starts a scan the app would refuse, and a second leader or a merchant pressing the
  button at the same moment cannot produce two, because the decision is taken under the site's lock.
- Several shops in one round share the 100-scan cap; a very large install base needs a smaller
  cadence or a larger cap, a constant in `crates/ctl/src/rescan.rs`.

## Rejected alternatives

- Queue the emails from the api: the api does not see scan or verification results.
- Decide opt-in at the trigger: two places would hold the rule, and the mailer already records the
  reason it dropped a message, which is what support needs.
- A cron job outside the leader: the leader already exists, is exclusive, and holds the cadence of the
  other sweeps.
