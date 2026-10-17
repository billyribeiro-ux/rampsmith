# ADR-111: Parse rich text with parse5 under hard limits

- Status: Accepted
- Date: 2026-10-17
- Stream: WS-2 (custom checks and interactive states)

## Context

The data audit (PLAN §11) reads product `descriptionHtml`, page bodies and article bodies,
which merchants, importers and apps write. The input is untrusted. Findings must point at the
offending markup precisely enough for a data fix (PLAN §12), so the parser must give source
offsets, and it must build the same tree a browser builds, or findings would describe markup
the storefront never renders.

- `parse5` 8.0.1 (MIT; one dependency, `entities` 8.1.0, BSD-2-Clause) implements the WHATWG
  tree-construction algorithm, never executes scripts, and with `sourceCodeLocationInfo: true`
  gives every element `startOffset`/`endOffset` (versions read from the registry on 2026-10-17,
  `docs/evidence/ws-2-a11y-rules.md`). The offsets are JavaScript string indices (UTF-16 code
  units) into the original input, including inputs with CR LF line endings and astral
  characters (measured, same evidence file).
- parse5's scope checks walk the stack of open elements, so cost grows with the square of the
  nesting depth: 200,000 nested `<div>` tags took 287 s to parse on this machine. That input is
  1 MB, well within what an attacker can put into a product description.
- parse5's duplicate-attribute check compares each new attribute with every earlier one on the
  same tag, so cost grows with the square of a tag's attribute count: 40,000 distinct
  attributes on one tag (199 KB) took 6.6 s, and no tree-adapter hook runs while one tag is
  tokenized.

## Decision

- Parse with `parseFragment(html, { sourceCodeLocationInfo: true, treeAdapter })` in the
  `<body>` context, where `treeAdapter` wraps parse5's default adapter (a public interface,
  `TreeAdapter`) and enforces, per input:
  - length at most 1,000,000 code units, checked before parsing;
  - at most 256 attributes on any start or end tag, checked before parsing by a linear scan
    that follows the tokenizer's attribute states (quotes delimit only values after `=`), so
    a `"` inside a name cannot hide attributes from the count; tag-like text in comments or
    raw-text elements is counted too, which can only refuse more input, never less. A
    megabyte of tags at the limit parses in about 0.4 s;
  - element nesting at most 512 deep: each insertion walks up at most 513 ancestors (linking
    `<template>` contents back to their template), so the stack parse5 scans stays bounded and
    the whole parse is linear in input size times a constant;
  - at most 100,000 elements;
  - a 3-second wall-clock budget, read every 256 adapter calls, as a backstop.
- A breach returns `{ status: 'not_audited', reason }` with reason `too_large`,
  `too_many_attributes`, `too_deep`, `too_many_elements`, `time_limit` or `parser_error`. Nothing throws to the caller. A field
  that is not audited is reported as such, never as clean.
- Locations are half-open UTF-16 offsets into the field's value: `value.slice(start, end)` is
  the offending element, start tag through end tag. When the parser created an element
  implicitly (no source location), the nearest ancestor's range is used and the finding says
  `approximateLocation: true`.
- Every pass over the parsed tree is iterative and linear; link names and `aria-labelledby`
  lookups are capped (300 characters, 5,000 nodes per reference).
- Property tests (`fast-check` 4.10.2, MIT) generate tag soup, arbitrary strings with lone
  surrogates and NUL, and long repetitions of hostile patterns, and assert: no exception, a
  typed status, offsets inside the input and pointing at `<`, sorted output, determinism, and
  completion within 10 s for 200 KB inputs.

## Consequences

- Hostile input costs at most a few seconds of CPU and yields a typed result.
- Content nested deeper than 512 elements is not audited; the scan reports the field as not
  audited, which the coverage disclosure (PLAN §11) shows to the merchant.
- The engine can apply a data fix by splicing `value.slice(0, start) + replacement +
  value.slice(end)` without re-parsing.

## Rejected alternatives

- `htmlparser2`: fast, but does not implement the WHATWG tree construction, so misnested
  markup would yield a different tree from the storefront's.
- A DOM implementation such as `jsdom`: far larger, and it can execute scripts when misconfigured.
- Running the parser in a worker thread with a kill timer: correct but heavy for thousands of
  fields per scan; the adapter limits bound the cost without a thread per field.
