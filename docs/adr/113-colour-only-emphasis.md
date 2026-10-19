# ADR-113: Definition of colour-only emphasis in rich text

- Status: Accepted
- Date: 2026-10-17
- Stream: WS-2 (custom checks and interactive states)

## Context

PLAN §11 lists "colour-only emphasis" among the data-audit checks. SC 1.4.1 Use of Color
(Level A) reads: "Color is not used as the only visual means of conveying information,
indicating an action, prompting a response, or distinguishing a visual element"
(https://www.w3.org/TR/WCAG22/#use-of-color). A merchant who colours "sale ends Friday" red
inside a sentence, with nothing else setting it apart, conveys emphasis by colour alone. The
data audit sees only the stored HTML: not the theme's text colour, not the contrast between the
two colours, and not whether the colour carries meaning or is decoration.

## Decision

An element E in rich text is reported as `rs-rich-text-color-only` when all of these hold:

1. E is an HTML element that is not a block (`p`, `div`, `li`, `td`, `th`, headings and the
   other block containers listed in `src/data/rich-text.ts`) and is rendered (no `hidden`
   attribute, `display: none` or `visibility: hidden` on it or an ancestor).
2. E declares a text colour, in its inline `style` (`color:`) or as `<font color>`, whose
   normalised value is a real colour (not `inherit`, `initial`, `unset`, `revert`,
   `revert-layer`, `currentcolor` or `transparent`) and differs from the colour E inherits
   from the nearest ancestor that declares one.
3. Nothing else sets E's text apart:
   - E is not, and is not wrapped by an element whose text is exactly E's text (looking up at
     most 32 levels), one of: `a`, `b`, `big`, `cite`, `code`, `del`, `dfn`, `em`, `h1`–`h6`,
     `i`, `ins`, `kbd`, `mark`, `q`, `s`, `samp`, `small`, `strike`, `strong`, `sub`, `sup`,
     `tt`, `u`, `var`, or `abbr` with a `title`;
   - neither E's style nor such a wrapper's style sets a non-colour distinction: `font-weight`
     bold or 600 and above, `font-style` italic or oblique, a `text-decoration` line, a
     non-transparent background, a visible border or outline, a `font-size` other than
     100%/1em/1rem/medium, `text-transform` uppercase or capitalize, or small capitals;
   - E's text is not entirely inside descendants that are distinguished in those ways.
4. E has text, and its nearest block ancestor (or the whole field, when there is none) has
   other non-whitespace text, so there is surrounding text for the colour to stand out from.

The finding is always `incomplete`: it goes to the review queue and is never counted as a
failure, because the audit cannot see the theme's colours or whether the colour conveys
information. A nested element of the same colour is not reported again. Links are left to the
render audit (axe-core's `link-in-text-block`), where the theme's styles are visible.

## Consequences

- The merchant reviews each item; the suggested data fix is to add a non-colour cue, such as
  wrapping the text in `<strong>`.
- False positives are bounded to review items, inside the accuracy budget of PLAN §23.

## Rejected alternatives

- Reporting colour-only emphasis as a violation: the data audit cannot tell decoration from
  meaning or measure contrast, so certainty would be overstated.
- Resolving colours against the theme: needs the rendered page, which is the render audit's job.
