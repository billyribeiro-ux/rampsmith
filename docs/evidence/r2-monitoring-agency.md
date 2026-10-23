# R2: daily monitoring, regression alerts and the agency view

Decisions: ADR-310 to ADR-314. Branch `r2-monitoring-agency`. Every command below was run on the
branch against PostgreSQL 18 (fresh `initdb`) with Node 26.12.0, pnpm 12.14.0 and Chromium.

## What each requirement is proved by

| Requirement | Test | Command |
| --- | --- | --- |
| Cadence: Free monthly, Starter weekly, Growth and Pro daily; a downgrade lengthens it | `the_plan_sets_the_cadence_free_monthly_starter_weekly_growth_and_pro_daily` | `cargo test -p rampsmith-ctl --test rescan` |
| Jitter: a bounded, stable delay per shop | `shops_are_spread_by_a_bounded_delay_that_does_not_change` | same |
| Fair share: a tenant with nine shops gets five in a round, every tenant a turn first | `one_tenant_with_many_shops_cannot_starve_the_others` | same |
| One scan per period, even from two leaders | `a_due_shop_gets_one_scheduled_scan_per_period_even_from_two_leaders` | same |
| Regression diff by fingerprint: new, reappeared, exclusions, score delta, scheduled only, once | `packages/engine/test/regressions.test.ts` (7) | `pnpm --filter @rampsmith/engine exec vitest run test/regressions.test.ts` |
| Alert gating: Growth sends once; Starter, no contact, manual, no change send nothing; opt-out held back | `describe('a regression after a scheduled rescan')` | `pnpm --filter @rampsmith/engine exec vitest run test/email-triggers.test.ts` |
| Regression records are tenant-isolated, redacted with the shop, restorable | `crates/db/tests/tenancy.rs` (`regressions`, `store_links` in both lists), `crates/db/tests/regressions.rs`, `infra/restore-drill/sql/seed.sql` | `cargo test -p rampsmith-db` |
| App Home regressions: banner, list, locked state naming Growth, dismiss | `crates/api/tests/app.rs` (5), `apps/web/tests/app-screens.spec.ts`, `app-axe.spec.ts`, `app-keyboard.spec.ts`, `perf-app-home.spec.ts` | `cargo test -p rampsmith-api --test app`; `pnpm --filter @rampsmith/web exec playwright test --project=app-home --project=app-perf` |
| Agency: an unlinked store is never read | `the_overview_shows_a_store_only_after_its_merchant_approved_and_not_after_a_revoke`, `an_agency_never_sees_a_store_that_did_not_grant_a_link_or_another_agencys_link`, `the_dashboard_connection_cannot_read_links_or_other_tenants_tables` | `cargo test -p rampsmith-db --test agency`; `cargo test -p rampsmith-api --test app` |
| Revoke by merchant or agency takes effect at once | same, `an_agency_links_a_store_the_merchant_approves_and_loses_it_when_the_merchant_revokes` | same |
| Cross-tenant and cross-organization attempts | `one_tenant_cannot_list_or_revoke_another_tenants_links`, forged tenant argument in `codes_work_once_before_they_expire_and_only_for_a_shop_of_the_caller` | same |
| Codes: single use, expiry, guessing throttled per shop | `codes_are_single_use_expire_and_a_shop_that_guesses_is_stopped` | `cargo test -p rampsmith-api --test app` |
| Wrong kind of session is refused | `the_agency_routes_need_the_right_kind_of_session` | same |
| Dashboard screen: keyboard, axe, real api and database | `an_agency_creates_an_organization_and_a_link_code_and_follows_a_store_that_approved` | `pnpm --filter @rampsmith/web exec playwright test --project=dashboard` |
| App Home agency screen: approve, revoke, throttle, axe, keyboard | `agency access` in `app-screens.spec.ts`, `app-axe.spec.ts`, `app-keyboard.spec.ts` | `playwright test --project=app-home` |

## Findings during the work

- SvelteKit 3's origin check refuses a body-less `DELETE` that has no content type (treated as a form
  post). The App Home client sends `content-type: application/json` on the revoke; a unit test of the
  proxy lists the route and the method.
- `agency_approve_link` was tried with another tenant's id from inside a tenant transaction: it raises
  (SQLSTATE 42501), tested.
- Live checks that need the founder's inputs are rows in `docs/LAUNCH.md` section E.
