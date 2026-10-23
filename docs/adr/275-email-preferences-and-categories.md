# ADR-275: Email preferences, categories and which mail can be switched off

- Status: Accepted
- Date: 2026-10-23
- Stream: R1 email features

## Decision

- **Categories** are ADR-191's: `security`, `transactional`, `notification`, `marketing`. Only
  `notification` and `marketing` can be switched off, per address, with a row in `email_opt_outs`.
- **Legally or operationally required mail is never unsubscribable** and carries no unsubscribe
  link: security notices, the uninstall data export, data-deletion and data-export confirmations,
  and billing or account notices. A bounce or complaint still stops every category (ADR-273).
- **Which address.** Notification mail goes to `notification_email` in the shop's settings when it
  is set and valid, else to the owner address Shopify reports (`shop_contacts`). An opt-out belongs
  to the address, so a merchant who changes the notification address starts with the new
  address's choices.
- **App Home.** Settings gets an Email section with one switch for store notifications; it saves
  at once, through `GET`/`PUT /v1/shopify/email-preferences`, and says nothing is sent while no
  address is on file. Marketing is not offered there: R1 sends none, and the preferences page
  behind an email link lists only what the link covers.
- **Public pages.** `/email/unsubscribe` (one category, from the footer link) and
  `/email/preferences` (every category the app offers) work without JavaScript, without login, and
  with keyboard alone; both are checked with axe in light and dark.
- **Mail with a missing key.** See ADR-274 item 6.

## Consequences

- `weekly_summary`, `first_scan_complete`, `fix_verified`, `welcome` (ADR-277, ADR-278) honour the
  switch and the unsubscribe link without further work.
- Adding a marketing email later needs the postal address (`EMAIL_POSTAL_ADDRESS`, LAUNCH.md C
  row 7), attorney review of the category mapping (LAUNCH.md C row 13), and a marketing switch in
  the settings.
