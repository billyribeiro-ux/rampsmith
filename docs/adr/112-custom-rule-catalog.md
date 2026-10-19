# ADR-112: Custom rule catalog, outcomes and the data-audit rule semantics

- Status: Accepted
- Date: 2026-10-17
- Stream: WS-2 (custom checks and interactive states)

## Context

PLAN §11 lists the data-audit checks and the browser checks of `packages/a11y-rules`. Findings
are stored with a `rule_id`, `criteria text[]` and an `impact` spelled like axe-core
(PLAN §9; `crates/domain/src/impact.rs`). axe-core separates certain failures ("violations")
from results it cannot decide ("incomplete"), which Rampsmith sends to a review queue, and
keeps best-practice results apart from WCAG failures (PLAN §11, steps 4 and coverage).

Three listed checks do not map one-to-one onto a WCAG 2.2 AA failure, per the W3C documents
read on 2026-10-17:

- **"Click here" link text.** F84 ("using a non-specific link such as 'click here' or 'more'")
  is a failure of SC 2.4.9 Link Purpose (Link Only), which is Level AAA
  (https://www.w3.org/WAI/WCAG22/Techniques/failures/F84). SC 2.4.4 (Level A) accepts the link
  text together with its programmatically determined link context, which in HTML "includes
  text that is in the same paragraph, list item, or table cell as the link"
  (https://www.w3.org/WAI/WCAG21/Understanding/link-purpose-in-context).
- **Skipped heading levels.** WCAG 2.2 does not require sequential heading levels; axe-core's
  `heading-order` rule is a best practice. SC 1.3.1 is the related criterion.
- **Duplicate menu labels.** Two links with the same text are ambiguous under SC 2.4.4 only
  when they lead to different places and their context (here, the same sibling list) does not
  tell them apart.

## Decision

- Every rule has a stable id with the `rs-` prefix, so it never collides with an axe-core rule
  id in `findings.rule_id`. Ids are never renamed. `src/rules.ts` is the single catalog of each
  rule's criteria, impact and kind; findings copy those fields from it.
- Impacts follow the closest axe-core rule where one exists: missing image alt `critical`
  (`image-alt`), empty link name `serious` (`link-name`), heading order `moderate`
  (`heading-order`), autoplaying audio `moderate` (`no-autoplay-audio`); keyboard traps are
  `critical`; the remaining failures are `serious`, the remaining review items `moderate`.
- Each finding carries `outcome`: `violation` when the check is certain, `incomplete` when it
  is not (review queue, never counted as a failure), and `bestPractice` when the rule reports a
  best practice related to its criteria (stored apart, never counted as a WCAG failure).
- Data-audit semantics:
  - `rs-rich-text-link-vague`: the link's accessible name (aria-labelledby, aria-label,
    content, title), lower-cased with punctuation and symbols removed, equals a phrase in the
    locale's list. A `violation` of 2.4.4 when the link's enclosing block (paragraph, list
    item, table cell or other block container) has no other text; otherwise `incomplete`. The
    phrase list is keyed by primary language; only English ships in R1. An unsupported locale
    skips the rule and reports it in `skippedRules`, so coverage is never overstated.
  - `rs-rich-text-heading-skip`: `bestPractice: true`, criterion 1.3.1. The first heading is
    measured against the page's title level (default `h1`, configurable).
  - `rs-media-alt-empty`: empty product-media alt is a 1.1.1 `violation`, because product
    images carry product information; this differs from axe-core, which accepts `alt=""` as
    decorative. In rich text, `alt=""` stays accepted as decorative.
  - `rs-menu-item-label-duplicate`: reported on the second and later siblings with the same
    label (Unicode NFKC, case and whitespace insensitive) and a different destination.
  - `rs-rich-text-color-only`: defined in ADR-113; always `incomplete`.

## Consequences

- The merchant sees certain failures, review items and best practices separately, and the
  priority score (PLAN §11) counts only violations.
- Adding a language means adding a phrase list and its tests; no code changes elsewhere.

## Plan correction

PLAN §11, "Data audit (no browser)", second bullet. Replace:

> - Checks: media with empty or filename-like alt text; `descriptionHtml` and page bodies with skipped heading levels, empty links, "click here" link text, images without alt, tables without headers, and colour-only emphasis; menu items with empty or duplicate labels.

with:

> - Checks: media with empty or filename-like alt text; `descriptionHtml`, page bodies and article bodies with empty links, non-specific link text such as "click here" (a 2.4.4 failure only when no paragraph, list-item or table-cell text gives the link context, otherwise a review item, because F84 is a failure of AAA criterion 2.4.9), images without alt or with a file name as alt, tables without header cells, colour-only emphasis (a review item, ADR-113), and skipped heading levels (a best practice, never counted as a WCAG failure); menu items with empty labels, or with the same label as a sibling that links elsewhere. Rules and outcomes: ADR-112.

## Rejected alternatives

- Reporting every "click here" link as a 2.4.4 failure: wrong whenever the paragraph gives the
  purpose, and the plan's accuracy budget (PLAN §23, under 2% false positives) would not hold.
- Reusing axe-core rule ids for the data audit: the data audit is not axe-core, and shared ids
  would merge unrelated findings in fingerprinting.
