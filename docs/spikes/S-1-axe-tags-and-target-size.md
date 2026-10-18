# Spike S-1: the axe-core 4.14 tag set and `target-size` on Dawn

- Date: 2026-10-17
- Question (PLAN §11): which rules does axe-core 4.14 run for the WCAG 2.2 AA tag set, and how
  does `target-size` (2.5.8 Target Size (Minimum)) behave on Shopify's Dawn theme?
- Status: **answered.** The tag set selects 70 rules and runs 64; `target-size` runs and Dawn
  passes it on every page checked (rerun of 18 October).

## Evidence

[Run 39076633535](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39076633535), job
`s1`, commit 67e1485 (merge ref 4aaf177); script `packages/engine/spikes/s1-dawn.ts`.

### Tag set

`axe.getRules()` in axe-core 4.14.0 lists 105 rules. The engine's tags `wcag2a, wcag2aa,
wcag21a, wcag21aa, wcag22aa` select 70 of them: 62 `wcag2a`, 3 `wcag2aa` (`color-contrast`,
`meta-viewport`, `valid-lang`), 1 `wcag21a` (`label-content-name-mismatch`), 3 `wcag21aa`
(`autocomplete-valid`, `avoid-inline-spacing`, `css-orientation-lock`) and 1 `wcag22aa`
(`target-size`). Best-practice and AAA rules are not selected, as PLAN §11 requires.

Of the 70, axe runs 64: its default `tagExclude` drops the two rules tagged `deprecated`
(`aria-roledescription`, `audio-caption`) and the four tagged `experimental`
(`css-orientation-lock`, `p-as-heading`, `table-fake-caption`, `td-has-header`). Checked by
listing every rule id in a tag-set run's passes, violations, incomplete and inapplicable
results (64 on each Dawn page, and the same 64 on a local fixture).

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

### Dawn, rerun

[Run 39175521308](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39175521308), job
`s1`, on 18 October at 23:13 UTC (more than 24 hours after the first load), commit 4fdfb3b,
with the ADR-027 detector. Same three pages at 390×844, all HTTP 200, none classified as a
challenge, 64 rules run on each.

| Page | `target-size` passes | violations | incomplete | Load to results |
| --- | --- | --- | --- | --- |
| Home | 33 elements | 0 | 0 | 6.1 s |
| `/collections/bags` | 39 elements | 0 | 0 | 6.1 s |
| One product | 57 elements | 0 | 0 | 5.9 s |

The demo store's Dawn controls meet 2.5.8 at a phone viewport, and axe decides every one of them: none
lands in `incomplete`, so 2.5.8 findings on Dawn-based themes will come from merchant
customisations, not the base theme.

## Decisions

1. The tag set stays as PLAN §11 defines it; nothing needs adding to reach 2.5.8.
2. Because `target-size` is disabled by default, the engine must always scan with a tag-based
   `runOnly`, never a default run; the fixture test guards this.
3. axe's default exclusion of deprecated and experimental rules stays: an experimental rule is
   not reliable enough to count as a failure (PLAN §11 step 4). The two excluded table rules
   sit beside `th-has-data-cells` and `td-headers-attr`, which do run; what
   `p-as-heading` and `css-orientation-lock` would catch stays with manual review.
4. Dawn passing 2.5.8 makes it a clean baseline for the theme test corpus (PLAN §5, R2).
