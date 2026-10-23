# ADR-296: A batch moves through fixed states, split between ctl and the engine

- Status: Accepted
- Date: 2026-10-23
- Relates to: ADR-004 (no theme writes through an API), ADR-290, ADR-294

## Decision

A batch is a row of `code_fix_batches` with one status: `reading`, `patching`, `ready`, `opening`,
then `opened`, `nothing_to_fix` or `failed`. Each step is a queue job that is safe to run twice.

1. `github.plan_batch` (ctl) reads the theme files through `crates/github` (read-scoped installation
   token, the path, size and count guards of ADR-294) and stores them, then enqueues `code_fix.patch`.
2. `code_fix.patch` (engine) runs `planBatch` from `@rampsmith/liquid-patch`, which runs Theme Check
   in memory over the patched files and drops any fix that adds an offence. In one transaction it
   writes the `fixes` (kind `code`, channel `github_pr`, status `proposed`), their links to findings,
   the per-fix summary, the files after each fix, and the next status. With no fixes it ends the batch
   as `nothing_to_fix`. Otherwise it enqueues `github.open_pr`.
3. `github.open_pr` (ctl) plans the pull requests, pushes `rampsmith/fix-<batch>` and opens or
   updates the pull request. It never writes the connected branch and never merges. Commit
   messages hold only fixed text (no finding text, audit M2); the pull request body holds finding
   text in code spans, the WCAG criterion, before and after, and how to revert.
4. `github.sync_pr` (ctl) records the pull request's state read from the API. A merged pull request
   moves its fixes to `applied`, a closed one to `rejected`.

The engine never talks to GitHub and never holds its key. ctl never runs a recipe. The corpus
re-render check (the same recipes over rendered corpus themes, no regression) is the corpus measure,
not a runtime step: the production path has no preview theme to render (ADR-004), so the check run
reports `NoPreviewTheme` and says so.

## Consequences

A crash at any step resumes from the stored status. A final failure marks the batch `failed` and
deletes the stored source.
