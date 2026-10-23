# ADR-272: `email.send@1`, recipient references and the shop contact

- Status: Accepted
- Date: 2026-10-22
- Stream: R1 email sender (`crates/contracts`, `crates/db`, `crates/ctl`, `crates/shopify-admin`)

## Decision

- **Contract.** `email.send@1` carries a template kind (the 21 of `@rampsmith/email`), a recipient
  reference (`{kind: "shop_owner", shop_id}`), typed template input and a `message_key`. It never
  holds raw HTML or an address. A pin test fails if the enum and `EMAIL_KINDS` differ.
- **Contact.** The shop owner's address is read from `Shop.email` (Admin API 2026-10) while the token
  works, on install, `shop/update` and store reads, and kept in `shop_contacts` (lower-cased, tenant
  scoped, written by ctl only, deleted by `shop/redact`). It is not in queue payloads, logs or audit
  entries; `OwnerEmail` redacts itself in `Debug`.
- **Uninstall export.** `app/uninstalled` queues the mail in the same transaction (closes audit L8).
  Its link is `{APP_ORIGIN}/app/log` and it says the data is deleted at +48 h, when Shopify sends
  `shop/redact`.

## Known gaps

- The link opens the embedded log, which needs a session, so it works after a reinstall only. A
  tokenised public export route (api and web) is not built.
- Shopify's docs do not say whether `Shop.email` needs an access scope beyond the ones granted; the
  live dev-store check in LAUNCH.md section E covers it. Without an address the audit entry says
  `not_queued_no_contact`.
- Triggers missing for the other kinds: sign-in and verification (identity), scanner mails (tenantless,
  PR #34), welcome, scan and weekly reports, regression alerts, fix and barrier mails, plan and usage
  mails, agency and store-link mails, deletion confirmation, incident and sub-processor notices.
