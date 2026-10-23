# ADR-089: Deleting AI call records belongs to a group of its own, `rampsmith_redactor`

- Status: Accepted
- Date: 2026-10-22
- Refines: ADR-037, ADR-087 item 9
- Fixes: re-audit M-3

## Context

ADR-087 let `ctl` redact AI call records through `redact_ai_calls()`, executable by a role the
migration called `rampsmith_ctl`. In production `rampsmith_ctl` is also the name of ctl's own
LOGIN (`infra/railway/bootstrap.sql`, `infra/railway/railway.py`). Migration `20261105000004`'s
`create role rampsmith_ctl nologin ...` therefore hit `duplicate_object`, which the migration
swallows, and the grant landed on the login by a coincidence of names. The tests used a separate
NOLOGIN group of the same name, so they did not test production. LAUNCH.md and ADR-087 told the
founder to `CREATE ROLE rampsmith_ctl_login LOGIN ... IN ROLE rampsmith_ctl`, which, in
production, would have made a second login with the same privilege.

## Decision

1. A NOLOGIN group `rampsmith_redactor` holds the privileges only ctl needs beyond the worker
   group: `execute` on `redact_ai_calls()` and, since the email sender (migration
   `20261106000001`), the writes to `shop_contacts` (migration `20261107000001_redaction_group.sql`,
   which revokes both from the role named `rampsmith_ctl`). It is not a member of anything.
2. `bootstrap.sql` creates the group (before the migrations may have) and grants it to the
   `rampsmith_ctl` login, next to `rampsmith_worker`. The engine and api logins are not members.
   There is no second login for ctl, and the instruction to create one is deleted.
3. The tests build ctl's login the same way: a LOGIN role in `rampsmith_worker` and
   `rampsmith_redactor` (`crates/ctl/tests/support`, `crates/db/tests/support`). The restore drill
   fixture (`infra/restore-drill/sql/roles.sql`) and `restore.sh` know the group, because a restored
   dump grants the function to it.
4. The startup guards check the privilege itself, not a group name:
   `has_function_privilege(current_user, 'public.redact_ai_calls()', 'execute')`. `ctl` refuses to
   start without it (`RuntimeRole::Ctl`, `RoleViolation::CannotRedact`), and the api and the
   engine refuse to start with it (`RoleViolation::CanRedact`; `packages/engine/src/role-guard.ts`).
   `infra/railway/tests/bootstrap_test.sh` asserts the same on the bootstrapped logins, that
   exactly four `rampsmith_*` logins exist, and that ctl can call the function and the engine gets
   "permission denied".

## Consequences

- An environment bootstrapped before this change must run `bootstrap.sql` again (it is safe to
  repeat) before it deploys, or ctl refuses to start with a message naming the missing privilege.
- The role named `rampsmith_ctl` that migration `20261105000004` creates on a database without
  that login stays as an unused NOLOGIN group with no privilege beyond `rampsmith_worker`'s.
  Migrations that have been applied are never edited.
