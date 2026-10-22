# ADR-083: The embedded app's api operations

- Status: Accepted
- Date: 2026-10-22
- Refines: PLAN §5 (R1), §13, §14; ADR-038, ADR-091 (the App Home's types)

## Decision

The 15 `/v1/shopify/*` operations that Phase 0 declared as stubs answer for real. Each handler opens
one tenant transaction for the session's shop (row-level security), looks up the shop's site, and
filters every query by that site as well. An id that belongs to another shop is a 404, the same as
one that does not exist.

- **Overview.** Entitlements (below), the newest scan that is not a verification of one fix, open
  findings by impact (best practices are not counted), fixes awaiting approval, fixes applied and
  the time of the first one. `next_scan_at` is the latest scan plus 7 days when the merchant turned
  weekly rescans on, else null. The shop's name is null: the Admin read stores no name.
- **Scans.** `POST` is 202 with the queued scan and a `shopify.read_store` job in the same
  transaction (key `shopify.read_store:<scan>`); 409 while a scan is queued or running and was
  queued within the last hour (an older one is a crashed run and does not block). The scan's
  `ruleset_version` reads `axe-core <version>` from the coverage document the engine writes at the
  end, else the stored column. `coverage.automated` is `criteria_tested`; `partial` is empty until
  the engine records partly tested criteria; `review_queue` passes through.
- **Findings.** Filters `impact`, `status`, `origin`, `criterion`, `has_fix`; ordered by
  `priority_score` descending (nulls last), then id. The cursor is an opaque-looking offset
  (`next_cursor` is the next offset, or null). An unknown filter value or cursor is 422 with the
  field named. The detail adds the rule's explanation, up to 50 occurrences, the distinct page types
  (`templates`), before/after evidence ids from the finding's fixes, and the fixes.
- **Rule text.** `rules.rs` mirrors the 19 `rs-*` summaries of `packages/a11y-rules`; a unit test
  fails when the TypeScript catalog gains or loses a rule. An axe-core rule gets a generic sentence.
- **Fixes.** `state` is `queue` (proposed, approved, applying, failed), `applied` (applied,
  verified) or `all`. `change` comes from `fixes.diff`; `product_title` and `image_url` from the
  site's latest read of the store (`scan_inputs` kind `products`, found by the finding's owner GID
  and the diff's image GID). Shopify gives the app no staff names, so `approver_name` is null.
- **Edit** (`PUT`): only while `proposed`; alt text is trimmed, non-empty and at most the shop's
  `alt_text_max_characters`; sets `edited`, `diff.after` and the snapshot's `after_value` together,
  so what is applied is what the merchant reviewed. 409 once decided.
- **Approve:** needs a staff `sub` (403 without); the plan's image-fix allowance must cover one
  more image (Free: the first 25; counted over approved, applying, applied and verified fixes);
  `approve_by_ref`, the `shopify.apply_data_fix` job (key `shopify.apply_data_fix:<fix>`) and the
  audit entry `fix.approved` (actor kind `user`, the staff `sub`) share one transaction. 409 if
  already decided.
- **Reject:** `proposed` to `rejected`, audited; 409 otherwise.
- **Undo:** only `applied` or `verified`, 202. Queues `shopify.revert_data_fix` (key includes the
  second, so a retry after a refused undo is possible) unless one is ready or running (409). The
  response shows the fix as it is; the job moves it to `reverted`.
- **Evidence:** the stored bytes with their type, `nosniff`, `private, no-store` and
  `Content-Security-Policy: default-src 'none'; sandbox`.
- **Settings** live in `sites.settings`: `weekly_rescan` (403 on a plan whose render cadence is
  monthly), `notification_email` (shape-checked, `""` or null clears), `alt_text_max_characters`
  (40 to 300, default 150), `ai_budget_micro_usd` (0 up to the plan's ceiling, default the
  ceiling). Invalid values are 422 with every bad field named, and nothing is saved. The storefront
  password is sealed with the master key under context `sites/storefront_password/<site id>`, never
  returned (`storefront_password_set` only), cleared by `null`, and 503 when the api has no keys.
  The audit entry records that it was set or cleared, never the value.
- **Statement:** `PUT` updates the open draft in place, else adds `max(version) + 1`; sizes and
  the address and https form URL are validated; `GET` returns the draft and every version.
- Request bodies reject unknown members and answer problem+json like every other error.

## Consequences

- The 15 operations are in `openapi/api.json` and `api.ts` with real request and response schemas.
- `getEvidence` serves any stored image to its own shop; the screenshots are scrubbed at capture
  (ADR-051).
- No operation publishes a statement or reads the statement's rendered page; publishing is R2.
