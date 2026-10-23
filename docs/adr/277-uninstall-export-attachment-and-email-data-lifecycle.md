# ADR-277: The uninstall record travels as an attachment, and how long email data lives

- Status: Accepted
- Date: 2026-10-23
- Stream: R1 email audit fixes (audit M2, L1, L3, L4, L5, L6)

## Context

The security audit of PR #37 found that the uninstall email promised a download link that could not
work: `{APP_ORIGIN}/app/log` is an App Bridge page, and a shop that has just uninstalled has no
session. It also found that a second `app/uninstalled` cancelled the queued mail, that the address
check was looser than the table's, that one failing Admin field could break the whole store read, and
that the email tables had no retention or deletion story.

## Decision

- **M2. The record is attached.** `uninstall_export` has no link. The mailer builds the remediation
  record as a CSV with `@rampsmith/reports` (the renderer behind the app's own export, ADR-091) from
  the tenant's own `fixes`, `fix_findings` and `findings`, inside the job's tenant transaction, and
  sends it as an SES v2 `Message.Attachments` entry (`FileName`, `ContentType: text/csv`,
  `ContentDisposition: ATTACHMENT`, `ContentTransferEncoding: BASE64`, `RawContent` base64; the shape
  and the 255 and 78 character limits are from botocore's `sesv2` model, which the fake SES checks).
  Rejected: a tokenised download route (a second way into the record, a new public surface, and a
  token that must survive the uninstall); a link to the app (cannot work).
  - A store with no fixes gets the header-only file, because the copy says the record is attached.
  - The guard refuses more than two files, a name that is not a plain file name, any type but
    `text/csv` or `application/json`, and more than 10 MiB in all. AWS's 40 MB message quota is from
    memory (the quotas page is unreachable here), so the cap is far below it and a near-cap live send
    is a LAUNCH.md section E check.
  - A record with more than 20,000 fixes, or a row the renderer refuses, fails for good with
    `record_too_large` or `record_invalid`, and nothing is sent, so a part of the record is never
    presented as the whole.
  - The approver column says "system": Shopify does not give the app the staff member's name (the
    app's own export says the same).
  - PLAN §19 is corrected: the mail carries the record, and after `shop/redact` it cannot be
    produced again.
- **L1. Email survives the uninstall's cancellation.** `jobs::cancel_pending` leaves the
  `email.send` queue alone, so a repeated `app/uninstalled` cannot cancel the export mail still
  waiting. `webhook.rs` is untouched apart from dropping the link.
- **L3. One address rule.** `plausible` in `crates/db/src/repo/email.rs` follows `isEmailAddress`
  (ASCII atoms, LDH labels, an alphabetic top-level label, 254 characters), so an address the table's
  check would pass but the sender would refuse is "unusable" and is never stored. Before, `owner@.com`
  failed the insert and the whole store read with it.
- **L4. `Shop.email` is read on its own.** `RampsmithShopOwner` is a second, one-point query. Its
  failure is "none reported" and the shop, locales and theme are still read. `ShopInfo.email` is not
  serialised: the shop is stored as a scan input for the engine, which does not need the address.
- **L5. Retention.** `shop/redact` deletes `email_deliveries` as well as `shop_contacts`.
  `email_records_sweep()` (worker-executable, ages fixed in the migration, run by the leader's
  retention sweep) deletes `shop_contacts` of shops uninstalled for 30 days whose `shop/redact` never
  arrived, and `email_deliveries` not changed for 90 days (never one still `sending`). Suppressions and
  opt-outs are kept for the life of the tenant so an unsubscribe is honoured after a reinstall; they
  hold SHA-256 of the tenant id and the address, which anyone with the database can test a guess
  against, so PLAN §19 calls them pseudonymous and not anonymous. Keying the hash with a secret would
  need the secret in the api, the mailer and the migration's SQL function at once, and is left to R2.
- **L6. The api login cannot read owners' addresses.** Migration 20261109000010 revokes the application
  role's SELECT on `shop_contacts`. The App Home switch still needs the hash of the address the mail
  goes to, so it calls `email_notification_hash(shop)`, a security definer function that answers for the
  session's tenant only and returns no address. The restore drill's row-level-security count prints
  `denied` for a table the login cannot read and accepts it only for the tables `verify.sh` lists
  (`public.shop_contacts`); the owner's count of that table still has to match.

## Consequences

The mailer now reads `fixes`, `fix_findings`, `findings`, `shopify_shops` and `shop_contacts` through
the engine's worker login, which it already held for the other engine jobs. A failed record is visible
as a dead job with a code, not as a silent gap. Mail queued before this change with an `exportUrl` is
refused by the template (unknown field) and fails for good; none was sent in production.
