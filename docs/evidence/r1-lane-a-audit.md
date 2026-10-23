# R1 lane A security audit: fixes (1 high, 4 medium, 10 low)

Branch `r1-a-audit-fixes`. Each finding: change, test, command output.

## H1 shop/redact deletes an installed shop on an unsigned topic (PR 1)

- `crates/ctl/src/jobs/webhook.rs` `redact_shop`/`grant_is_gone`/`end_installation`: an `installed` shop is
  redacted only when Shopify answers 401 (or no token remains); a working token records
  `compliance.shop_redact_ignored`, marks the event processed, deletes nothing; other errors retry.
- `crates/api/src/webhooks.rs` `body_fits_topic`, `redact_names_this_shop`: shape per topic, `shop_id` vs stored `shop_gid`.
- `crates/db/src/repo/webhooks.rs` + migration `20261105000001`: digest key across topics, 40 h for `*/redact`.
- Tests: `crates/ctl/tests/webhook.rs` (relabelled `customers/data_request` as `shop/redact` deletes nothing;
  genuine `shop/redact` replayed after a reinstall deletes nothing; 503 retries; uninstalled shop redacted without asking;
  the changed `shop_redact_deletes_the_shops_data...` now answers 401 first), `crates/api/tests/webhooks.rs`
  (shape refusal, redact window, 12 concurrent replays store one event, wrong `shop_id`).
- ADR-085; ADR-080 corrected.

## M1 slow-body DoS (PR 2)

- `crates/api/src/webhooks.rs`: a pool of 512 unverified reads, a 1 s body deadline (503 on timeout), the
  64 database permits taken only after the HMAC verifies. Tests in `crates/api/tests/webhooks.rs`:
  `a_stalled_body_is_cut_off_and_never_holds_a_database_permit` (real TCP, three stalled connections fill the
  unverified pool, each is answered 503 after the deadline, a late connection is told 503 at once, then a real
  delivery is stored), `a_full_database_pool_answers_503_to_verified_deliveries_only`,
  `a_full_unverified_pool_answers_503_without_reading_the_body`.

## M2 processing backstop (PR 2)

- `WebhookProcess::MAX_ATTEMPTS = 96` set by the listener; `webhook_events_sweep()` (migration
  `20261105000002`); `ctl::leader::sweep_webhooks` every 5 minutes; runbook alert rows updated. ADR-086.
  Test: `the_sweep_brings_back_stored_events_whose_job_is_gone_and_reports_the_old_ones`
  (`crates/ctl/tests/webhook.rs`).
