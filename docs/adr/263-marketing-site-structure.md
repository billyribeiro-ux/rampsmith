# ADR-263: How the marketing site is built

- Status: Accepted
- Date: 2026-10-22

## Context

LAUNCH.md section B asks for a marketing site, pricing page, free scanner, accessibility
statement and the privacy, terms and DPA drafts, all passing Rampsmith's own checks (PLAN §16,
§19, §20). The drafts and the statement already exist as Markdown in `docs/`. PLAN §8 bans
`{@html}` outside the one sanitised report component.

## Decision

- The site lives in the route group `apps/web/src/routes/(site)/`, with its shell in
  `src/lib/site/` (`SiteShell.svelte`, `site.css`). The previous root page moved into the group
  and keeps its heading, so existing tests still apply. `/dashboard` and `/app` are untouched.
- Pages: `/`, `/how-it-works`, `/pricing`, `/scan`, and under a nested `(draft)` group
  `/accessibility`, `/privacy`, `/terms`, `/dpa`, `/subprocessors`. The `(draft)` layout sends
  `X-Robots-Tag: noindex, nofollow`, and each page carries the same meta tag.
- The draft documents are imported as text at build time (`?raw`) and parsed by a small Markdown
  reader (`markdown.ts`) into data that Svelte renders as elements (`Markdown.svelte`). Raw HTML
  in a source is shown as text, links keep only `http(s):`, `mailto:` and in-page targets, and no
  `{@html}` is used. The reader covers exactly what the four documents use, and a test parses
  each real document and fails if Markdown syntax is left in the output. The web image's build
  stage copies the whole repository, so `docs/` is available when it builds.
- The legal drafts and the statement sit under a banner: "Draft — attorney review required. Not
  published." (statement: placeholders are completed before publication). Their placeholders
  stay visible. Publishing them is the founder's decision (CLAUDE.md) and is not done here.
- The pricing data is `plans.ts`; `plans.test.ts` reads the plan table from `docs/PLAN.md` and
  fails if a price, yearly price, alt-text allowance or the ADR-141 Starter channel text
  differs. Plan-gated features are listed in a matrix, set back visually, and labelled with the
  plan that unlocks them (Built for Shopify 4.1, PLAN §20).
- Dark mode: `site.css` overrides the `@rampsmith/ui` colour tokens inside
  `prefers-color-scheme: dark`, scoped with `:root:has(.site)` so the dashboard and the embedded
  app keep theirs. `tokens-dark.test.ts` checks every pair against WCAG 2.2 (4.5:1 text, 3:1
  boundaries). There is no manual toggle, so no stored preference and no script.
- No analytics, no cookies, no third-party requests except Turnstile on `/scan` (PLAN §19).
- Copy passes `claims-lint`: results are phrased "Passes N of M automated WCAG 2.2 AA checks",
  the 57% figure is axe-core's own (its README, v4.14.0), and no page says a store meets a law.

## Consequences

- Editing a draft in `docs/` changes the site on the next build with no copy step.
- A construct the reader does not know (nested lists, block quotes, images) would show as text;
  the real-document test catches the common cases, and the reader is a few dozen lines to extend.
- The ADR index (`docs/adr/README.md`) is the architect's file; rows for ADR-260 to 263 are for
  the architect to add.

## Rejected alternatives

- A Markdown library with HTML output: needs `{@html}` and a sanitiser for text we author.
- Copying the drafts into message files: two sources of truth for legal text.
- A light and dark toggle: more state, a script and storage, for little gain over the system
  setting.
