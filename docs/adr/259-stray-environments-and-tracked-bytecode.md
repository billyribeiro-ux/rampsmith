# ADR-259: CI fails when the old backup environments exist or Python bytecode is tracked

- Status: Accepted
- Date: 2026-10-22
- Stream: R1 backup hardening
- Refines: Closes LOW-2 and LOW-3

## Context

The deleted backup workflow named `backup-production` and `backup-staging`; GitHub created them unprotected the first time (GitHub, "Managing environments"). Ten `.pyc` files were committed under `infra/`.

## Decision

- `drill-strays` in `restore-drill.yml` lists the repository's environments and fails if either exists (`check_environment.py --stray`). If the workflow token cannot list environments it warns, naming LAUNCH.md row 16, because a refusal proves nothing. The founder deletes both by hand.
- The `contracts` job fails if any `*.pyc` or `__pycache__` file is tracked; `.gitignore` excludes them.

## Consequences

The leftovers cannot return unnoticed.

## Rejected alternatives

- A repository ruleset: does not cover environments.
