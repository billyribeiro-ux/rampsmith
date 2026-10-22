# ADR-090: The `ai.alt_text@1` job and `sharp`

- Status: Accepted
- Date: 2026-10-22
- Builds on: ADR-011 (model routing), ADR-035, ADR-036, ADR-211 to ADR-217 (`packages/ai`)
- Lane: R1 lane C (`packages/engine/src/jobs/alt-text.ts`, `src/ai/`)

## Context

The R1 exit criterion asks for AI-drafted alt text with approve, edit and undo, and for at least
80% of drafts approved unedited. `packages/ai` (ADR-211 to ADR-217) already holds the prompt,
the routing (Haiku 5.5, Sonnet 5.5 on escalation), the output checks and the budget guard. The
engine has to feed it: fetch the image, shrink it, keep the budget on PostgreSQL, and store the
result where the api and the App Home read it.

## Decision

1. **One job per image.** `ai.alt_text@1` (payload in `crates/contracts`) names the site, the
   finding, the `scan_inputs` row and the media GID. The handler runs three steps and keeps no
   transaction open across the network: (a) read the finding, the stored product data and the
   site's settings in one tenant transaction; (b) download the image, resize it and call the
   model; (c) store the draft in a second tenant transaction that locks the finding row, so two
   racing jobs make one fix.
2. **The image goes through egress** (ADR-025, ADR-035). The engine signs a scan token for the one
   host in the URL, opens a `CONNECT` tunnel through egress and runs TLS end to end inside it.
   Only `cdn.shopify.com` is accepted, over https on port 443, without credentials; a redirect is
   a failure. The download is capped at 25 MiB.
3. **`sharp` 0.35.5 prepares the image** (Apache-2.0, checked on the registry on 2026-10-22; the
   release is from 2026-09-27). Decoding allows JPEG, PNG, WebP, GIF, AVIF, HEIF and TIFF only,
   refuses images over 100 megapixels, turns the image to its display orientation, shrinks it to
   the 1008 px long edge without enlarging, and writes JPEG (PNG when it has transparency) with
   no metadata, so EXIF, XMP, IPTC and comments never reach the model. The first frame of an
   animation is kept. `@rampsmith/ai`'s `validateImage` checks the result again and refuses any
   metadata that is left.
4. **`sharp` needs no `allowBuilds` entry.** Its `package.json` has no `install`, `preinstall` or
   `postinstall` script; the native code arrives as the prebuilt optional packages `@img/sharp-*`
   (libvips 1.3.4), which pnpm 12 installs without running anything. `pnpm install` on pnpm 12.14.0
   finished without asking for a decision, and the engine image (glibc, linux/x64) takes the
   `@img/sharp-linux-x64` build. `pnpm-workspace.yaml` is unchanged.
5. **The budget is PostgreSQL** (`ai_budgets`, `ai_reservations`): `PostgresBudgetLedger` reserves
   the worst case with one conditional `UPDATE`, so concurrent engines cannot overspend, and
   settles at the cost from `usage`. `ai_calls` receives one metadata row per model call (never
   the prompt, the image or the answer). The limit is the site's `settings.ai_budget_micro_usd`
   when set, else $0.50 (ADR-214's proposed Free limit). The api clamps what a merchant may set to
   the plan's entitlement; the engine has no plan state yet, which the integration PR wires.
6. **What is stored.** A draft that passes the PLAN §13 checks becomes a `fixes` row
   (`kind` data, `channel` admin_api, `status` proposed, `origin` ai, model, prompt version,
   confidence), a `fix_findings` link and a `data_fix_snapshots` row (`field` `alt`, the alt text
   the image has now or JSON `null`, the draft). The diff is
   `{ type: "alt_text", resource_gid, field: "alt", before, after, language, contains_text,
   escalated }`. Lane A's approve, edit and undo read and write exactly these. A draft that fails
   the checks stores nothing: the finding stays open and the merchant writes the text by hand. A
   finding that already has any fix (also a rejected or reverted one) is not drafted again.
7. **Failures.** `AiError.retryable` maps to the queue's `retryable` or `permanent`. A missing
   `ANTHROPIC_API_KEY` is the permanent `ai_not_configured` naming LAUNCH.md section C, row 5, so
   scans continue and no draft appears until the input exists. An exhausted budget is the
   permanent `ai_budget_exhausted`, and nothing is charged.
8. **Shape of the stored product data** (`scan_inputs.kind = 'products'`) that `shopify.read_store`
   must write, read leniently (lists or GraphQL connections): `{ products: [{ id, title,
   productType, media: [{ id, alt, image: { url } }] }] }`. The shop's primary locale comes from
   the `shop` input's `primaryLocale` and is `en` when absent.
9. **Synchronous calls.** Each job makes a synchronous call (`interactive: true` route), costed as
   such. The Batch API path in `packages/ai` stays available for bulk drafting; with a draft
   costing about $0.0001 (PLAN §13) the saving is small against the extra moving parts.

## Consequences

- Test evidence now: `packages/engine/test/ai/` (41 tests: image preparation, the egress
  download through a real TLS session, the PostgreSQL ledger including concurrency and tenant
  isolation, and the job with replayed responses in the documented Messages API shape). The live
  call is `test/ai/live.test.ts`, which skips with a notice naming LAUNCH.md section C, row 5.
- Lane A reads the diff and snapshot shapes above; lane A's `shopify.read_store` writes the
  product shape above. A change on either side is an ADR.

## Rejected alternatives

- Downloading images from the engine directly: a merchant-controlled URL would reach the network
  without egress's address checks.
- Resizing in the browser or in Rust: `sharp` is the plan's choice (PLAN §13), and the engine is
  where `packages/ai` runs.
- One transaction around the whole job: it would hold a connection for the length of a model call.
