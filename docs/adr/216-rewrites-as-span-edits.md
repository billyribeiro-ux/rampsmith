# ADR-216: Description rewrites are span edits on the merchant's HTML, decided by the model

- Status: Accepted
- Date: 2026-10-18
- Stream: WS-12 (PLAN §11, §12, §13)

## Context

PLAN §12 fixes skipped headings and vague link text in product descriptions and pages with a
"corrected `descriptionHtml` through the Admin API", AI-drafted and human-approved. Letting a
model rewrite HTML would let it change anything, including injecting markup into a storefront,
and would reformat the merchant's code (ADR-007 forbids reformatting theme files for the same
reason).

## Decision

1. `analyzeDescription` parses the field with `parse5` 8.0.1 (MIT, verified on npm on
   2026-10-17; the WHATWG-conformant parser jsdom uses) with source locations, and lists
   headings (level, text, tag spans) and links (accessible name, target, surrounding block
   text, whether they hold element children, tag and `aria-label` spans). It flags headings
   above the base level (2 under a level 1 page title) or skipping a level, and links whose
   name is empty or one of the out-of-context phrases ("click here", "read more", "here" …).
   The walk is iterative and bounded (`HTML_LIMITS`: nesting depth 256, 100 headings, 200
   links, 300 graphemes of text per item), so a hostile description costs linear time and a
   field over a limit fails as `ai_input_invalid` before any budget is reserved (security
   audit HIGH-2).
2. The model returns only heading levels by index and plain link text by index (ADR-213
   output schema). It never returns HTML.
3. `applyRewrite` turns those into span edits: the two characters of each heading's start and
   end tag name; a text-only link's inner content, HTML-escaped; or, for a link with element
   children or an existing `aria-label`, an escaped `aria-label` attribute. Edits apply from
   the end backwards and must not overlap; two insertions at the same offset count as
   overlapping. A heading without an end tag is refused.
4. The result is re-parsed and must have the same headings and links, the intended levels and
   names, the same targets, and identical text outside the changed links; otherwise the draft
   goes to review as `unsafe_edit`. The fix carries the before and after values for one-click
   undo (PLAN §5).
5. The outline must start at the base level and never skip a level; new link text must be 2 to
   100 characters, not vague, without markup, backslashes, URLs, hidden characters,
   instruction-like text or added banned claims, and in the locale's script.

## Consequences

- The only bytes that change are the ones the fix needs; the merchant's formatting, classes
  and attributes survive, and undo is exact.
- The model cannot add a link, an image, a script or a style to a store, whatever the
  description says.
- English is the only language with a vague-phrase list for now; other locales flag empty
  links only until R3 adds lists per language.

## Plan correction

- PLAN §12 fix catalog, "Skipped headings, vague link text" row, Fix column: "Heading levels
  and link text chosen by the model, applied as span edits to `descriptionHtml` or the page
  body and re-parsed to prove nothing else changed (ADR-216)".

## Rejected alternatives

- Model-written replacement HTML checked by a diff: the check would have to understand every
  HTML construct the model might emit.
- Re-serializing the parsed tree: reformats the whole field.
- Regular expressions over HTML: unsafe on real merchant markup.
