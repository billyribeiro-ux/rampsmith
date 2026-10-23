# ADR-310: Regression detection compares each scheduled scan with the one before it

- Status: Accepted
- Date: 2026-10-23
- Stream: R2 (daily monitoring)

## Context

PLAN §5 R2 promises that a scheduled scan tells the merchant when something got worse, and PLAN §20
makes regression alerts a Growth feature. A finding already has a stable identity: the row
`findings` keeps per `(site, fingerprint)`, with `first_seen_scan`, and `finding_occurrences` says
which scans recorded it. Nothing compared two scans.

## Decision

1. After `scan.finalize` finishes a **scheduled** scan that succeeded or was partial, in the same
   transaction, the engine writes one `regressions` row (`packages/engine/src/pipeline/regressions.ts`).
   The row is unique per scan, so a retried finalize writes nothing twice, and a scan with nothing
   to report still gets a row (zero counts) so it is evaluated once. Manual, webhook, verify and free
   scans are never compared: a merchant who just pressed the button is looking at the app.
2. The previous scan is the latest earlier finalized scan of the site that succeeded or was partial
   and ran checks. Two kinds of regression are counted, both only for findings that are open now,
   not best practices, and not accepted risks or false positives:
   - **new**: `first_seen_scan` is this scan;
   - **reappeared**: seen in an earlier scan, absent from the previous one (`finding_occurrences`),
     and open again, which is what a fix that stopped holding or a rollback looks like.
3. The score delta is checks passed over checks run, now and before, and the number of findings each
   scan recorded. "Score" in the UI is this pass rate; Rampsmith has no other score.
4. The record keeps the fifty most severe findings as `items` (id, rule, impact, criteria, kind); the
   counts are the totals. Titles are looked up from the rule catalog when read, never stored.
5. `regressions` is tenant-owned: `tenant_id`, composite foreign keys, row-level security. Workers
   write it; the app role reads it and records a dismissal (`dismissed_at`). `shop/redact` deletes it
   before the scans.
6. The alert is `regression_alert` through the mailer's existing path (ADR-270 to ADR-275,
   ADR-279): queued in the same transaction with message key `regression-alert:<scan id>` when the
   plan includes `Feature::RegressionAlerts`. The plan is read from `shop_billing.regression_alerts`,
   mirrored by `shop_billing::put` from `billing::entitlements` like the other limits (audit M2, M3), so
   the engine holds no second plan table. What became of the alert is stored on the record
   (`queued`, `plan`, `no_contact`, `not_applicable`). Suppression, bounces, opt-outs and unsubscribe
   stay the mailer's decision, as for every notification. The cause is always `unknown`: attributing
   a regression to a theme publish or a commit needs data the scan does not have.

## Consequences

- One extra index, `finding_occurrences (tenant_id, scan_id, finding_id)`, keeps the comparison to
  two index scans per site.
- A regression is a statement about checks Rampsmith ran. The email and screen say "new issues" and
  "issues that came back",.
- Free and Starter shops still get the record (the data exists); only the email and the screen are
  gated (ADR-311).

## Rejected alternatives

- Comparing in `ctl` or the api: neither holds the finalized scan's rows at the moment it is final.
- Diffing the finding rows' statuses only: it cannot tell "never seen" from "fixed then back".
