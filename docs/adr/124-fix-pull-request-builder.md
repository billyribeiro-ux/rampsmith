# ADR-124: Fix pull-request builder: splitting, commits, body and check run

- Status: Accepted
- Date: 2026-10-17
- Stream: WS-3 (`crates/github`)

## Context

PLAN §15 "Pull requests": head branch `rampsmith/fix-<batch id>` from the connected branch;
one pull request per batch, capped at 20 files and 400 changed lines; one commit per fix such as
`fix(a11y): add accessible name to cart icon link [WCAG 2.4.4]` with a `Rampsmith-Fix: <fix id>`
trailer; a body listing each finding, its criterion, the change and the in-app evidence link,
ending with revert instructions; a "Rampsmith verification" check run reporting success,
failure, or neutral without a preview theme. PLAN §12 lists verification and undo per channel;
§3 bans outcome claims.

Two facts shape the split. Fixes in one batch can edit the same file, and each fix's patch is
computed on the previous fix's result, so those fixes cannot land in different pull requests.
And a recipe such as "missing form labels" adds a translation key to every locale file
(PLAN §12), which on a theme with 30 locales is one indivisible fix touching 31 files.

## Decision

1. **Inputs** are plain structs in this crate: `Batch { id, fixes }`, `Fix { id, summary,
   finding, criterion, evidence_url, files }`, `FilePatch { path: ThemePath, mode, before,
   after }`. Validation refuses an empty batch or fix, duplicate fix ids or paths, a no-op patch,
   a broken patch chain (a fix's `before` must equal the previous fix's `after` for that file),
   a non-https evidence link, and an empty or over-100-character summary.
2. **Split, deterministically.** Fixes that share a file form a group (union by shared path,
   batch order kept). A group's size is its distinct files and the changed lines of the net
   diff per file (first `before` to last `after`), counted as GitHub does: additions plus
   deletions of a Myers line diff. Groups are packed first-fit, in batch order, into pull
   requests of at most 20 files and 400 changed lines. A group that alone exceeds the cap gets a
   pull request of its own, marked `over_cap`, whose body explains why; it is the only way a pull
   request exceeds the cap. Parts change disjoint files, so they merge in any order.
3. **Branches.** One part: `rampsmith/fix-<batch id>`. Several: `rampsmith/fix-<batch id>-<n>`.
   Batch ids are 1 to 64 letters, digits or hyphens, so branch names are URL-safe.
4. **Commits.** `fix(a11y): <summary> [WCAG <criterion>]`, a blank line, `Finding: <finding>`
   (one line, at most 300 characters), a blank line, and `Rampsmith-Fix: <fix id>` alone in the
   last paragraph, where Git reads trailers. Whitespace, control and bidirectional characters are
   collapsed, so neither the summary nor the finding can add a trailer or a paragraph. Author and
   committer are left to GitHub, which records the App.
5. **Body.** Finding text may quote storefront content, so it is rendered as a code span with a
   fence longer than any backtick run: GitHub renders no HTML, links, images, `@` mentions or `#`
   references inside it. Recipe summaries are backslash-escaped, with a word joiner after `@` and
   `#`. Evidence links are `https` URLs in angle brackets, marked "sign-in required". The body
   ends with how to undo before merging (close), after merging (GitHub's Revert, then Shopify
   syncs) and for one fix (`git revert` of the commit whose trailer names it), then the statement
   that automated checks find only part of all issues.
6. **Check run.** `verification_check_run` builds the documented create body
   ([check runs](https://docs.github.com/en/rest/checks/runs)): `name` "Rampsmith verification",
   `head_sha`, `status` completed, `conclusion` success, failure or neutral (no preview theme),
   `completed_at` as `YYYY-MM-DDTHH:MM:SSZ`, `details_url`, `external_id` (batch id) and an
   output title and summary. Updates send the same fields without `head_sha`.

## Consequences

- Planning is pure and repeatable; the same batch always yields the same parts, commits and
  bodies (tested).
- A re-derive (PLAN §15) re-plans on the new base. If recipe output changes size, a batch can
  split differently; the `github.sync_pr` job (not this crate) closes pull requests whose branch
  no longer appears.
- A test asserts that the body, title and every check-run text contain none of the banned
  claims of PLAN §3.

## Plan correction

PLAN §15 "Pull requests", first bullet — replace with:

```
- Head branch `rampsmith/fix-<batch id>` from the connected branch. A batch becomes as few pull requests as fit 20 files and 400 changed lines each; fixes that edit the same file stay together, and a batch that splits uses `rampsmith/fix-<batch id>-<n>`. A group of fixes that cannot be split and alone exceeds the cap (for example a label fix that adds a translation key to every locale file) gets its own pull request, whose body says why it is larger (ADR-124).
```

## Rejected alternatives

- Refusing over-cap fixes: label fixes on multi-language themes could never ship by pull
  request.
- Splitting a fix across pull requests: each part would be broken on its own.
- Next-fit packing: more pull requests for the same batch with no gain in determinism.
- Counting lines as common prefix and suffix only: overcounts two distant edits in one file.
