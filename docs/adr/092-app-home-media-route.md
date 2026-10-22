# ADR-092: Product images reach the App Home through the BFF

- Status: Accepted
- Date: 2026-10-22
- Builds on: ADR-054, ADR-091
- Lane: R1 lane C (`apps/web/src/routes/app/api/media`, `src/lib/app/media.server.ts`)

## Context

The alt-text review card shows the product image beside the draft. The page policy is
`img-src 'self' data: https://cdn.shopify.com/shopifycloud/`, and product images live at
`https://cdn.shopify.com/s/files/…`, a path that also serves files merchants and attackers
upload, so widening `img-src` or `script-src` to it is wrong (ADR-054).

## Decision

`GET /app/api/media?u=<cdn url>` fetches the image on the server and returns the bytes; the
browser turns them into a `data:` URL, which the policy already allows.
- The caller must be signed in: a bearer token the api accepts (`overview` is called, and a
  positive answer is remembered for 30 seconds per token hash, at most 500 entries).
- The address is checked and rebuilt, never forwarded: https, host exactly `cdn.shopify.com`, no
  port or credentials, path under `/s/files/`; only a numeric `v` and a `width` of 240 are sent.
- No redirects; 10 s timeout; 5 MiB cap, declared and streamed; only JPEG, PNG, WebP, GIF and
  AVIF content types come back (never SVG or HTML); `nosniff` and `no-store`.

## Consequences

The policy stays as pinned in `tests/csp.ts`. Each thumbnail costs one CDN round trip through
the app server. When a card's image fails, it shows a text placeholder and the card still works.
