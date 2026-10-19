# WS-12 evidence: the AI subsystem (PLAN §13)

- Stream: WS-12, branch `ws/ai` from `r0-foundations` at 16926b5
- Draft pull request: [#3](https://github.com/billyribeiro-ux/rampsmith/pull/3) `ws/ai` →
  `r0-foundations`, "WS-12: AI subsystem (do not merge; stream CI)"
- Owned paths: `packages/ai/`, `docs/adr/211` to `217`, this file. `pnpm-lock.yaml` changed only
  through `pnpm install`.
- Dates: 2026-10-17 to 2026-10-18

## What was built

`@rampsmith/ai` (`packages/ai`), a TypeScript library the engine's ai worker calls (ADR-211).
It has no database, queue or HTTP-server code.

| Area | Where | ADR |
| --- | --- | --- |
| Model routing per task: model, mode (sync or batch), effort, thinking, `max_tokens`, timeout, cache TTL | `src/routing.ts`, `src/models.ts` | 212 |
| Versioned prompts with a SHA-256 manifest over prompt text and strict schema; the loader refuses a mismatch | `prompts/<task>/v<N>.txt`, `prompts/manifest.json`, `src/prompts.ts` | 213 |
| Structured outputs: wire schema without unsupported keywords, Ajv 8.20.0 strict validation of the full schema, one text block, stop-reason checks | `src/schema.ts`, `src/outputs.ts`, `src/calls.ts` | 212, 213 |
| Alt text: Haiku 5.5 with escalation to Sonnet 5.5, length, opening, markup, quote, backslash, hidden-character, URL, instruction, banned-claim, language and script checks | `src/tasks/alt-text.ts`, `src/language.ts` | 213 |
| Description rewrites as span edits on the merchant's HTML, re-parsed to prove nothing else changed | `src/html.ts`, `src/tasks/rewrite.ts` | 216 |
| Source-mapping tie-breaks (Sonnet 5.5, confidence ≥ 0.9, cited attribute unique to the chosen candidate) | `src/tasks/tie-break.ts` | 213 |
| Patch-proposal requests (Opus 5.5, batch) and the allowlist check on the patched span | `src/tasks/patch-proposal.ts`, `src/patch-safety.ts` | 213 |
| Rule explanations (Haiku 5.5, batch), plain text, always `human_edit_required` | `src/tasks/explain.ts` | 213 |
| Retries with equal jitter honouring `retry-after`, per-route timeouts, abort, circuit breaker | `src/resilience.ts`, `src/transport.ts`, `src/errors.ts` | 215 |
| Message Batches: chunk, submit, poll, collect with request fingerprints, retire (delete) | `src/batch.ts` | 215 |
| Cost accounting in integer micro-dollars from the published prices, worst-case reservation, per-store monthly budget guard | `src/cost.ts`, `src/budget.ts`, `src/calls.ts` | 214 |
| Data handling: what may be sent, normalization, scrubbing, delimiting, injection detection, image checks | `src/untrusted.ts`, `src/images.ts`, `src/claims.ts` | 213 |
| Observability: an `ai_calls` record per call without content; OpenTelemetry spans and metrics with metadata only | `src/calls.ts` | 214 |
| Evaluation harness: 20-image openly licensed set, metrics for the 80% target and the 2% gate, recorded and live runners, grader | `src/eval/`, `eval/dataset/`, `eval/recorded/` | 217 |

Dependencies (each checked with `npm view <pkg> version peerDependencies` on 2026-10-17 or
2026-10-18, pinned exactly; ADR-211): `@anthropic-ai/sdk` 0.135.0, `ajv` 8.20.0, `parse5`
8.0.1, `@opentelemetry/api` 1.9.1, `@rampsmith/claims-lint` (workspace); dev only: `vitest`
5.0.5, `@opentelemetry/sdk-trace-base` 2.12.0, `@rampsmith/tsconfig` (workspace). The SDK pin
is 2 days younger than Renovate's 7-day minimum release age; ADR-211 §4 records the exception
(it qualifies on 2026-10-22).

## Tests

`pnpm --filter @rampsmith/ai test` at 922e5d5: **359 passed, 3 skipped (the live checks), 0
failed**, 17 files, about 6 seconds, no network.

| File | Passed | What it covers |
| --- | --- | --- |
| `test/alt-text.test.ts` | 50 | Prompt building, every alt-text check, escalation, prompt injection in titles and images, malformed and truncated output |
| `test/audit.test.ts` | 32 | One block per security-audit finding (below) |
| `test/batch.test.ts` | 7 | Submit, poll, collect in any order, expired and errored items, fingerprints, retire |
| `test/budget.test.ts` | 8 | Reserve, settle, release, idempotence, periods |
| `test/claims.test.ts` | 4 | Banned claims in output, claims the source already had |
| `test/cost.test.ts` | 17 | Image tokens, resize plan, tiered prices, cache prices, batch discount, worst case |
| `test/eval.test.ts` | 17 | Dataset loading and licences, metrics, rating sample, release gate, recorded runner |
| `test/images.test.ts` | 6 | Media types, magic bytes, header sizes, limits |
| `test/live.test.ts` | 0 (3 skipped) | Live API checks; skip with the notice below |
| `test/prompts.test.ts` | 7 | Manifest hashes, versions, the claims-lint CLI over every prompt file |
| `test/resilience.test.ts` | 20 | Retry delays, `retry-after`, breaker states and probes |
| `test/rewrite.test.ts` | 27 | Analysis, span edits, escaping, re-parse verification, outline rules |
| `test/routing.test.ts` | 11 | Routes against ADR-212, thinking parameters |
| `test/schema.test.ts` | 23 | Wire schemas, strict validation, error messages without values |
| `test/tasks.test.ts` | 69 | Tie-breaks, patch proposals and the allowlist, explanations, `runCall` paths |
| `test/transport.test.ts` | 19 | The real SDK behind a fake `fetch`: error mapping, timeouts, aborts, request ids |
| `test/untrusted.test.ts` | 42 | Sanitizing, scrubbing, link targets, delimiting, detection, linear time |

Malformed model output (non-JSON, wrong schema, extra text blocks, refusals, `max_tokens`,
context overflow, a throwing check) and prompt-injection attempts in merchant content (titles,
descriptions, link targets, theme comments, rendered excerpts, text inside images, invisible
and look-alike characters, forged delimiters) each have tests.

Gates run locally before each commit (Node 26.12.0, pnpm 12.14.0):

```
$ pnpm --filter @rampsmith/ai test
 Test Files  16 passed | 1 skipped (17)
      Tests  359 passed | 3 skipped (362)
AI live checks skipped: needs ANTHROPIC_API_KEY (LAUNCH.md section C, row 5)
$ pnpm --filter @rampsmith/ai typecheck          # tsc, exit 0, no output
$ pnpm exec eslint --max-warnings=0 .            # exit 0
$ pnpm exec prettier --check .                   # All matched files use Prettier code style!
$ pnpm knip                                      # exit 0
$ node packages/claims-lint/src/main.ts          # claims-lint: 14 files scanned, no banned claims
$ pnpm install --frozen-lockfile                 # Lockfile is up to date
```

The recorded evaluation run (`pnpm --filter @rampsmith/ai run eval`), on **authored**
recordings, so a test of the pipeline and the metrics, not a measurement of the model
(ADR-217):

```
# Alt-text evaluation (recorded, alt-text@2)
Dataset rampsmith-alt-text-eval v1: 20 images.
| Approvable unedited (proxy) | 90.0% (18/20) | ≥ 80% |
| Unsupported attributes | 0.0% | < 2% |
| Drafts naming a person | 0 | 0 |
| Escalated to Sonnet 5.5 | 25.0% | — |
| Failed calls | 0 | 0 |
| Mean attribute coverage | 92.5% | — |
| Cost per 1,000 images, synchronous | $0.8837 | — |
| Cost per 1,000 images, Batch API | $0.4421 | about $0.10 (PLAN §13) |
Gate: PASS
```

The cost lines come from the authored token counts and the set's deliberately hard cases (25%
escalated against an expected 10%), so they are not the production cost; ADR-212 puts Haiku
batch alt text at about $0.12 per 1,000 images plus about $0.27 per 10% escalated. The live
run measures both.

