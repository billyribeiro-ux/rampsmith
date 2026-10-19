# ADR-242: The contrast recipe: smallest OKLCH lightness change, two candidates, colour value edits

- Status: Accepted
- Date: 2026-10-19
- Stream: W4 / WS-14 (`ws/patch-r2`; `packages/liquid-patch`)

## Context

PLAN §12 lists low contrast text (WCAG 1.4.3) as a fix-catalog row: "smallest lightness change
in OKLCH that reaches 4.5:1 (3:1 large text), hue and chroma kept; two candidates for the
merchant". ADR-205 finding 2 showed that 5 of the corpus's 35 targeted findings are low contrast,
so without this recipe the best reachable fix rate is 30/35 = 85.7%, under R2's 90%.

axe-core 4.14.0's `color-contrast` check reports a failure unless `contrast > expected`, where
`expected` is 4.5, or 3 for large text, with large text being at least 18pt, or 14pt when bold
(`ceil(px * 72) / 96 >= 18`, or `>= 14` with `font-weight >= 700`, in `isLargeText`). axe-core
computes luminance with the sRGB threshold 0.04045; WCAG 2.2's definition prints 0.03928. No
8-bit channel lies between them (10/255 = 0.0392 is below both, 11/255 = 0.0431 above both), so
the two give the same ratio for every colour a theme can store.

## Decision

1. **Colour maths** lives in `src/color/color.ts`, with no dependency: parse and write `#rgb`,
   `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()`, `rgba()`, `hsl()`, `hsla()` (comma and space
   syntax) and CSS named colours; WCAG relative luminance and contrast ratio; OKLab and OKLCH
   with Björn Ottosson's matrices (https://bottosson.github.io/posts/oklab/, the form CSS
   Color 4 uses, https://www.w3.org/TR/css-color-4/#ok-lab). Known values are tested
   (`test/color.test.ts`): sRGB red is OKLab (0.62796, 0.22486, 0.12585) and OKLCH
   (0.628, 0.2577, 29.23); green (0.86644, -0.23389, 0.1795); blue (0.45201, -0.03246,
   -0.31153); #767676 on white is 4.54:1 and #777777 is 4.48:1; black on white is 21:1.
2. **The search** (`src/color/candidates.ts`) is a walk, not a closed form, so the answer is a
   colour a browser paints. Lightness moves in steps of 0.001 (about a quarter of a level of
   8-bit grey) in one direction. At each step the chroma is clamped into the sRGB gamut by
   bisection with the hue untouched (`clampChroma`), the colour is rounded to 8-bit channels,
   written in the format of the original (lower or upper case hex, `rgb(r, g, b)` or
   `rgb(r g b)`, `hsl()`), parsed back, and the ratio is measured on what was written. The
   first step with a ratio above the target is the answer. The comparison is strict, as axe-core
   reports.
3. **Two candidates.** `nearest` is the smaller of the darker and the lighter change that
   exceeds 4.5:1 (3:1 for large text; ties go to darker, which keeps the look of a light
   theme). `stronger` is the smallest change in the same direction that exceeds the enhanced
   level of WCAG 1.4.6 (7:1 for body text, 4.5:1 for large text), when it exists and differs.
   Colours already above 7:1 have one candidate at most. A merchant picks by id; a caller that
   cannot ask takes `nearest` through `chooseCandidate`. `chromaKept` is false when the gamut
   forced a lower chroma, and `deltaL` is the signed change of OKLCH lightness.
4. **What it edits.** One span: the colour text inside the JSON string quotes, or the value of
   a CSS declaration after `property:` without `!important` and without the `;`. Case, spacing,
   comments and every other byte stay (the recipe returns `{file, start, end, replacement}`
   like the others). The target is a `ColorSpan` (ADR-243), not an element.
5. **Refusals** (typed, no edit): `unsupported-color` for `var()`, Liquid output, gradients,
   alpha below 1, a non-string JSON value or one with an escape sequence; `target-not-found`
   for a pointer, offset or property that no longer matches; `invalid-parameter` for a
   background that is not an opaque colour or a ratio outside (1, 21); `contrast-unreachable`
   when no lightness reaches the target on that background.
6. **Idempotent and deterministic.** Run on its own output the recipe reports `already-fixed`
   (the measured ratio is above the target), checked for both candidates in
   `test/contrast-recipe.test.ts` and, over random colours, in `test/candidates.test.ts`.
   There is no randomness, clock or locale in the path.
7. **The background is a parameter, not read from the theme.** The scanner measured it
   (axe-core's `bgColor`), and the caller passes it. The recipe does not guess a background from
   CSS, since cascades, images and overlays decide it.
8. **CSS validity.** `applyEdits` validates `.css` files with postcss 8.5.30 before and after
   editing, as it validates Liquid and JSON, and refuses an edit that makes a stylesheet
   unparsable. Registry check, 19 Oct 2026: postcss 8.5.31 is the newest release (published
   18 Oct 2026, 19:39 UTC) and has no peer dependencies; pnpm's minimum release age holds it
   back and the only way past that is an exclusion in `pnpm-workspace.yaml`, a root manifest
   outside this stream's paths, so the pin is 8.5.30 (12 Oct 2026), the newest release old
   enough. The integrator may bump it once 8.5.31 is a day old. Liquid files (sections, snippets, `.css.liquid`) are
   validated by the Liquid parser, which is how `{% stylesheet %}` and `{% style %}` edits are
   checked.

## Consequences

- R2's fix-rate denominator includes the 5 contrast findings with a recipe behind them.
- A colour change in a shared setting changes every use of it. The merchant sees the two
  candidates and the setting's name; the contrast of other uses is the scanner's to re-measure
  (the corpus runner rescans, ADR-247).
- The walk costs at most 1000 iterations per direction and colour.

## Rejected alternatives

- A closed-form solution for the lightness that hits the ratio exactly: the answer would not be
  an 8-bit colour, and rounding could drop it back under the target.
- Moving chroma to keep the colour "vivid": PLAN §12 says hue and chroma are kept; chroma changes
  only when the sRGB gamut forces it, and `chromaKept` says so.
- A third, "opposite direction" candidate: the stronger candidate usually exists, and a second
  direction mostly offers a colour the merchant would never pick.
- Computing the background from the CSS: not reliable (ADR-243 point 4).
