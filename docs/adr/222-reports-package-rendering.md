# ADR-222: `packages/reports`: pure renderers, escaping by construction, inlang catalogs

- Status: Accepted
- Date: 2026-10-18
- Stream: WS-13 (reports and statement generator)

## Context

PLAN §16 "Reports" lists the remediation log export, the executive summary and PDFs; PLAN §5
R1 adds the statement generator. The reports render merchant data (store and product names,
finding summaries, alt text before and after, free text the merchant writes) into HTML that
merchants publish on their storefronts, into CSV that opens in spreadsheets, and into PDFs printed
by Chromium. PLAN §8 wants pure logic in libraries, Paraglide catalogs for every UI string, and
bans `{@html}` except one sanitized report component.

## Decision

1. `packages/reports` is pure TypeScript with **no runtime dependencies**. It takes typed inputs
   whose enum spellings match `crates/domain` (a test reads `enums.rs` and `impact.rs` to prove
   it) and returns strings, or a PDF through a browser the caller passes in (ADR-223).
2. **Escaping by construction.** HTML is only built with the `markup` tagged template: every
   interpolated string is sanitized and escaped, and only `Html` values built by the package
   pass through. `Html`, `Link` and `ReportDocument` can only be constructed inside the package
   (a private symbol key), so callers cannot smuggle markup in. Links exist only as `Link` values
   from `webLink` (absolute https/http without credentials), `emailLink` (a strict address with
   nothing that alters a `mailto:` link) and `phoneLink` (digits and a leading plus). The tag
   is called `markup`, not `html`, because Prettier reformats `html`-tagged templates, which
   changed the output and broke the style hash of ADR-223.
3. **Sanitizing.** Every input string loses C0 and C1 controls (tab and line feed kept),
   explicit bidirectional embedding, override and isolate characters (U+202A–U+202E,
   U+2066–U+2069) and lone surrogates, and line endings become LF. Field lengths and list sizes
   are capped, so hostile input cannot stall the printer.
4. **Validation.** Each renderer validates its whole input first and throws `ReportInputError`
   naming the field (for example `contact.email` or `entries[3].approver`), never rendering a
   report that misstates its data: counts are whole numbers, passed never exceeds run, dates are
   valid, criteria are WCAG 2.2 A or AA, a data fix ships only through the Admin API, an AI fix
   names its model, an approver exists exactly when an approval date does.
5. **One block model** (heading, paragraph, list, markup) renders both HTML and plain text, so
   the statement's formats cannot drift apart.
6. **Message catalogs** use the inlang message format that `apps/web`'s Paraglide catalogs use
   (`@inlang/plugin-message-format` 4.5.4 README, read 18 October 2026): `messages/<locale>.json`,
   `{name}` placeholders, `\{` and `\}` escapes, and plurals as one variant object with
   `"input count"`, `"local countPlural = count: plural"` and a `countPlural=*` catch-all. A
   small parser in the package reads exactly that subset and refuses anything else, so the
   package needs no Paraglide build step. English ships; a locale without a catalog falls back
   to English and the result says so (`fallback: true`). A test checks every registered catalog
   against English: same keys, same placeholders, a catch-all in every plural. Dates are long
   dates in UTC and numbers use the locale's grouping.
7. The repository's `claims-lint` already scans `**/messages/**/*.json`, so the catalog is
   checked by the existing gate as well as by this package's tests over every rendered output.

## Plan correction

- PLAN §8 monorepo layout, under `packages/`, add:
  `reports/  # pure renderers: accessibility statement, remediation log, executive summary, PDFs (ADR-222)`.
- PLAN §8 TypeScript standards: "`{@html}` is banned except for one sanitized report component"
  becomes "... except for one report component that renders a fragment produced by
  `@rampsmith/reports`, which escapes every value by construction (ADR-222)".

## Consequences

- Rendering is testable without a browser, a database or a network; only the PDF step needs
  Chromium.
- The parser supports only the inlang subset the catalog uses. A translator who needs gender or
  ordinal selectors needs a parser change; the catalog test fails first, so it cannot ship broken.
- The finding summaries come from the caller per locale (rule catalogs such as
  `packages/a11y-rules` hold English summaries today); translating them is outside this package.

## Rejected alternatives

- A template engine (Handlebars, Eta) or a DOM library: a runtime dependency and a second
  escaping model for no gain over a tagged template.
- Compiling the catalog with Paraglide: adds a build step to a library that is consumed as
  TypeScript source; the subset parser keeps the files compatible with Paraglide instead.
