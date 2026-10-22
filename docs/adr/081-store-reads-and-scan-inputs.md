# ADR-081: Store reads, and what `scan_inputs` holds

- Status: Accepted
- Date: 2026-10-22
- Refines: PLAN §10, §11, §15; ADR-035, ADR-037

## Context

The engine audits store data (alt text, descriptions, page bodies, menus) without a Shopify token
(ADR-035). `ctl` reads the store and hands it over through `scan_inputs`. The engine's parser
(`packages/engine/src/pipeline/snapshot.ts`) fixes the spelling it accepts.

## Decision

`shopify.read_store@1` reads, in this order, the shop (primary domain, locales, live theme),
products (20 to a page, their image media, at most 50 pages), collections, pages, articles and
menus (at most 25 pages each, 40 to a page except menus), through the cost-aware client of
ADR-080. Nothing is stored until every read succeeded; then one transaction writes:

- one `scan_inputs` row per Admin page, `kind` one of `products`, `collections`, `pages`,
  `articles`, `menus`, `seq` from 0, payload `{"items": [...]}`, and one `audit.data@1` job for it
  (idempotency key `audit.data:<input id>`);
- one `shop` row with the primary domain, locales (`locale`, `primary`, `published`), the live
  theme and a `read` summary with item and batch counts and a `truncated` flag per kind;
- one `scan.plan@1` job (key `scan.plan:<scan id>`);
- the shop's `primary_domain` and `locales`.

A retry repeats the whole read. Storing the same `(scan, kind, seq)` again replaces the payload and
keeps the row id, so no row and no job is doubled. A rejected grant, a missing shop or scan, and a
revoked grant fail the job permanently and set the scan `failed` with the code; an outage retries
and leaves the scan `queued`.

Item shapes (snake_case; ids are GIDs):

| Kind | Item members |
| --- | --- |
| `products` | `id`, `handle`, `title`, `status`, `template_suffix`, `description_html`, `media_truncated`, `media[]` of `id`, `alt` (null when unset), `status`, `url`, `file_name` |
| `collections` | `id`, `handle`, `title`, `template_suffix`, `description_html` |
| `pages` | `id`, `handle`, `title`, `template_suffix`, `is_published`, `body` |
| `articles` | `id`, `handle`, `blog_handle`, `title`, `template_suffix`, `is_published`, `body` |
| `menus` | `id`, `handle`, `title`, `items[]` of `id`, `title`, `url`, `type`, `items[]` |

Only image media are listed: a video or a 3D model has no alt text to check. `file_name` is the last
segment of the image URL, which the engine compares with the alt text (`rs-media-alt-filename`).
The payload holds ids, titles, text and URLs only, never a token, a header or customer data.

## Consequences

- Stores above 1,000 products are audited on the first 1,000 (in id order) in R1 and say so in the
  `read` summary; raising the cap needs a per-plan limit from billing and a longer job lease.
- Plan-based sampling (`sampling` on the `shop` row) is not written yet; the engine's default
  applies until entitlements feed it (ADR-084).
