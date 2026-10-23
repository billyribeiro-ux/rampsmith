# ADR-297: The scanner records where an element sits, so a patch can find its source

- Status: Accepted
- Date: 2026-10-23
- Relates to: ADR-296

## Context

A code fix starts from a rendered element and must find the one place in the theme that produced
it. An excerpt of the element alone fits many places. Run over the corpus themes, the first
production-shaped attempt fixed 2 of 59 findings because the mapper had too little to go on.

## Decision

Each occurrence stores, besides the excerpt: the id of the enclosing `shopify-section-*` element
(`section_id`), up to six ancestors (tag, id, classes), the scan page type, and for contrast nodes
the measured foreground, background, font size and weight (`evidence`). The planner turns these
into the mapper's input; the mapper accepts a source element only when its in-file ancestors are
among the rendered ancestors.

Element ids are read with `getAttribute('id')`. A form that holds a field named `id` shadows its own
`id` property (DOM clobbering): `form.id` is then the field element, and the stored ancestry read
`form#[object HTMLSelectElement]`, so every element inside a product form lost its section. A
scanner test now covers a form with `<input name="id">`.

Scanner page types are home, collection, product, cart, search, login, page and article. They map to
the Shopify templates `index`, `collection`, `product`, `cart`, `search`, `customers/login`, `page`
and `article`. An alternate template such as `page.contact` renders from the `page` template, so the
fix lands in the template the mapper finds; this is a known limit.

## Consequences

Numbers and ids that Shopify generates (for example in `id="Slide-12345678"`) fall to the scrub that
removes phone-like digit runs from stored excerpts, so such an attribute cannot match its source and
the finding is skipped as unmapped, not guessed.
