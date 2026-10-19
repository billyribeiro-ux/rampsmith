# ADR-051: Scrubbing stored selectors and page addresses

- Status: Accepted
- Date: 2026-10-19
- Refines: PLAN §18 (scrubbing before storage), PLAN §19
- Fixes: R0 security audit L10

## Context

PLAN §18 says DOM snapshots and HTML excerpts lose form values, email addresses and phone-number
patterns before storage, and PLAN §19 says Rampsmith holds almost no shopper data and no tokens.
The engine scrubbed only the HTML excerpt. Two more fields come from the page and were stored as
they arrived (`finding_occurrences`):

- `target`, axe's selector for the element. Axe names an element by its id, classes and
  attributes, so a selector can read `input[value="shopper@example.com"]`,
  `a[href="/account/reset/4821?key=…"]` or `[aria-label="Jane Doe, 12 Elm Street"]`.
- `page_url`, the address the browser ended on after redirects. A storefront can redirect to
  `/account/login?return_url=…&email=…`, a password page or an order-status page whose address
  carries a key.

## Decision

`packages/engine/src/scrub.ts` scrubs both, and `recordPage` (`store.ts`) applies the scrub to
every occurrence before any statement runs, so a producer other than `scanPage` cannot bypass it.

1. **Selectors (`scrubSelector`).**
   - The value of every attribute selector is dropped (`[href="…"]` becomes `[href]`), except
     for structural attributes whose short, plain value tells elements apart without holding
     content: `type`, `role`, `rel`, `target`, `name`, `tabindex`, `dir` and the `aria-*`
     state and property attributes with enumerated values. `aria-label`, `aria-labelledby`,
     `aria-description`, `aria-placeholder`, `aria-valuetext` and every other attribute are
     scrubbed. A kept value must be 64 characters or fewer of word characters, dots, colons,
     hyphens and brackets; an email address or an escaped string fails that and is dropped too.
   - Email addresses are replaced with `[email]`, plain or CSS-escaped (an id selector spells
     one `#jane\.doe\@example\.com`).
   - An attribute selector that does not parse is replaced by `[]` and the rest of the text is
     dropped, because nothing after a malformed selector can be trusted.
   - Control characters are removed (PostgreSQL text rejects NUL), input is read to 4096
     characters and the result is cut to 2048. The scan is a single left-to-right pass plus a
     linear email scan, with no backtracking pattern over page text; a test feeds it 200,000
     characters of backslashes, brackets and `@` signs.
   - Ids and classes are kept: they carry the structure a finding is found by, and the
     fingerprint already strips generated numbers from them.
2. **Addresses (`scrubUrl`).** Only scheme, host (with a non-default port) and path remain.
   Credentials, query string, fragment and `;` path parameters are dropped. A path segment that
   is an email address (also percent-encoded) becomes `[email]`; a segment that is a UUID, 24 or
   more hexadecimal digits, or 22 or more characters of mixed case and digits becomes
   `[token]`. Product and page handles, which are lowercase words with hyphens and often digits,
   are kept. Anything that is not http(s) (`data:`, `blob:`, `javascript:`, `chrome-error:`) is
   reduced to its scheme.
3. **The fingerprint is taken over the scrubbed selector.** An attribute value must not reach a
   stored hash (a hash of an email address is a guessable pseudonym, not an erasure), and
   findings now merge across pages when only attribute values differ, which matches PLAN §11
   step 8: one template failure is one finding with many occurrences. Findings recorded before
   this change are not rewritten (none exist outside development databases at this point).
4. **Not changed.** `scan_pages.url` holds the address the job was asked to load. It is part
   of the idempotency key `(scan_id, url, page_state)`, so scrubbing it could make two pages
   collide, and the scan planner builds it from resource handles, never from shopper input.
   The planner must keep it so; the engine already refuses a page that is off the site.

## Consequences

- Stored selectors are shorter and more general (`a[href]`, not `a[href="/products/scarf"]`).
  Two different elements that differ only in a scrubbed value (two links in one section with
  the same rule) now merge into one finding with two occurrences. That is the intended
  granularity for template-level fixes; the occurrence list keeps the count.
- The scrub cannot remove personal data a merchant wrote into an id, class or path handle
  (`/pages/jane-doe`). That is store content the merchant published, which PLAN §19 treats as
  data processed on the merchant's behalf, not shopper data.
- A rule that names a different page (`/account/reset/4821/<token>`) shows `[token]` in the
  merchant's evidence list; the finding is still reproducible from the rule and the section.

## Rejected alternatives

- Replace each value with a hash or a placeholder per value: keeps elements distinct, but a hash
  of a low-entropy value is reversible by guessing, and it defeats merging.
- Drop `target` entirely: the merchant needs a way to find the element, and the fingerprint
  needs its shape.
- A regular expression for attribute selectors: unterminated quotes and `]` inside strings are
  exactly what a hostile page produces, and backtracking cost grows with page-controlled text.
