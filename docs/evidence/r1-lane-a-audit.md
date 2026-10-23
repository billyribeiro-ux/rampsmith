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

## M3, M4, L1 to L10 (PR 3)

Decisions: ADR-087. Local gate output is in the PR description and the CI run linked from STATUS.md.

| Finding | Change | Test |
| --- | --- | --- |
| M3 | `crates/api/src/plan.rs` (no-plan cached 2 min, per-shop share of the pacer), `crates/billing/src/sweep.rs` | `a_shop_that_reloads_in_a_loop_gets_one_call_for_no_plan_and_three_a_minute_at_most`, `one_shop_has_one_call_in_flight` |
| M4 | `PartnerPlans::refresh` lowers the stored AI budget; `start_scan` per-plan limits (`crates/api/src/r1.rs`) | `a_downgrade_takes_the_stored_ai_budget_down_to_the_new_ceiling_in_the_same_transaction`, `manual_scans_are_limited_per_plan_per_day_and_need_a_chosen_plan` |
| L1 | `crates/api/tests/app.rs` | `an_approval_waits_for_the_site_lock` |
| L2 | `crates/ctl/src/jobs/apply_data_fix.rs`, `data_fixes::fail_in_flight` | `crates/ctl/tests/data_fix.rs`, `crates/ctl/tests/webhook.rs` |
| L3 | `data_fixes::cancel_verification`, `packages/engine/src/jobs/verify.ts` | `revert_data_fix` test; `packages/engine/test/pipeline.test.ts` (fails without the fix) |
| L4 | migration `20261105000003`, `crates/ctl/src/rewrap.rs`, `Field<SecretString>` | `crates/ctl/tests/ctl.rs` rewrap test; runbook updated |
| L5 | ADR-085 (PR 1) | `12 concurrent replays store one event` |
| L6 | `crates/db/tests/tenancy.rs` (22 tables, seeded `shop_billing`) | `cargo test -p rampsmith-db --test tenancy` (24 passed) |
| L7 | migration `20261105000004`, `crates/db/src/repo/redact.rs` | `only_the_ctl_role_can_delete_ai_calls_and_only_for_its_own_tenant`, `redaction_and_job_cancellation_never_touch_another_tenant` |
| L8 | Not buildable: no mail transport or send job exists. The uninstall audit entry says `not_queued_no_sender`; LAUNCH.md section E has the row | none until the sender exists |
| L9 | `crates/api/src/plan.rs` client builder | build-time failure path |
| L10 | `actor_id`, `staff` in `crates/api/src/r1.rs`; ADR-083 corrected | `undo_queues_one_revert_for_an_applied_fix` (403 without a `sub`), approve test (`shopify:<sub>`) |

The main branch carried two migrations numbered `20261105000001`; the lane C one is now `20261105000005`.
The `release-verifier` and `security-auditor` subagents could not be started from this agent: the gate was
run by hand and the verifier run is left to the release gate.
