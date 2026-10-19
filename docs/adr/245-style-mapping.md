# ADR-245: Mapping style findings: the CSS cascade, colour values and the declarations behind them

- Status: Accepted
- Date: 2026-10-19
- Stream: W4 / WS-14 (`ws/patch-r2`; `packages/liquid-patch`, `src/map/css/`, `src/map/styles.ts`)

## Context

A low-contrast finding names the element that paints the text, but the fix is where the colour is
set: a theme setting, a section setting, or a CSS declaration, possibly reached through
`var(--x)` or an inherited ancestor (ADR-205 finding 8; mapping it to the element is a wrong span
under ADR-203). Three other rules have the same shape: a removed focus indicator, a link without
an underline inside text, and a target under 24 by 24 pixels. The scanner only has computed
styles; the source has the cascade.

## Decision

1. **A CSS index per page** (`buildCssIndex`, `src/map/css/index.ts`) lists every rule with its
   declarations and their offsets in the original file (ADR-243 point 4). Load order follows the
   layout: its `<style>` and `{% style %}` tags and the assets it links with `asset_url`, in the
   order they appear; every `{% stylesheet %}` of the page at `{{ content_for_header }}`; then
   what the rendered files style or link, file by file. Later order wins at equal specificity.
2. **At-rules** are evaluated at the scanner's viewport, 1280 px wide (corpus manifest):
   `screen` and `all` apply, `print` and `speech` do not, `min-width` and `max-width` in `px`,
   `em` or `rem` are decided, `@supports` and `@layer` are transparent, and every other media
   query or at-rule makes the rule conditional. `@keyframes`, `@font-face` and `@page` are not
   style rules and are skipped.
3. **Selector matching is three-valued** (`yes`, `no`, `maybe`, `src/map/css/selector.ts`, on
   `postcss-selector-parser`): a selector that depends on something the scanner did not record
   (`:has()`, an unknown pseudo-class, a sibling combinator without the siblings) is `maybe`.
   Structural pseudo-classes use the recorded siblings. `:hover`, `:active`, `:focus`,
   `:focus-visible` and `:focus-within` do not match at rest; for a focus finding the focus
   states match. Specificity counts ids, then classes, attributes and pseudo-classes, then tags
   and pseudo-elements, with `:where()` zero and `:is()`, `:not()`, `:has()` their most
   specific argument.
4. **The cascade** (`src/map/css/cascade.ts`) picks, for one property of one element, the winner
   by `!important`, then the element's own `style` attribute, then specificity, then order.
   An inherited property (`color`) takes the nearest ancestor's winner when the element has none
   or the winner says `inherit`, `currentcolor`, `unset` or `revert`. A `maybe` rule that could
   have won, and an inline style the source was not read for, make the answer `uncertain`
   rather than being ignored or assumed.
5. **Colour** (`mapTextColor`): resolve `color` through the cascade. A literal opaque colour is
   the target declaration. `var(--x)` follows the custom property (up to six steps) from the
   ancestor level where it was found; a fallback inside the `var()` itself is not a target and
   is refused. `{{ settings.x }}` becomes the value at `/current/x` (or the named preset) of
   `config/settings_data.json`, `{{ section.settings.x }}` the value at `<instance>/settings/x`
   of the instance's JSON, each as a `json-value` span; a value that is not one opaque colour is
   refused with its reason. The resolved colour is compared with the colour the scanner measured
   (`fgColor`): equal gives 0.96; different (opacity, blending) 0.55; not given at most 0.85;
   and an uncertain cascade at most 0.8.
6. **The other three rules** use the same cascade with a finder (`src/map/styles.ts`):
   `rs-focus-indicator-missing` matches as if focused and looks at `outline`, `outline-style`
   and `outline-width` for `0`, `0px` or `none`; `link-in-text-block` looks at `text-decoration`
   and `text-decoration-line` for `none`; `target-size` looks at `width` or `height` (the one
   the measured box shows is under 24 px) for a value under 24 px. A winning declaration that
   does not explain the finding is `needs_review` ("does not explain the finding"); an explained
   one maps at 0.95, or 0.8 when uncertain.
7. **The element's own `style` attribute** is read from the mapped element's source
   (`inlineDeclarations`), so a declaration there is a target with offsets in the section file.
8. **Not modelled**, and the reason a result may come back below 0.9: cascade layer order,
   `@scope`, container queries, CSS nesting, shadow DOM, `all`, and anything JavaScript does.
   Each makes the answer `maybe` or is not seen; none is guessed.

## Consequences

- A colour fix lands on the setting or declaration that produced the colour, and a shared
  setting's other uses are re-measured by the rescan (ADR-247).
- The cascade is a model of CSS, checked against Chromium by the corpus runner's colour
  comparison; where the model and the browser disagree the colour check lowers confidence to
  0.55 and the finding goes to review instead of to a wrong edit.
- The mapper does not choose between the `nearest` and `stronger` candidates; that is the
  caller's (ADR-248).

## Rejected alternatives

- Reading the computed style from the browser and searching the source for that string: the same
  hex appears in many places; the cascade says which one wins.
- Resolving `var()` by textual search for the custom property name: it finds declarations that
  do not apply to the element's ancestors.
- A full CSS engine in the package: heavy, and the scanner already measured the result; the
  model only has to find which declaration produced it, and say so when it is unsure.