## CI (GitHub Actions, authoritative)

All on pull request #3; every job (`node`, `rust`, `contracts`, `e2e`, `images (api)`,
`images (engine)`, `images (egress)`, `images (web)`) green unless noted.

| Head | Change | Run | Result |
| --- | --- | --- | --- |
| 4b69b1a | merge of `r0-foundations` (lockfile regenerated with pnpm) | [39086889147](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39086889147) | success |
| a399158 | evaluation harness | [39087580526](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39087580526) | cancelled (superseded by the next push) |
| 0ef55cc | ADRs 211 to 217 | [39087805565](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39087805565) | success |
| aaf0533 | security audit fixes | [39090897450](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39090897450) | success |
| 922e5d5 | re-audit fixes | [39092351372](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39092351372) | success |

No CI failure outside this stream's paths was seen.

## Security audit

Two passes by the security-auditor subagent at effort max over the data handling, the
prompt-injection defences and the output validation, each with its own adversarial probes.

**First pass (at 0ef55cc): FAIL, 2 high, 5 medium, 12 low.** All fixed in aaf0533, with a
regression test per finding in `test/audit.test.ts`:

| Finding | Fix |
| --- | --- |
| HIGH-1 the patch denylist was bypassed with entities, case changes, split tokens and markup-building Liquid filters | Allowlist by comparison: `patchViolations` masks Liquid, checks each added or removed construct against an allowlist, parses the span before and after with parse5 and compares elements, attributes, parse errors and visible text; `patch-proposal@2` states the allowlist |
| HIGH-2 super-linear patterns and recursive analysis: one 84 KB description blocked the event loop | Every pattern bounded and linear; iterative analysis with `HTML_LIMITS`; over-limit input fails as `ai_input_invalid` before any reservation |
| MEDIUM-1 alt text allowed `'`, `\`, newlines and controls | Rejected; `alt-text@2` asks for `’` and one line |
| MEDIUM-2 no output was checked for hidden characters | Every output string checked (alt text, link text, patch replacements and summaries, explanations) |
| MEDIUM-3 relative link targets skipped sanitizing, scrubbing, caps and detection | `safeLinkTarget`: drops query, fragment and `;` parameters, replaces token-like segments, scrubs, caps at 200; detection reads the sent target |
| MEDIUM-4 SDK content capture and debug logs were controlled by environment variables | Transport sets `openTelemetry` metadata-only without propagation and `logLevel: 'off'`; a test sets both variables and finds no content |
| MEDIUM-5 `collectBatch` accepted another tenant's or edited content's rebuilt call | Tickets store each request's SHA-256; a mismatch is refused |
| LOW-1 detector ran on raw text | Runs on the NFKC-normalized text the model receives |
| LOW-2 twelve invisible characters survived | `\p{Cc}`, `\p{Cf}`, `\p{Cs}`, `\p{Default_Ignorable_Code_Point}` stripped and flagged |
| LOW-3 truncation before scrubbing, missed number and email forms | Scrub then cut (`untrustedField`); digits in any script, `/` and `_` separators, IBANs, non-ASCII and spelled-out emails |
| LOW-4 look-alike delimiters | NFKC folding plus escaping of look-alike angle brackets |
| LOW-5 output could carry a `claims-lint-allow` marker | Marker defanged before the scan |
| LOW-6 a citation crashed the tie-break check and was billed as retryable | Regex-free matching; a throwing check is permanent `ai_output_malformed` |
| LOW-7 half-open breaker admitted many probes | Turned-away callers no longer release the probe |
| LOW-8 ambiguous failures under-counted; batch creation retried after a timeout | Each ambiguous attempt charged at worst case; batch creation never retried after a timeout, cost kept |
| LOW-9 SDK pin younger than the release-age rule | Exception recorded in ADR-211 §4 |
| LOW-10 grapheme and depth limits leaked; `RangeError` on deep nesting | Graphemes capped at 12 code units; iterative bounded walk |
| LOW-11 images with EXIF, XMP or text chunks were accepted | Refused in JPEG, PNG, WebP and GIF |
| LOW-12 summaries and explanations accepted Markdown links | Links and URLs rejected; the web app renders both as plain text |

**Second pass (at aaf0533): FAIL, 1 high, 2 low,** all fixed in 922e5d5:

| Finding | Fix |
| --- | --- |
| HIGH-1 (new) markup inside an existing `<template>` was invisible to the comparison (parse5 keeps it in `content`) | Template content compared like any other markup, nested templates included |
| LOW-B GIF XMP, plain-text and application extensions not detected | GIF block walk; only the animation-loop and colour-profile application extensions are allowed; malformed files fail closed |
| LOW-C U+2800 (blank Braille cell) not counted as hidden | Added to the hidden set |

**Confirmation (at 922e5d5): PASS.** All findings verified fixed with the auditor's own probes;
more than 30 further patch vectors (foreign content, `noscript`, foster parenting, comments,
CDATA, raw-text elements, Liquid placeholders as names, duplicate attributes, `type` changes)
are blocked; the GIF walker terminates and fails closed; the spelled-email patterns run in
linear time on 1 MB. One note by design: a patch may add or remove `hidden` and `aria-hidden`
(allowlisted ARIA work), which changes what is shown without changing text content; the
developer review and the engine's preview cover it.

## ADRs

- [ADR-211](../adr/211-ai-package-split.md) the split: `packages/ai` holds the AI logic, the engine's ai worker calls it
- [ADR-212](../adr/212-claude-api-facts.md) Claude API facts read on platform.claude.com, with links, and the routes they set
- [ADR-213](../adr/213-prompts-outputs-and-untrusted-data.md) prompts, validated outputs and what may reach the model
- [ADR-214](../adr/214-ai-cost-accounting-and-budget.md) cost accounting and the per-store budget guard
- [ADR-215](../adr/215-ai-resilience-and-batches.md) retries, timeouts, the outage behaviour and the batch lifecycle
- [ADR-216](../adr/216-rewrites-as-span-edits.md) description rewrites as span edits
- [ADR-217](../adr/217-alt-text-evaluation-harness.md) the evaluation harness, its open image set and recordings

Each carries its PLAN correction in a "Plan correction" section; ADR numbers 218 and 219 are
unused.

## Integration notes (for the integrator and the main builder)

Shared files this stream did not touch, and what they need:

1. **`docs/adr/README.md`**: add rows for ADR-211 to ADR-217.
2. **`docs/PLAN.md`**: apply the "Plan correction" sections of ADR-211 to ADR-217.
3. **`claims-lint.config.json` (root)**: either add `packages/ai/prompts/**/*.txt` to `include`
   or keep the package's own config (`packages/ai/claims-lint.config.json`), which
   `test/prompts.test.ts` runs through the claims-lint CLI on every test run.
4. **`packages/claims-lint`**: `@rampsmith/ai` imports `@rampsmith/claims-lint/src/scan.ts`.
   If claims-lint gains an `exports` field, it must export `./src/scan.ts`.
5. **Root `package.json`, `pnpm-workspace.yaml`, `knip.json`, ESLint, `ci.yml`**: nothing
   needed. The workspace glob already picks up `packages/ai`, CI runs its tests through
   `pnpm -r`, and knip passes as is.
6. **Renovate**: the SDK pin qualifies under the 7-day rule from 2026-10-22; re-check the
   registry for advisories before merging (ADR-211 §4).

Work for the engine's ai worker (`packages/engine`, main builder; ADR-211 §2):

7. **Image preparation**: fetch through `egress`, resize with `sharp` to `planImageResize`
   (1008 px long edge), and strip all metadata (sharp's default; never call `withMetadata`).
   `validateImage` refuses images that still carry EXIF, XMP, IPTC, comments or text chunks.
   `sharp` needs an `allowBuilds` entry in `pnpm-workspace.yaml`.
8. **Rendered excerpts**: scrub names and review-widget content before they reach
   `prepareTieBreak` and `preparePatchProposal` (PLAN §9, §18); patterns here cannot find names.
9. **`BudgetLedger` on PostgreSQL**: a tenant-owned table through `TenantTx` and row-level
   security, keyed by tenant and period (`budgetPeriod`, `YYYY-MM` in UTC), with reservations
   (id, amount, state reserved/settled/released) and an atomic reserve that checks spent plus
   reserved against the limit. `InMemoryBudgetLedger` is the reference behaviour; its tests
   are the contract. One migration by the main builder.
10. **`ai_calls`**: one row per `AiCallRecord`: tenant, task, model, mode, prompt version,
    input, output, cache-write (5 m and 1 h) and cache-read tokens, thinking tokens, cost in
    micro-dollars, `cost_is_estimate`, batch id, request id, outcome, error code, attempts,
    duration, started at. No content columns.
11. **Entitlements**: `AiDeps.budgetLimit(tenantId)` returns the monthly limit in micro-dollars
    from the entitlements function and the merchant's own lower setting; proposed defaults in
    ADR-214 §3 (a pricing decision for the founder).
12. **Queue mapping**: `AiError.retryable` → `JobFailure.kind`; stop claiming `ai.*` jobs while
    `CircuitBreaker.pausedUntil()` is set; store `BatchTicket` in the job payload and rebuild
    each call from stored input before `collectBatch`.
13. **Web app**: render patch summaries and rule explanations as plain text, never Markdown;
    exclude results flagged `suspected_prompt_injection` or `human_edit_required` from bulk
    approval.
14. **After `--record`**: run `pnpm format`; recordings are written by `JSON.stringify` and
    Prettier may reflow them.

### Runbook: orphaned batches

A batch creation that timed out may still have created a batch (ADR-215). Its cost is already
counted. To find and delete it, with the production key:

```
curl -s https://api.anthropic.com/v1/messages/batches?limit=100 \
  -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01"
