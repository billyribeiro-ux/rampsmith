# ADR-030: Phosphor icons in the Svelte UI

- Status: Accepted
- Date: 2026-10-19

## Context

On 17 October 2026 the founder instructed that every icon in Rampsmith's Svelte UI comes from
Phosphor (CLAUDE.md "Engineering standards", PLAN §7). The first `@rampsmith/ui` primitives
(ADR-026) drew five icons by hand as inline `<svg>` paths: the close "X" in `Dialog` and
`Toaster`, the disclosure triangle in `Disclosure`, the menu caret in `MenuButton`, and the sort
arrows in `DataTable`. Hand-drawn paths drift from one another in weight and optical size, and
each needs its own accessibility attributes.

Registry evidence, read on 2026-10-19 with `npm view phosphor-svelte`:

| Field | Value |
| --- | --- |
| Version | 3.1.1 (published 2026-10-09; 3.1.0 was 2026-01-24) |
| Licence | MIT |
| Peer dependencies | `svelte` `^5.0.0 \|\| ^5.0.0-next.96`, `vite` `>=5` |
| Exports | `./lib/*` with types `./lib/*.svelte.d.ts` and the `svelte` condition `./lib/*.svelte` |

`@rampsmith/ui` pins `svelte` 5.57.2 and `vite` 8.3.4, so both peer ranges hold under
`strictPeerDependencies`. The package ships 1,512 `<Name>Icon.svelte` components.

## Decision

1. **Dependency.** `phosphor-svelte` 3.1.1 (exact, `saveExact`) is a `dependencies` entry of
   `@rampsmith/ui`, added with `pnpm --filter @rampsmith/ui add phosphor-svelte@3.1.1`. Any
   other Svelte package that draws an icon adds it the same way, at the same pinned version.
2. **Import rule.** Import each icon from its own file, with the `Icon` suffix:
   `import XIcon from 'phosphor-svelte/lib/XIcon'`. Never import from the package root
   (`phosphor-svelte`), and never use the unsuffixed names (`lib/X`). The per-file import is the
   one the package's README recommends for compile speed, and the suffix keeps an icon from
   colliding with a component of the same name.
3. **No hand-written icons.** No `<svg>` icon is written in a `.svelte` file under
   `packages/ui/src` or `apps/web/src`. `git grep -n '<svg' packages/ui/src apps/web/src`
   returns nothing; a new hit needs a reason in a code review, not a new exception here.
4. **Accessibility.**
   - A decorative icon, one beside a visible text label, gets `aria-hidden="true"`.
   - An icon-only control keeps a translated accessible name on the control itself (`aria-label`
     from a required prop, as `Dialog`'s `closeLabel` and `Toaster`'s `dismissLabel` already
     are, ADR-026 decision 3) and its icon is `aria-hidden="true"`. The icon never carries the
     name.
   - The component sets `role="img"` on its `<svg>`; an icon that is not hidden would need a
     `<title>` or `aria-label`, and Rampsmith's icons are all hidden, so this does not occur.
   - Colour is `currentColor` (the component's default, so the icon follows the control's text
     colour and its contrast, forced-colors mode and focus styles). Pass no `color` prop and set
     no `IconContext` colour.
   - Size is passed in pixels through `size` (16 for the dialog close, 14 for the toast dismiss,
     12 for carets and sort arrows), as the hand-written icons had, so targets and layout do
     not move. The 44 px target belongs to the button around the icon, not the icon.
   - The close "X" and the carets use `weight="bold"`, the nearest Phosphor weight to the
     2 px strokes they replace.
5. **Motion.** An icon that rotates (the `Disclosure` caret) is animated with a CSS transition
   on `--rs-duration`, which is `0ms` under `prefers-reduced-motion: reduce` (ADR-026 decision
   4). Because the icon is another component's `<svg>`, the rule reaches it through a class
   passed to the icon and `:global(...)` under the component's own scoped selector.
6. **Where Phosphor does not apply.**
   - Polaris draws its own icons inside the embedded admin; Rampsmith does not replace them.
   - The favicon (`apps/web/static/favicon.svg`) is a brand mark, not a UI icon, and stays.

## Mapping

| Component | Before | After |
| --- | --- | --- |
| `Dialog`, `Toaster` close | hand-drawn X, 16 and 14 px | `XIcon`, 16 and 14 px, bold |
| `Disclosure` | triangle, rotated 90 degrees when open | `CaretRightIcon`, 12 px, bold, same rotation |
| `MenuButton` | down triangle | `CaretDownIcon`, 12 px, bold |
| `DataTable` sort | up and down triangles, one on each side when unsorted | `CaretUpDownIcon` unsorted, `CaretUpIcon` ascending, `CaretDownIcon` descending, 12 px, bold |

## Consequences

- One icon family, one weight scale, and no inline path data to review.
- The 33 browser tests in `packages/ui` (axe with zero violations, keyboard, reduced motion)
  pass unchanged, and a probe of the rendered DOM shows `aria-hidden="true"`,
  `fill="currentColor"` and the sizes above on every icon (`docs/evidence/r0-gate-fixes.md`).
- Each icon is a small Svelte component, so the bundle grows by the icons used and nothing more
  (the per-file import keeps unused icons out).
- A Renovate bump of `phosphor-svelte` is a UI change: the browser tests must pass on it before
  it merges, because an icon's path data can change between releases.

## Rejected alternatives

- Keeping the inline SVGs: against the founder's instruction.
- `@phosphor-icons/core` raw SVGs inlined by a build step: more tooling to own, and the Svelte
  components already do the same job.
- Importing from the package root with the Vite plugin that rewrites named imports: it works,
  but the explicit per-file import needs no plugin and fails visibly if an icon name is wrong.
