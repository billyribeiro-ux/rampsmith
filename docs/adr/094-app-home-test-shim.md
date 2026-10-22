# ADR-094: Testing the App Home without Shopify: a typed fake api and a Polaris shim

- Status: Accepted
- Date: 2026-10-22
- Builds on: ADR-014 (sandbox browsers), ADR-091
- Lane: R1 lane C (`apps/web/tests/app-*`, `polaris-shim.ts`)

## Context

Shopify's CDN is unreachable from tests (ADR-014), so Polaris and App Bridge cannot load, and
the Rust api's `/v1/shopify/` handlers are not merged yet.

## Decision

1. **`tests/app-fake-api.ts`** is a stateful, typed fake of the api on port 3994. It serves the
   contract of ADR-091 and moves state the way the real handlers will: approving a fix applies it
   after two reads, undo reverts it, a scan finishes after three reads, settings and statements
   validate and persist. Scenarios (`default`, `free`, `starter`, `fresh`, `empty`, `error`) are
   chosen with `POST /__scenario`. The built app runs against it on port 3995 (Playwright project
   `app-home`).
2. **`tests/polaris-shim.ts`** implements the `<s-*>` elements the App Home uses, as Polaris does:
   open shadow roots, standard controls inside, properties mirroring attributes, `change`
   re-dispatched, `s-button` form-associated. It is TypeScript so it is type-checked; the
   helper erases the types with `module.stripTypeScriptTypes` and serves it in place of
   `polaris-1.1.js`. A fake App Bridge hands out the token `good`. Shadow roots leave the light
   DOM Svelte renders untouched, so hydration is not disturbed.
3. **Tags, attributes and slots were checked against the published manifest.** The Polaris
   `custom-elements.json` of `@shopify/polaris-types@1.1.0` (the version of the pinned script)
   was compared with every `<s-*>` use: all tags, attributes and slots exist except `rel` on
   `s-link`, which only `s-app-nav` links use (documented by App Bridge). The package declares
   no licence, so it is not added as a dependency; the check was run once from the tarball and
   recorded in `docs/evidence/r1-lane-c.md`.
4. **What this does not prove** is that the real components pass axe. That is a live check on a
   development store (LAUNCH.md section E, proposed in the evidence file).

## Consequences

Axe, keyboard and journey tests run in CI without a Shopify account. The shim is a test double: a
behaviour change in Polaris is invisible to it until the live check.
