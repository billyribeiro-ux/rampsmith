# ADR-111: Parse rich text with parse5 under hard limits

- Status: Accepted
- Date: 2026-10-17 (revised the same day after the security audit of `5bd9f99`: H2, H3, M6, L7)
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
- Measured costs on this machine (evidence file, sections 2, 6 and 7):
  - scope checks walk the stack of open elements: 200,000 nested `<div>` tags took 287 s;
  - the duplicate-attribute check compares each attribute with every earlier one on its tag:
    40,000 attributes on one tag took 6.6 s, and no tree-adapter hook runs inside one tag, so a
    deadline checked only in adapter hooks cannot stop it. The audit found that a pre-scan
    alone can be misled by text after `<!`, `<?` or inside raw-text elements
    (`<!-- <a x=" -->` before the tag): 60,000 attributes then took 10.5 s;
  - moving a parent's children (the fragment root once parsing ends, or a misnested block in
    the adoption agency) detaches each first child with an O(n) array splice: 100,000 `<img>`
    siblings took 8.4 s.

## Decision

- Parse with parse5's fragment parser (`Parser.getFragmentParser`, which `parseFragment`
  itself calls) in the `<body>` context, writing the input to its streaming tokenizer 1,024
  characters at a time and checking the deadline between writes, so the time budget holds
  whatever the tokenizer does inside one tag. `Parser` is exported by parse5 but marked
  internal; the version is pinned exactly, and a property test builds the tree with every
  chunk size from 1 to 9 and requires the same nodes, attributes and offsets as one write.
- The tree adapter wraps parse5's default adapter (a public interface, `TreeAdapter`) and
  enforces, per input:
  - length at most 1,000,000 code units, checked before parsing;
  - element nesting at most 512 deep: each insertion walks up at most 513 ancestors (linking
    `<template>` contents back to their template), so the stack parse5 scans stays bounded;
  - at most 100,000 elements;
  - a 3-second wall-clock budget, read between chunks and every 256 adapter calls;
  - detaching a first child in O(1): it advances a per-parent head index, and the array is
    compacted on the next other access to that parent and before the tree is returned.
- A linear pre-scan that follows the tokenizer's attribute states refuses a tag with more than
  256 attributes as `too_many_attributes` before parsing. It is a fast path for plain floods;
  the chunked deadline is what bounds the misleading cases.
- A breach returns `{ status: 'not_audited', reason }` with reason `too_large`,
  `too_many_attributes`, `too_deep`, `too_many_elements`, `time_limit` or `parser_error`.
  Nothing throws to the caller. A field that is not audited is reported as such, never as clean.
- Locations are half-open UTF-16 offsets into the field's value: `value.slice(start, end)` is
  the offending element, start tag through end tag. When the parser created an element
  implicitly (no source location), the nearest ancestor's range is used and the finding says
  `approximateLocation: true`.
- Every pass over the parsed tree is iterative and linear. Link names stop at 300 characters.
  `aria-labelledby` reads at most 10 distinct ids per link; each id is resolved once per field
  and remembered, under one budget of 100,000 nodes for the whole field. When the budget runs
  out, an otherwise empty link is reported as `incomplete`, not as a violation.
- At most 1,000 findings are kept per field; `truncated: true` says more exist, and the next
  scan finds them once the first are fixed. This bounds memory per field.
- Text checks on untrusted strings are linear: alt text longer than 256 characters is never
  treated as a file name; the extension, dimension and hash checks are hand-written scans or
  anchored expressions without ambiguous repetition; menu URLs drop trailing slashes with a
  loop. Timing tests cover the audit's payloads (20,000 digits then a letter; repeated
  `.png?` then a newline; 200,000 slashes).
- Property tests (`fast-check` 4.10.2, MIT) generate tag soup, arbitrary strings with lone
  surrogates and NUL, and long repetitions of hostile patterns, and assert: no exception, a
  typed status, offsets inside the input and pointing at `<`, sorted output, determinism, and
  completion within 10 s for 200 KB inputs.
- The engine runs data audits in a worker thread with a kill timer as the outer backstop: the
  limits above bound parse5 as measured, and the worker covers what nobody has measured yet.

## Consequences

- Hostile input costs at most the time budget plus one chunk of work, and yields a typed
  result.
- Content nested deeper than 512 elements is not audited; the scan reports the field as not
  audited, which the coverage disclosure (PLAN §11) shows to the merchant.
- The engine can apply a data fix by splicing `value.slice(0, start) + replacement +
  value.slice(end)` without re-parsing.
- Upgrading parse5 needs a check that `Parser.getFragmentParser`, `tokenizer.write` and
  `getFragment` still behave as here; the chunk-size property test and the timing tests fail
  if not.

## Rejected alternatives

- `htmlparser2`: fast, but does not implement the WHATWG tree construction, so misnested
  markup would yield a different tree from the storefront's.
- A DOM implementation such as `jsdom`: far larger, and it can execute scripts when misconfigured.
- Modelling every tokenizer state in the pre-scan: it would re-implement the tokenizer and
  still need the deadline for what it got wrong.
- A worker thread per field as the only guard: heavy for thousands of fields per scan; it stays
  as the engine's outer backstop instead.
