# ADR-273: Suppression semantics and the engine's email settings

- Status: Accepted
- Date: 2026-10-22
- Stream: R1 email sender (`packages/engine`, `infra/railway`)

## Decision

- `email_suppressions(tenant_id, address_hash, reason)` stores `email_address_hash(tenant, address)`, a
  tenant-salted SHA-256, never the address. `unsubscribed` blocks the notification and marketing
  categories; `bounced`, `complained` and `manual` block every category. The category is known from the
  template before rendering. A suppressed message is recorded as `suppressed` and is never sent later,
  even if the list changes.
- Nothing writes suppressions yet: the unsubscribe endpoint, the preferences page (ADR-191, ADR-194) and
  SES bounce and complaint ingestion (SNS) are not built. `repo::email::suppress` is ready for them.
- Settings: `SES_REGION`, `SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY`, `EMAIL_FROM` (LAUNCH.md C row 7)
  plus `APP_ORIGIN` (set from the app host by `railway.py`), and optional `SITE_ORIGIN` (defaults to the
  app origin), `EMAIL_SUPPORT_ADDRESS` (defaults to the sender) and `EMAIL_POSTAL_ADDRESS` (needed for
  the notification and marketing kinds; ADR-194 says C row 7 should list it, not yet done because
  `rsctl`'s drift test then needs a matching variable). Missing settings make the job retry with
  `email_not_configured`, naming settings and never values.
