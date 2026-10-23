# ADR-099: Image loaders are allow-listed; the media route is limited; the preview loads once

- Status: Accepted
- Date: 2026-10-22
- Builds on: ADR-090, ADR-092
- Lane: R1 lane C security audit, findings L1, L4, L6

## Decision

1. **libvips loaders (L1).** `sharp` sniffs the bytes and runs whichever libvips loader matches
   before the format list is looked at, so an SVG, TIFF or ImageMagick parser could read a
   download before it was refused. `image.ts` now blocks every `VipsForeignLoad` operation and
   unblocks only the buffer loaders for JPEG, PNG, WebP, GIF (`Nsgif`) and AVIF/HEIC (`Heif`). The
   names were checked against the libvips bundled with `sharp@0.35.5`, and a test decodes one
   image of each allowed format and shows that `sharp` cannot even read the metadata of an SVG or
   a TIFF. TIFF leaves the format list, and the pixel limit falls from 100 to 25 megapixels
   (Shopify accepts product images up to 20).
2. **The media route (L4).** Every early return in `fetchMedia` cancels the response body; a
   download cut off mid-stream is cancelled and answered 502. The route counts each request
   against the session token (240 a minute) and the visitor's address (600 a minute), kept in
   separate tables so a flood of made-up tokens cannot evict an address, and caps fetches in
   flight at 8 per token and 32 in all; refusals are 429 with `Retry-After`. `ADDRESS_HEADER` and
   `XFF_DEPTH` must be set in production for the address key to mean anything (ADR-042); without
   an address the token limit and the global cap still apply. `export.server.ts` also closes the
   bodies it does not read.
3. **The statement preview (L6).** It no longer pages through every open finding on each
   preview. The list is cached per shop for as long as the api's overview is unchanged (the key is
   the shop domain the api returned for the visitor's token, the latest scan, the counts a fix
   moves) and at most five minutes, and pages are 100 long instead of 25. The body-size check
   counts bytes (`TextEncoder`), after a check of `Content-Length`.

## Consequences

An image the loaders do not read is `image_unreadable`, a permanent failure with a fixed message.
A merchant with a very large catalogue sees thumbnails load in the rate limit's pace after a
burst, never an error page.
