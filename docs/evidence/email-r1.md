# Evidence: R1 email features (2026-10-23)

Branch `r1-email-features`, on the merged sender (PR #37, `79481a4`). ADRs 274 and 275 (this part);
bounces, triggers and the audit fixes follow in their own sections as they merge.

## Part 1: unsubscribe links, preferences, one-click, postal address

| What | Evidence |
| --- | --- |
| Token mints and verifies in TypeScript, and the same vectors verify in Rust | `packages/email/test/link-token.test.ts` (14), `packages/email/test/fixtures/link-vectors.json`, unit tests in `crates/api/src/email_link.rs` |
| Tampered, truncated, wrong-purpose, wrong-key and expired tokens are refused; the signature is checked before any claim | the same tests; `crates/api/tests/email_links.rs` `a_forged_expired_or_garbled_link_is_refused_and_changes_nothing` |
| `List-Unsubscribe` is the one-click URL on the webhook host, `List-Unsubscribe-Post` is exactly `List-Unsubscribe=One-Click`, both only on notification and marketing mail | `packages/email/test/one-click.test.ts` (5); `packages/engine/test/email-send.test.ts` `carries signed, single-purpose links and the one-click headers` |
| One-click POST switches the category off with no cookies or session; a GET only redirects; a preferences token cannot one-click | `crates/api/tests/email_links.rs` `one_click_unsubscribes_on_a_post_with_the_rfc_8058_body_and_a_get_only_redirects` |
| A link switches only its own category, is idempotent, is audited without the address, and can be undone | `a_link_switches_only_what_it_was_made_for_and_records_it` |
| The send respects the opt-out, and the notification address override | `email-send.test.ts` `is not sent once the recipient has opted out`, `goes to the notification address the merchant chose`; export mail (transactional) is still sent |
| No unsubscribe key: the send waits and retries, naming the setting, never sending unsubscribable mail without a working link | `email-send.test.ts` `retries, naming the setting, while the link keys are unset` |
| Tenant isolation of `email_opt_outs` (RLS, grants, completeness list) | `cargo test -p rampsmith-db --test tenancy`: 33 passed |
| App Home switch: `GET`/`PUT /v1/shopify/email-preferences`, session required, 404 with no address, 422 for any other category | `a_preferences_link_covers_every_category...`, `the_app_home_switch_follows_the_address_the_mail_goes_to` |
| Public pages: axe WCAG 2.2 A and AA in light and dark for the page with data, after a change, expired, invalid and empty links; keyboard focus ring; works with JavaScript off | `apps/web/tests/site-email.spec.ts` (22 tests in the site project) |
| App Home Email section: switch saves at once, survives a reload, axe (settings screens in four scenarios), keyboard | `app-screens.spec.ts`, `app-keyboard.spec.ts`, `app-axe.spec.ts` (72 passed with the site tests) |
| `EMAIL_POSTAL_ADDRESS` and `EMAIL_LINK_KEYS`: `Var`s, LAUNCH.md C rows 7 and 12 (drift test), doctor checks (shape, separate from the other rings), `railway.py` placement and secret-user tests | `cargo test -p rsctl`, `infra/railway/tests` (89 passed) |
| Backup test flake: the injected byte is the original XOR 0xFF, so it always differs | `infra/backup/tests/fake-aws.sh` `corrupt()`; checked on a file whose byte 101 is `X` and on one whose byte is 0 |

### Findings made while building

- SvelteKit 3 refuses a form-type POST without an `Origin` header, so RFC 8058 one-click cannot be a Kit
  route (ADR-274). A page sending `Referrer-Policy: no-referrer` makes the browser send `Origin: null` on
  its own forms, which Kit refuses too (found by the no-JavaScript test); the link pages use `same-origin`.
- A `load` and an `action` that both call `setHeaders` for one header fail the request with a 500 in
  SvelteKit; the private-page headers are set in `hooks` (`headers.ts`) instead.
- RFC 8058 and the Gmail and Yahoo pages could not be fetched from this environment (the egress proxy
  refuses `rfc-editor.org`, `ietf.org`, `support.google.com`, `senders.yahooinc.com`); the requirements used
  are the ones ADR-191 quoted from them. DKIM coverage of `List-Unsubscribe` and `List-Unsubscribe-Post`
  stays a live check (LAUNCH.md section E).
