# Spike S-2: bot-challenge rate for headless Chromium on Shopify storefronts

- Date: 2026-10-17
- Question (PLAN §11, risk table §25): how often does a public Shopify store answer headless
  Chromium with a bot challenge? Above 5% of stores, the headed-browser fallback is needed.
- Status: answered. **0 of 50 stores challenged.** The run also showed that the engine's
  challenge detector was wrong for 70% of stores; it is fixed (ADR-027).

## Method

- [Run 39076633535](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39076633535), job
  `s2`, at commit 67e1485 (merge ref 4aaf177), from a GitHub-hosted `ubuntu-24.04` runner (Azure, westus2).
- Script: `packages/engine/spikes/s2-challenges.ts`; candidates: `packages/engine/spikes/stores.txt`.
- Headless Chromium 156.0.8078.4 (Playwright 1.64.1), 1280×800, user agent
  `RampsmithBot/spike-4aaf177 (+…/docs/bot.md; accessibility scanner)`.
- Inside the free scanner's limits (PLAN §16, docs/bot.md): one `robots.txt` fetch per
  candidate; a candidate counted only when `robots.txt` or the response headers confirmed
  Shopify; robots.txt honoured for `RampsmithBot`; one home-page load per store, one store at a
  time with a one-second pause; no retries; nothing solved or evaded.
- Each page recorded its HTTP status, final host, the `cf-mitigated` header, Cloudflare
  challenge title and markup, reCAPTCHA, hCaptcha and Turnstile markup, a `/challenge` path,
  a `/password` path, Shopify section markup and HTTP 429. Accessibility results are kept only
  as aggregates: Rampsmith does not publish anyone's failures (PLAN §16).

## Results

| Measure | Value |
| --- | --- |
| Candidates tried | 56 |
| Confirmed Shopify (46 by `x-shopid`/`powered-by` headers, 4 by robots.txt comment) | 50 |
| Not confirmed: robots.txt and headers did not say Shopify | 5 |
| Not confirmed: robots.txt answered 429 (not loaded) | 1 |
| Home pages disallowed by robots.txt | 0 |
| Home pages loaded | 50, all HTTP 200 |
| `cf-mitigated: challenge`, Cloudflare title or `cf-chl` markup | 0 |
| Turnstile, `/challenge` path, `/password` path, HTTP 429 | 0 |
| **True challenges** | **0 of 50 (0%)** |
| Pages with hCaptcha markup (all of them with Shopify section markup) | 39 |
| Pages with reCAPTCHA markup | 0 |
| Flagged as `captcha` by the detector in use at the time | 35 (70%) |
| Load-to-settled duration p50 / p95 / max | 7.8 s / 13.6 s / 14.1 s |

One store's home page redirected to an unrelated host; the spike now aborts any top-level
navigation that leaves the store, as egress does in the product.

Aggregate axe results for the 15 stores the old detector let through (WCAG 2.2 A/AA tags):
median 16 failing elements per home page, p95 153. Rules failing on the most stores:
`label-content-name-mismatch` and `target-size` (7 each), `color-contrast` (6), `link-name` (5),
`image-alt` (4).

## Decisions

1. No headed-browser fallback for R1: the measured rate (0%) is far below the 5% threshold.
   The rate comes from a GitHub Actions address; production scans leave from Railway through
   egress, so the blocked-scan rate becomes a production metric with the same 5% alert.
2. The detector no longer treats CAPTCHA markup as a challenge on its own. Shopify loads
   hCaptcha for storefront forms on most stores, so only a page that is nothing but a CAPTCHA
   (fewer than five links and no Shopify sections), Shopify's `/challenge` page, a Cloudflare
   challenge (header, title or `cf-chl` markup) or HTTP 429 counts (ADR-027). Replayed on the
   recorded signals, the new detector flags 0 of 50 stores.
3. A `robots.txt` answering 429 now means "do not load", not "no rules" (RFC 9309 leaves 429 to
   the crawler; treating it as unreachable is the cautious reading).
4. The load-and-settle p95 of 13.6 s fits PLAN §11's 20-second budget per page-state.

## Still to observe

A rerun with the fixed detector, at least 24 hours after this run so no store is loaded twice
in a day, confirms the detector on live pages: label `run-spike-s2` on the pull request.
