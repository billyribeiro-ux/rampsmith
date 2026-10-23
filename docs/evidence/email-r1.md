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

## Part 2: security audit of PR #37 (2 medium, 6 low)

Each finding was checked against `origin/main` before it was fixed.

| Finding | What was true on main | Fix | Evidence |
| --- | --- | --- | --- |
| M1 SES keys beside Chromium | `railway.py` gave `_engine` the `SES_*` variables, `queues.ts` served `email.send` on every engine, `browser.ts` launched Chromium with no `env` | A `mailer` Railway service from the engine image (`packages/engine/src/mailer.ts`) serves only `email.send`; the engine no longer serves it or holds any email variable; Chromium gets a minimal explicit environment (ADR-276) | `packages/engine/test/mailer-isolation.test.ts` (import graph reaches no browser code, no browser dependency), `browser.test.ts` (env allowlist, a real launch with it), `infra/railway/tests` (103 passed: start command, shared image, SES only on the mailer, the engine holds no email variable, the mailer holds no egress, Claude, R2 or scan-secret variable), `infra/railway/tests/image_smoke.sh` and the deploy and release workflows start and check it; threat model TB9 and ADR-182 corrected |
| M2 export link cannot work | `{APP_ORIGIN}/app/log` needs an App Bridge session | The record is attached as a CSV (ADR-277); PLAN §19 corrected; LAUNCH.md E row replaced by a live check that opens the CSV | `packages/engine/test/email-send.test.ts` (4 new: attached and holds only the tenant's fixes, header-only file, unwritable row fails for good with nothing sent, no other mail carries a file), `packages/email/test/sender.test.ts` (attachment guard), `ses.test.ts` (the `Attachments` shape; the fake SES checks the service model's limits and enums), the three `uninstall_export` snapshots |
| L1 second `app/uninstalled` cancels the mail | `cancel_pending` cancelled every ready job but one queue | It spares `email.send` too | `crates/ctl/tests/email.rs` `a_replayed_uninstall_queues_nothing_more` now asserts the job is still `ready`; `crates/db/tests/tenancy.rs` `cancelling_pending_jobs_spares_the_email_queue` |
| L2 duplicate sends | Two attempts at one key could both reach SES while one was in flight or after a lease was lost | The ledger claims a row only when no live attempt holds it (60 s, or a recorded retry), and the handler checks its lease before the SES call | `packages/engine/test/email-send.test.ts` `two attempts at one message (audit L2)` (3 tests); ADR-271 and threat model C8 corrected |
| L3 `plausible` looser than the CHECK | `owner@.com` passed `plausible`, failed the insert, and broke the store read | `plausible` follows `isEmailAddress` | `crates/db/src/repo/email.rs` unit test (11 bad shapes), `crates/ctl/tests/email.rs` (`owner@.com` is "unusable") |
| L4 `Shop.email` shares a query | A field problem would fail the whole shop read | `RampsmithShopOwner` is its own query; its failure is "none reported" | `crates/shopify-admin/tests/admin.rs` `a_failed_read_of_the_owner_address_leaves_the_shop_read_with_no_address`; the throttle tests now expect two requests per `shop()` |
| L5 no inventory or retention | `shop_contacts`, `email_deliveries` and the suppression lists were not in PLAN §19 | Rows added; `shop/redact` deletes the deliveries; `email_records_sweep()` runs in the leader; the hash is called pseudonymous | `crates/db/tests/tenancy.rs` `redaction_deletes_the_shops_delivery_records_and_contact_and_no_one_elses`, `the_email_sweep_removes_old_deliveries_and_contacts_of_long_gone_shops_only` |
| L6 api could select `shop_contacts` | Migration 20261106000001 granted it | Migration 20261109000010 revokes it; the switch reads a hash through a tenant-scoped security definer function; the restore drill accepts `denied` for that one table | `tenancy.rs` `only_ctl_writes_contacts_and_workers_cannot_delete_deliveries` (the app role now gets permission denied on a select), `crates/api/tests/email_links.rs` (the switch still works) |
| Notes | The botocore script was promised in a test comment; `ShopInfo.email` was serialisable | Script and its output are in `docs/evidence/email-sender.md`; `#[serde(skip_serializing)]` | `admin.rs` asserts the serialised shop holds no address |

### Environment notes

- `infra/restore-drill/verify.sh` was edited and `tests/negative.sh` and `tests/fake-in-container.sh` were
  not changed; the full drill needs PostgreSQL binaries and a container this environment lacks, so the
  `denied` branch is exercised by `crates/db/tests/tenancy.rs` and the live restore (a LAUNCH.md section
  E item that already exists).
- The egress proxy test `spans_and_logs_never_contain_the_merchants_host` is flaky on a loaded machine
  and was not touched.
