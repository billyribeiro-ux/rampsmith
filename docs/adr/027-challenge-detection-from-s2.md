# ADR-027: Challenge detection calibrated by spike S-2

- Status: Accepted
- Date: 2026-10-17

## Context

PLAN §11 and §3: a bot challenge is reported as blocked and never solved or evaded. ADR-025's
first detector treated any reCAPTCHA, hCaptcha or Turnstile markup as a challenge. Spike S-2
(docs/spikes/S-2-bot-challenges.md) loaded 50 Shopify home pages: none was challenged, but 39
contained hCaptcha markup because Shopify protects storefront forms with it, and the detector
reported 35 of them as blocked. Every one of those 39 pages also had Shopify section markup and
dozens of links. S-1 saw the same on Dawn's demo store.

## Decision

A page is a challenge when any of these holds, checked in this order:

1. **Cloudflare:** the main document has `cf-mitigated: challenge`, the title starts with
   "Just a moment" or "Attention Required! | Cloudflare", or the markup contains `_cf_chl_opt`
   or `cf-chl-` **on a page with fewer than five links and no Shopify sections** (amended
   2026-10-18: the S-2 rerun found a storefront embedding Turnstile, whose widget ids start with
   `cf-chl-`).
2. **Shopify's challenge page:** the final URL's path is `/challenge`.
3. **A CAPTCHA interstitial:** CAPTCHA markup is present **and** the page has fewer than five
   links **and** no Shopify sections.
4. **Rate limited:** HTTP 429.

The detector reads the full document, its final URL and its response headers.

## Consequences

- Storefronts that use a CAPTCHA or Turnstile only for their forms are scanned; both S-2 runs'
  recorded signals give 0 of 50 flagged.
- A real CAPTCHA wall on a page with many links would be missed and scanned; the axe results
  would then describe the wall, not the store. The blocked-scan metric in production and the
  S-2 rerun watch for this.
- A `robots.txt` that answers 429 is treated as "do not load".

## Rejected alternatives

- Any CAPTCHA markup means blocked: measured 70% false positives.
- Matching vendor-specific challenge pages only: a CAPTCHA interstitial from another vendor
  would then be scanned as if it were the store.
