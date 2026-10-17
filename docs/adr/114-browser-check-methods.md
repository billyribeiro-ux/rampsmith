# ADR-114: How the browser checks decide

- Status: Accepted
- Date: 2026-10-17
- Stream: WS-2 (custom checks and interactive states)

## Context

PLAN §11, step 6 lists five custom checks that axe-core does not run: keyboard traversal of up
to 200 tab stops (focus traps, no visible focus indicator: SC 2.1.2, 2.4.7), focus hidden by
sticky content (SC 2.4.11), reflow at 320 CSS pixels (SC 1.4.10), text spacing with clipping
detection (SC 1.4.12) and autoplaying audio (SC 1.4.2). Each takes a Playwright `Page` and
returns findings under a hard time cap; the whole page-state budget is 20 s at p95. The W3C
documents read on 2026-10-17 set what fails:

- 2.4.7 and F78: the focus indicator is "turned off or rendered non-visible"
  (https://www.w3.org/WAI/WCAG22/Techniques/failures/F78).
- 2.4.11 and F110: a focused component fails only when "entirely hidden" by author content;
  partly obscured passes at AA (https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured).
- 1.4.10: "320 CSS pixels is equivalent to a starting viewport width of 1280 CSS pixels wide at
  400% zoom"; content needing two dimensions is exempt
  (https://www.w3.org/WAI/WCAG22/Understanding/reflow).
- 1.4.12 and F104: content "clips and is unreadable" after the four spacing values are applied
  (https://www.w3.org/WAI/WCAG22/Techniques/failures/F104). The W3C pages give the values but
  no stylesheet.
- 1.4.2, F93 and the ACT rule 4c31df: autoplay, not muted, longer than 3 seconds, with audio,
  and no visible, named instrument to pause, stop or mute
  (https://www.w3.org/WAI/standards-guidelines/act/rules/auto-play-audio-has-control-mechanism-4c31df/).

## Decision

- **Probe.** One self-contained function, `installProbe`, is serialized into the page with
  `page.evaluate` and stores its API under `Symbol.for('rampsmith.a11y-rules.probe.v1')`. It
  returns JSON only and is reinstalled after a navigation. Targets use axe-core's format (one
  selector per shadow-root boundary) so the engine merges them with axe-core results.
- **Time cap.** Every check runs under `runCapped(timeoutMs)`: loops stop at the deadline, and
  the result returns within the cap plus at most 1 s for in-flight work and 2 s for cleanup,
  with `status` `complete`, `timed_out` (with what was found) or `error` (first line only).
  Defaults: keyboard and focus-obscured 15 s, reflow and text spacing 8 s, media 6 s.
  Cleanup always removes injected styles and the focus sentinel and restores the viewport.
- **Keyboard (2.1.2, 2.4.7).** Start from the top through a hidden, non-tabbable sentinel;
  press Tab up to 200 times. Leaving the page (focus on `body`) ends a normal cycle. An
  element that keeps focus for several presses (iframes, native media controls, date fields)
  has stops of its own; past 20 presses it counts as stuck.
  - Trap: focus returns to an earlier stop without leaving the page, the cycle is smaller than
    the page's tabbable elements, it is not a modal dialog containing a button (a keyboard
    exit), and Escape followed by Tab does not move focus out of it.
  - No indicator: the computed styles that can draw an indicator (outline, box shadow,
    borders, background, colour, text decoration, opacity, filter, SVG paint, transforms, and
    `::before`/`::after`) of the element, its two nearest ancestors and, for a radio or
    checkbox, its labels and following non-focusable sibling, are compared focused and after
    focus has moved on. Transitions are disabled while measuring. Only when nothing changed is
    the element re-focused and screenshotted (focused, then with focus on the sentinel); it is
    reported when the two crops around it are pixel-identical. At most 20 confirmations.
  - Hidden stop: focus lands on an element that is invisible (`checkVisibility` with opacity
    and visibility), at most 2 px in either dimension, outside the viewport after the browser
    scrolled it, or outside a clipping ancestor. A visually hidden radio or checkbox whose label
    is visible is judged by its label.
- **Focus obscured (2.4.11).** Traverse forward, then backward. At each stop, sample a 5 × 5
  grid over the visible part of the element; it is obscured only if every point hits another
  element that is neither inside it nor its ancestor. The cover is reported as the nearest
  fixed or sticky ancestor of the most frequent hit.
- **Reflow (1.4.10).** Resize to 320 CSS px wide (height unchanged), wait for the DOM to stay
  quiet (150 ms, at most 1.5 s), and compare the document's scroll width with the viewport.
  When it scrolls, report the outermost elements whose right edge passes the viewport, skipping
  fixed-position boxes, boxes that scroll or clip horizontally, and two-dimensional content
  (`table`, `pre`, `video`, `canvas`, `iframe`, `img`, `svg`, `map`, `object`, `embed`, `math`,
  roles `img`, `grid`, `application`). If the page scrolls and no cause is found, report the
  document as `incomplete`; if every cause is exempt, report nothing.
- **Text spacing (1.4.12).** Record which text boxes overflow, apply
  `*{line-height:1.5!important;letter-spacing:0.12em!important;word-spacing:0.16em!important}
  p{margin-bottom:2em!important}` (the criterion's four values), and report boxes that newly
  overflow: a clipping box (`overflow` hidden or clip) is a `violation`; a fixed-size box with
  visible overflow is `incomplete`, because whether the spilled text covers other content is
  not measured. Scrolling boxes are never reported.
- **Autoplaying audio (1.4.2).** An `audio` or `video` element with the `autoplay` attribute
  or already playing, not muted, and longer than 3 s (or looping) is checked; up to 2.5 s is
  spent waiting for its duration. Browsers may block unmuted autoplay, so the page's intent
  counts. Native `controls` or a visible, named button whose `aria-controls` names the element
  passes; a named button within three ancestor levels (never page level) makes it
  `incomplete`; none at all is a `violation` when the element certainly has audio (an `audio`
  element, or a video the browser reports as having sound), otherwise `incomplete`.

## Consequences

- Findings carry `outcome` so uncertain results reach the review queue (ADR-112).
- Partly obscured focus, overlap after text spacing, and open shadow roots beyond the
  document's style override are not measured; they are listed as limits in the coverage
  disclosure.
- Hit testing ignores elements with `pointer-events: none`, so a cover that does not take
  pointer events is missed; the check under-reports rather than over-reports.

## Rejected alternatives

- Screenshot comparison for every tab stop: about 400 screenshots per page breaks the
  20-second budget; screenshots only confirm style-diff candidates.
- Judging autoplay by actual playback: headless browsers block unmuted autoplay by policy, which
  would hide real failures that shoppers' browsers allow.
