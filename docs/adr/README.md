# Architecture decision records

Each decision is written here, as its own file, before the code it governs (PLAN §6, §27).
When official documentation and PLAN.md disagree, the documentation wins: the difference is
recorded as an ADR and the plan is corrected in the same pull request.

| ADR | Decision | Status |
| --- | --- | --- |
| [001](001-rust-axum-control-plane.md) | Rust and Axum for the control plane | Accepted |
| [002](002-typescript-engine.md) | TypeScript for the engine | Accepted |
| [003](003-postgres-job-queue.md) | PostgreSQL is the job queue | Accepted |
| [004](004-never-write-theme-files.md) | Never write theme files; three fix channels | Accepted |
| [005](005-sveltekit-bff.md) | SvelteKit is a backend-for-frontend | Accepted |
| [006](006-shared-schema-rls.md) | Shared schema with `tenant_id`, enforced twice | Accepted |
| [007](007-span-patches.md) | Patches edit source spans only | Accepted |
| [008](008-billing-rails.md) | Shopify App Pricing; Stripe Billing for everyone else | Accepted |
| [009](009-generated-contracts.md) | Contracts are generated | Accepted |
| [010](010-railway-first.md) | Railway first, measured move of browser workers | Accepted |
| [011](011-model-routing.md) | Claude model routing by task difficulty | Accepted |
| [012](012-no-redis.md) | No Redis in R0 to R2 | Accepted |
| 013 | Reserved: evaluate Shopify Next Gen Events in R3 (PLAN §14) | Reserved |

## Template

```markdown
# ADR-NNN: Title in sentence case

- Status: Proposed | Accepted | Superseded by ADR-NNN
- Date: YYYY-MM-DD

## Context
What forces the decision, with links to the evidence.

## Decision
What we do, stated so it can be checked.

## Consequences
What becomes easier, what becomes harder, what must now be true.

## Rejected alternatives
- Option: why not.
```