# for each batch whose id is not in any stored BatchTicket:
curl -s -X POST https://api.anthropic.com/v1/messages/batches/<id>/cancel ...   # if in progress
curl -s -X DELETE https://api.anthropic.com/v1/messages/batches/<id> ...        # once ended
```

Unclaimed batches expire within 24 hours, and their results are deleted after 29 days if not
deleted first.

## LAUNCH.md section E: live checks

Each needs input 5 in section C (`ANTHROPIC_API_KEY`, with a monthly spend limit). Each has a
substitute test passing in CI now, runs whenever the key is set, and otherwise skips with the
notice `AI live checks skipped: needs ANTHROPIC_API_KEY (LAUNCH.md section C, row 5)`.

| Live check | Inputs (C) | Substitute test now | Live command |
| --- | --- | --- | --- |
| One alt-text call on `claude-haiku-5-5` end to end: schema-valid answer, real usage, a cost above zero, a `req_` request id (`test/live.test.ts`) | 5 | `test/alt-text.test.ts` and `test/transport.test.ts` on recorded responses and a fake `fetch` behind the real SDK | `ANTHROPIC_API_KEY=… pnpm --filter @rampsmith/ai test test/live.test.ts` |
| The evaluation gate on the live model over the bundled set: no failed calls, approvable ≥ 80%, unsupported < 2%, no named person (`test/live.test.ts`) | 5 | `test/eval.test.ts` and `pnpm --filter @rampsmith/ai run eval` on recordings | same command |
| The full report with the Sonnet 5.5 grader, measured prompt size and cost per 1,000 images | 5 | `pnpm --filter @rampsmith/ai run eval` on recordings | `ANTHROPIC_API_KEY=… pnpm --filter @rampsmith/ai run eval --live` |
| Replace the authored recordings with captured responses | 5 | the authored recordings | `ANTHROPIC_API_KEY=… pnpm --filter @rampsmith/ai run eval --live --record`, then `pnpm format` |

Without the key, `test/live.test.ts` reports 3 skipped tests (the two checks and a placeholder
whose name carries the notice) and prints the notice, as a GitHub Actions `::notice` in CI.

The R1 measure "at least 80% of alt-text drafts approved unedited" (LAUNCH.md section E, R1
row) is computed in production by `approvedUneditedRate` from review events.
