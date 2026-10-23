# R1 webhook and redaction re-audit: fixes and evidence

| Field | Value |
| --- | --- |
| Date | 2026-10-22 |
| Branch | `r1-webhooks-fixes` |
| Source | The security re-audit of the Shopify webhook and redaction code (PASS, 3 medium, 7 low, 1 gap) |
| Decisions | ADR-088 (subscriptions), ADR-089 (redaction group), ADR-269 (the other fixes) |

Every row names the change and the test that fails without it. Local gate: `cargo test --workspace`
(991 passed, 0 failed, PostgreSQL 18), `cargo clippy --workspace --all-targets --all-features -- -D warnings`
(clean), `cargo fmt --all --check` (clean), `python -m unittest discover -s infra/railway/tests`
(101 tests, OK, 2 skipped with notices), `vitest run test/role-guard.test.ts` (12 passed), `tsc --noEmit` (clean).
`bootstrap_test.sh` steps 1 to 6b pass; step 7 (old password refused after rotation) cannot pass on
the local cluster, which uses `trust` authentication, and is covered by CI's password-authenticated cluster.

| Finding | Change | Test |
| --- | --- | --- |
| GAP: no subscriptions | `shopify.app.toml`: `app/uninstalled`, `shop/update` and the three compliance topics to `https://hooks.rampsmith.invalid/webhooks/shopify`, API version 2026-10. Schema read from `@shopify/cli` 4.9.4 and `@shopify/app` 3.58.2 (ADR-088). `deploy.yml` checks the file before deploying. LAUNCH.md section E row for the real host and a live delivery | `infra/railway/tests/test_shopify_app_config.py` (9 tests; the host-match test skips with a notice until `RAMPSMITH_WEBHOOK_HOST` is set) |
| M-1 redaction strands other events | `redact::shop` cancels ready `webhook.process` jobs, closes unprocessed events and clears bodies, in that order; the sweep ignores body-less events of redacted shops (migration 20261107000002) | `crates/db/tests/webhook_redaction.rs`; `crates/ctl/tests/webhook.rs` (redaction with a second pending event leaves no dead job and no alert) |
| M-2 grant-check answers fail for good | Only 401 ends an installation; 404 means gone for `shop/redact`; every other answer retries; `*/redact` events are requeued for 45 days (14 for other topics); operator path `rsctl shops redact` (runbook section 6); LAUNCH.md E live check | `crates/ctl/tests/webhook.rs` (402, 403, 404, 423, `SHOP_INACTIVE`); `crates/rsctl/tests/shops.rs`; `crates/db/tests/webhook_redaction.rs` (sweep window) |
| M-3 `rampsmith_ctl` is login and group | New NOLOGIN group `rampsmith_redactor` holds `redact_ai_calls()`; bootstrap grants it to the login; ctl refuses to start without it, the engine refuses to start with it; ADR-087 corrected; LAUNCH.md instruction removed | `crates/db/tests/roles.rs`; `packages/engine/test/role-guard.test.ts`; `infra/railway/tests/bootstrap_test.sh` step 6b; test support builds roles like production |
| L-1 replay digest across topics | Compliance topics share the plain digest; other topics hash topic and digest | `crates/api/tests/webhooks.rs` (same body, two topics) |
| L-2 status read without lock | `lock_status` (`for update`) inside the deleting transaction; a changed status stops the redaction (`shop_changed`). Known limit: two reinstalls between the grant check and the lock look unchanged (ADR-269) | `crates/ctl/tests/webhook.rs` |
| L-3, L-4 payload shapes | `body_fits_topic`: per-topic required and denied keys, extra keys tolerated, rejects logged at error level | `crates/api/src/webhooks.rs` unit tests; `crates/api/tests/webhooks.rs` |
| L-5 `ai_draft_holds` | Added to `TENANT_TABLES` and deleted by `redact::shop` | `crates/db/tests/tenancy.rs`; `crates/db/tests/webhook_redaction.rs` |
| L-6 slow headers | hyper `header_read_timeout` 5 s on both listeners, 30 s drain (`crates/api/src/serve.rs`) | `crates/api/tests/serve.rs` |
| L-7 docs | ADR-085, 086, 087, 080 and the two runbooks corrected; see the diff | `prettier --check` on `docs/` |
| Process: edited migrations | `MigrationsAreImmutable` fails a PR that modifies, deletes or renames a migration already on origin/main; `release.yml` fetches full history for it | `infra/railway/tests/test_migrations.py` (temp-repo test) |

Not fixed, by decision: the double-reinstall window above, and `/webhooks/github` (not part of this audit).
