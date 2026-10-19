# ADR-226: Executive summary: the pass rate, accessible charts and data tables

- Status: Accepted
- Date: 2026-10-18
- Stream: WS-13 (reports and statement generator)

## Context

PLAN §16: "Executive summary: automated pass rate over time, open findings by impact, coverage
disclosure." The claims policy's own phrasing is "Passes N of M automated WCAG 2.2 AA checks"
(PLAN §3). The summary is printed to PDF (ADR-223), so its charts must be accessible in HTML and
in the tagged PDF. CLAUDE.md requires icons from `phosphor-svelte`; charts are data graphics,
not icons, and this package renders HTML strings, not Svelte.

## Decision

1. **Pass rate**: checks passed divided by checks run in one scan. A check is one automated rule
   for WCAG 2.2 Level A or AA tested on one page in one state; results waiting for review are
   not counted. The summary prints "passed N of M automated WCAG 2.2 Level AA checks (R%)" and
   says how the rate is computed. A scan with results ran at least one check (input refused
   otherwise). Up to 400 scans are plotted, in date order whatever the input order.
2. **Charts** are inline SVG drawn by the package: a line chart of pass rate per scan on a fixed
   0–100% axis (no truncated axis that exaggerates change), and horizontal bars of open findings
   by impact, each bar labelled with its impact and count. Each chart is a `<figure>` whose SVG
   has `role="img"` and `aria-labelledby` pointing at the visible caption and a visible text
   summary (first and last rate, low and high; or the four counts), followed by a `<table>` with
   a caption, column and row headers and the same numbers. No information is in colour alone.
   Chromium tags each chart as a Figure whose `/Alt` is that name (verified with `pdfjs-dist`).
3. **Palette**: text `#1b1b1b`, muted `#4a4a4a` and accent `#0b4f8a` reach at least 4.5:1 on white;
   chart rules `#767676` and the impact colours (`#9b1c1c`, `#a3470d`, `#6b5300`, `#3d4f63`)
   reach at least 3:1 (SC 1.4.11). A test computes each ratio with the WCAG formula. Styling is
   by class from the one hashed style sheet, never by `style` attributes.
4. Inputs: the scans with results, open findings from the latest scan by impact, optional
   period and fix counts (verified, waiting for approval), and the coverage disclosure.

## Plan correction

- PLAN §16 "Reports", executive summary bullet, append: "Pass rate = checks passed / checks run
  per scan, where a check is one WCAG A or AA rule on one page state and review-queue results
  are excluded; each chart has a text summary and a data table (ADR-226)."
- PLAN §9 `scans`: the summary and the statement need `checks_run` and `checks_passed` per
  scan. Neither column exists; the main builder adds them (expand-only migration) when the
  engine records results, or derives them from stored results.

## Consequences

- The charts need no chart library and no script, and print identically in every browser.
- The fixed 0–100% axis makes a change from 94% to 96% look small; the table and the summary
  carry the exact figures.

## Rejected alternatives

- A chart library (Chart.js, Vega): needs JavaScript in the page, which the print forbids
  (ADR-223).
- Charts as images: no text inside, and a request or a data URL the policy refuses.
