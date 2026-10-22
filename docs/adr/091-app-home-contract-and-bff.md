# ADR-091: The App Home contract and its backend-for-frontend routes

- Status: Accepted
- Date: 2026-10-22
- Builds on: ADR-005 (SvelteKit BFF), ADR-022 (session tokens), ADR-054 (content security policy)
- Lane: R1 lane C (`apps/web/src/routes/app/**`, `apps/web/src/lib/app/**`)

## Context

Phase 0 declared the api's `/v1/shopify/` operation ids but not their bodies; they answer 503
until lane A fills them in. The App Home has to be written, tested and merged in parallel with
that work, and it has to run inside an iframe whose page policy allows `connect-src 'self'` only.

## Decision

1. **A written view-model contract.** `src/lib/app/types.ts` is the shape the App Home expects
   from each operation: `Overview`, `FindingList`, `FindingDetail`, `FixList`/`FixSummary`
   (with the `AltTextChange` diff of ADR-090), `Settings`, `StatementState`. Names follow the
   database vocabulary (PLAN §9) and `billing::Entitlements`. Lane A's handlers return these
   shapes; where they differ, the difference is fixed in `types.ts` and `api.ts`, not in pages.
   The contract also fixes these points lane A must honour:
   - `GET fixes?state=queue|applied|all` (`queue` is proposed, approved, applying and failed);
   - `GET findings?impact&status&origin&criterion&has_fix&cursor`;
   - `PUT fixes/{id}` with `{alt}` edits a proposed fix; `POST fixes/{id}/approve|reject|undo`;
   - `PUT settings` takes `weekly_rescan`, `notification_email`, `alt_text_max_characters`,
     `ai_budget_micro_usd`, `storefront_password` (null clears it) and answers the full `Settings`;
   - `ScanSummary.coverage` and `ruleset_version` carry the coverage disclosure (ADR-225), which
     the statement preview needs.
2. **One allowlisted proxy.** `/app/api/shopify/[...path]` forwards to `${API_URL}/v1/shopify/…`.
   `src/lib/app/proxy.server.ts` holds the table: each route has its methods and the query
   parameters it passes, with values limited to a safe character set. Anything else is 404 or
   405 before the api is called. A bearer token is required (401 with the retry header, so
   App Bridge issues a fresh token), bodies are limited to 64 KiB, the answer is `no-store`, and
   the W3C trace context is injected so the api's spans join the request's trace.
3. **Reports are made in the BFF.** `/app/api/log-export` and `/app/api/statement-preview` map
   the contract onto `@rampsmith/reports` (`remediationLogCsv`/`Json`, `renderStatement`) in
   `reports.server.ts`, so exports and previews come from the same code as the stored reports
   and say what that code says about coverage. The preview returns 422 `validation_failed` with
   the field name only when the renderer refuses an entry.
4. **Session tokens, not cookies.** Every call is made with `sessionFetch`, which sends a fresh
   App Bridge token and repeats once on the retry header (ADR-022). No state lives in the BFF.
5. **Server-side criterion names.** `+layout.server.ts` reads WCAG 2.2 criterion names from
   `@rampsmith/reports`; the client never bundles the table.
6. **In-app links do not carry `shop`/`host`.** The `svelte/no-navigation-without-resolve`
   rule accepts only `resolve()` hrefs. Client-side navigation keeps App Bridge alive, and the
   admin adds its own launch parameters when it reloads the frame, so pages link with
   `resolve('/app/…')`. `s-app-nav` links still carry them.

## Consequences

Lane A can implement against a fixed list. A mismatch shows up as a typed compile error in
`api.ts` or a failing test, not as a runtime surprise. The proxy is one more place a new
operation must be listed, which is the point.
