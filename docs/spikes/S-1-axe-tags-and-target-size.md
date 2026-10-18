# Spike S-1: the axe-core 4.14 tag set and `target-size` on Dawn

- Date: 2026-10-17
- Question (PLAN §11): which rules does axe-core 4.14 run for the WCAG 2.2 AA tag set, and how
  does `target-size` (2.5.8 Target Size (Minimum)) behave on Shopify's Dawn theme?
- Status: tag set **answered**; Dawn measurement **pending a rerun** (see below).

## Evidence

[Run 39076633535](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39076633535), job
`s1`, commit 67e1485 (merge ref 4aaf177); script `packages/engine/spikes/s1-dawn.ts`.

### Tag set

`axe.getRules()` in axe-core 4.14.0 lists 105 rules. The engine's tags `wcag2a, wcag2aa,
wcag21a, wcag21aa, wcag22aa` select 70 of them: 62 `wcag2a`, 3 `wcag2aa` (`color-contrast`,
`meta-viewport`, `valid-lang`), 1 `wcag21a` (`label-content-name-mismatch`), 3 `wcag21aa`
(`autocomplete-valid`, `avoid-inline-spacing`, `css-orientation-lock`) and 1 `wcag22aa`
(`target-size`). Best-practice and AAA rules are not selected, as PLAN §11 requires.

`target-size` carries the tags `wcag22aa` and `wcag258` and `enabled: false`: axe skips it in a
default run. A tag-based `runOnly` includes it regardless, which the engine's browser test
`runs target-size (2.5.8), which axe-core disables by default, through the tag set (S-1)`
proves on a fixture with two adjacent 16-pixel buttons (both reported against 2.5.8). S-2's
aggregate shows the rule firing on 7 of 15 real storefront home pages.

### Dawn

The theme store's preview page links the demo store `theme-dawn-demo.myshopify.com`; its
robots.txt allows `/` for `RampsmithBot`. The spike loaded the home page, the `bags` collection
and one product at 390×844; all three answered HTTP 200. All three were classified as `captcha`
by the detector in use at the time, because Dawn loads hCaptcha for its forms, so axe did not
run. S-2 found the same false positive on 35 of 50 stores; ADR-027 fixes the detector.

## Decisions

1. The tag set stays as PLAN §11 defines it; nothing needs adding to reach 2.5.8.
2. Because `target-size` is disabled by default, the engine must always scan with a tag-based
   `runOnly`, never a default run; the fixture test guards this.

## Still to observe

Dawn's `target-size` results, with the fixed detector, at least 24 hours after the first load:
label `run-spike-s1` on the pull request and record which elements fail, pass or are
incomplete.
