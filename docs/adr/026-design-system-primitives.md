# ADR-026: Design-system primitives in `packages/ui`

- Status: Accepted
- Date: 2026-10-17

## Context

R0 step 10 and the R0 exit criterion "design primitives pass axe with zero violations" (PLAN §5)
need the primitives listed in PLAN §16, each following its WAI-ARIA Authoring Practices pattern
with an axe test and a keyboard test, plus colour tokens at 4.5:1 for text and 3:1 for UI
boundaries, a visible `:focus-visible` ring and `prefers-reduced-motion`.

Registry versions checked on 2026-10-17: `vitest` 5.0.5 with `@vitest/browser-playwright` 5.0.5
(peer `vitest` 5.0.5, `playwright` any), `vitest-browser-svelte` 3.1.0 (peers `svelte` ^5,
`vitest` ^4 || ^5), `@sveltejs/vite-plugin-svelte` 7.3.1 (peers `vite` ^8, `svelte` ^5.46.4),
`svelte` 5.57.2, `svelte-check` 4.7.7 (peer `typescript` ^5 || ^6).

## Decision

1. **Svelte 5 components, source-only.** `@rampsmith/ui` exports `.svelte` sources through the
   `svelte` export condition; the web app compiles them. No build step, no `dist`.
2. **Components:** Button, Link, VisuallyHidden, SkipLink, Dialog (native `<dialog>` with
   `showModal()`, focus moved in and restored), Tabs (automatic activation, roving tabindex),
   Combobox (list autocomplete, `aria-activedescendant`), Disclosure, MenuButton (arrows, Home,
   End, type-ahead, Escape and Tab), DataTable (caption, `scope="col"`, a button in each sortable
   header, `aria-sort` only on the sorted column) and Toaster with a `Toasts` state class.
3. **No built-in strings.** Every text a component generates (close and dismiss labels, "opens
   in a new tab", result counts) is a required prop, so the app passes its Paraglide messages
   and nothing ships untranslated.
4. **Tokens** live in `tokens.css` as custom properties; components read colours, spacing, the
   44 px target size and `--rs-duration` from it, and `--rs-duration` is `0ms` under
   `prefers-reduced-motion: reduce`. The contrast test reads the same file, so the numbers that
   are tested are the numbers that ship.
5. **Toasts:** information and success go to a polite `role="status"` region and leave after a
   timeout that pauses while pointer or focus is on them; errors go to a `role="alert"` region
   and stay until dismissed. PLAN §16 named only `role="status"`; an error needs the assertive
   region so it is announced at once (WAI-ARIA `alert`), so the plan is corrected.
6. **Tests run in a real Chromium** through Vitest browser mode with the Playwright provider:
   axe-core 4.14 with the engine's WCAG 2.2 A/AA tag set on each component in its open and
   closed states, real key events for every keyboard path, computed focus-ring styles, and
   reduced motion emulated through a browser command. They run in `mise run test:e2e`, which
   already installs Playwright's Chromium in CI.

## Consequences

- The standalone web pages now use the primitives and tokens; their Playwright and axe tests
  keep covering the composed pages.
- New primitives must arrive with the same two tests; the embedded admin keeps Polaris.
- Vitest's browser mode compiles Svelte with runes forced for this package only, because
  `@testing-library/svelte-core` ships a legacy-mode wrapper.

## Rejected alternatives

- jsdom or happy-dom: no layout, so axe cannot check contrast or target size and focus
  behaviour differs from browsers.
- Playwright component testing (`@playwright/experimental-ct-svelte`): still experimental.
- A third-party headless component library: the patterns are small, and owning them keeps the
  keyboard behaviour under our own tests.
