# ADR-116: Interactive-state scripts and their two guards

- Status: Accepted
- Date: 2026-10-17
- Stream: WS-2 (custom checks and interactive states)

## Context

R1 scans four interactive states (PLAN §5): the main navigation opened by keyboard, the cart
drawer open after add-to-cart, a variant picker changed, and the first modal or popup. Each is
re-checked with axe-core scoped to the changed region (PLAN §11, step 5). "Checkout is never
entered and no form with personal data is ever submitted." The domain spells the states
`nav_open`, `cart_drawer`, `variant_changed` and `modal` (`crates/domain/src/enums.rs`).

## Decision

- Four functions take a Playwright `Page` and return a `StateOutcome`: `opened` with the
  changed region's target (axe-core format) and the activated control; `not_found` with a
  typed reason (`no_trigger`, `did_not_open`, `no_product_form`, `sold_out`,
  `no_variant_picker`, `variant_unchanged`, `navigated_away`); `blocked` with the guard that
  refused; `timed_out` (default cap 10 s); or `error`. `openState(page, state)` dispatches.
- Controls are activated by keyboard: the script focuses the control and presses Enter
  (navigation toggle, add-to-cart, dialog trigger) or an arrow key (variant radio group or
  select). Discovery:
  - navigation: a closed `details > summary`, or a button with `aria-expanded="false"`, inside
    `nav`, or inside the header when it controls at least two links or is named like a menu;
    dialog triggers (`aria-haspopup="dialog"`) are excluded. Region: the opened submenu or the
    `aria-controls` target.
  - cart drawer: the first visible, enabled submit button of a form posting to `/cart/add`
    (any locale prefix), preferring forms inside `main`; a visible but disabled one is
    `sold_out`. Region: the outermost newly visible overlay that names a cart, else a dialog.
  - variant: the first radio group of two or more enabled options, or select, inside a variant
    picker, fieldset or form in `main`; visually hidden radios count when their label is
    visible. It must change the checked option or selected index. Region: the nearest
    `product-info`, `[id^="MainProduct"]`, `section` or `main`.
  - modal: a dialog already open (`dialog[open]`, `aria-modal="true"`, role `dialog` or
    `alertdialog`) is returned as it is; otherwise the first visible trigger that opens a
    dialog (`aria-haspopup="dialog"`, Dawn's `modal-opener`, `data-modal`, or `aria-controls`
    naming a dialog), excluding navigation toggles and cart controls.
- **Checkout guard**, two layers:
  1. Before activation, the probe describes the control (tag, name, resolved `href` and form
     action, whether it sits in an accelerated-checkout widget, the enabled fields of its form,
     without values) and `guardControl` refuses a control named `checkout`, inside
     `.shopify-payment-button`, `shopify-accelerated-checkout` or a buy-it-now button, or whose
     link or form action is a checkout URL: any `checkout`/`checkouts` path segment, a cart
     permalink `/cart/<variant>:<qty>`, or `/cart?checkout`.
  2. While a script runs, a page route aborts every checkout request, including a cart form
     posted with a `checkout` field (a route sees only the first URL of a redirect chain, so
     the post is stopped before its redirect, https://playwright.dev/docs/api/class-page#page-route).
     Non-matching requests fall through to the engine's own routes. Any stopped request turns
     the outcome into `blocked`, and only the origin and path are kept.
- **Personal-data guard:** a form is never submitted when any enabled field is of type
  `email`, `tel` or `password`, has a personal-data autofill token
  (https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#autofill), is named
  like personal data (email, phone, name, address, postcode, birth date, card, recipient), or
  is a line-item property with free text already filled in. The standard add-to-cart fields
  (`id`, `quantity`, `form_type`, `utf8`, `product-id`, `section-id`, `sections`,
  `sections_url`, `selling_plan`) are always allowed. The finding names the field, never its
  value.
- Browser tests prove both guards against fixtures, with the fixture server's request log as
  the witness: a submit button named `checkout` is refused with no request sent; a theme script
  that jumps to `/checkouts/...` after adding is stopped before the request reaches the
  server; a gift-card form with a filled recipient email is refused with no request sent; and
  on the product page, running all four scripts never activates "Buy it now".

## Consequences

- A state the page does not have is a typed `not_found`, which the scan reports as not
  checked rather than clean.
- A theme that navigates to the cart page after add-to-cart has no drawer; that is
  `navigated_away`, and the cart page is scanned as its own page type.
- Gift-card products are blocked whenever their recipient fields are enabled, so their cart
  drawer is not checked; that is the safe side of the guard.

## Rejected alternatives

- Clicking with the mouse: the R1 state is "opened by keyboard", and keyboard activation also
  exercises the keyboard path the custom checks care about.
- Network blocking alone: it cannot see form contents before submission; personal data must be
  stopped before the request exists.
