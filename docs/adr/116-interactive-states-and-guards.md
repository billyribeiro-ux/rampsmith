# ADR-116: Interactive-state scripts and their guards

- Status: Accepted
- Date: 2026-10-17 (revised the same day after the security audit of `5bd9f99`: H1, M4, M5,
  L8, L9)
- Stream: WS-2 (custom checks and interactive states)

## Context

R1 scans four interactive states (PLAN §5): the main navigation opened by keyboard, the cart
drawer open after add-to-cart, a variant picker changed, and the first modal or popup. Each is
re-checked with axe-core scoped to the changed region (PLAN §11, step 5). "Checkout is never
entered and no form with personal data is ever submitted." The domain spells the states
`nav_open`, `cart_drawer`, `variant_changed` and `modal` (`crates/domain/src/enums.rs`).

The security audit found the first version's guards page-scoped and advisory. Facts checked in
playwright-core 1.64.1 (`types/types.d.ts` and its server code) and by measurement:

- a page route sees neither popups nor Service Worker requests; a route handler sees only the
  first URL of a redirect chain (https://playwright.dev/docs/api/class-page#page-route), and a
  302 fulfilled from a route was followed by Chromium without the route seeing the next hop
  (measured, `test-browser/guards.test.ts`, "meets every hop of a redirect chain");
- Chromium runs with its popup blocker off;
- `serviceWorkers: 'block'` makes Playwright replace `ServiceWorkerContainer.prototype.register`
  in every document with a stub that logs "Service Worker registration blocked by Playwright";
- `route.fetch` sends the request from Playwright with the context's proxy, or else the browser's
  launch proxy (`BrowserContextAPIRequestContext._defaultOptions`);
- the probe runs in the page's main world, where a page can read globals and replace built-ins.

Shopify's own Shop Pay helper builds same-store URLs, `/checkout?payment=shop_pay` and cart
permalinks `/cart/<variant>:<qty>?payment=shop_pay`
(https://shopify.dev/docs/api/hydrogen/latest/shop-pay/get-shop-pay-button-url). No official page
read on 2026-10-17 lists `pay.shopify.com` or `shop.app` as checkout hosts, so none are listed;
off-store hosts are refused as off-store instead (below).

## Decision

- Four functions take a Playwright `Page` and return a `StateOutcome`: `opened` with the
  changed region's target (axe-core format) and the activated control; `not_found` with a
  typed reason (`no_trigger`, `did_not_open`, `no_product_form`, `sold_out`,
  `no_variant_picker`, `variant_unchanged`, `navigated_away`); `blocked` with the guard that
  refused (`checkout`, `personal_data` or `navigation`) and a detail naming a field, origin and
  path, never a value or query; `timed_out` (default cap 10 s); or `error`. `openState(page,
  state)` dispatches.
- Controls are activated by keyboard: the script focuses the control, checks again that it
  still has focus, and presses Enter (navigation toggle, add-to-cart, dialog trigger) or an
  arrow key (variant radio group or select). After the time cap no key is pressed. Discovery:
  - navigation: a closed `details > summary`, or a button with `aria-expanded="false"`, inside
    `nav`, or inside the header when it controls at least two links or is named like a menu;
    dialog triggers (`aria-haspopup="dialog"`) and links to another document are excluded.
    Region: the opened submenu or the `aria-controls` target.
  - cart drawer: the first visible, enabled submit button of a form posting to the store's own
    `/cart/add` (any locale prefix), preferring forms inside `main`; a visible but disabled one
    is `sold_out`. Region: the outermost newly visible overlay that names a cart, else a dialog.
  - variant: the first radio group of two or more enabled options, or select, inside a variant
    picker, fieldset or form in `main`; visually hidden radios count when their label is
    visible. It must change the checked option or selected index. Region: the nearest
    `product-info`, `[id^="MainProduct"]`, `section` or `main`.
  - modal: a dialog already open is returned as it is; otherwise the first visible trigger
    that opens a dialog and stays on the page, excluding navigation toggles and cart controls.
- **Context.** Every scan context is created with `scanContextOptions()`
  (`{ serviceWorkers: 'block' }`). `guardCheckout(page)` refuses, with `GuardSetupError`, a page
  where registration is not blocked, and any service worker that appears in the context trips
  the guard. A state script turns that refusal into `blocked`.
- **Pre-activation guard** (`guardControl`, pure, unit-tested). The probe describes the control:
  tag, name, the link's resolved `href`, the effective form action and method (the
  submitter's `formaction`/`formmethod` when present, else the form's, through the reflecting
  getters, which resolve against the document's base URL), the effective target (the link's
  `target`, the submitter's `formtarget` or the form's `target`, else `<base target>`), whether
  it sits in an accelerated-checkout widget, and every enabled listed element of the form,
  custom elements included, without values. The description is validated field by field at the
  page boundary (`readControlDescription`); a malformed one is refused. The control is refused:
  - as **checkout** when it is named `checkout`, sits in `.shopify-payment-button`,
    `shopify-accelerated-checkout` or a buy-it-now button, links or posts to a checkout URL, or
    its form has a `checkout` or `return_to` field;
  - as **navigation** when its target is anything but the same window, its link or action is
    not `http(s)`, leaves the store's origin, or (for a link) leads to another document;
  - as **personal data** when its form holds any field outside an allow-list: the add-to-cart
    fields `id`, `quantity`, `form_type`, `utf8`, `product-id`, `section-id`, `sections`,
    `sections_url` and `selling_plan` (as hidden, number or text inputs); radio buttons,
    checkboxes and selects not named or autofilled like personal data
    (https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#autofill);
    buttons, fieldsets and outputs. Anything else, including every form-associated custom
    element, is refused.
- **Checkout URLs** (`isCheckoutUrl`, `isCheckoutRequest`): after decoding percent-encoding up to
  three times, any `checkout` or `checkouts` path segment; a cart permalink; a `checkout` or
  `return_to` parameter on any `/cart` URL (query or body, in urlencoded, multipart or JSON);
  and any parameter whose value is itself a checkout URL (`?redirect=/checkout`).
- **Network guard** (`guardCheckout`, installed once per context with `context.route`, kept for
  the context's life, and covering popups):
  1. every checkout request on any origin is aborted;
  2. a request with a body to a store origin is allowed only to a cart endpoint (`/cart`,
     `/cart.js`, `/cart/add`, `/cart/change`, `/cart/update`, `/cart/clear`, with or without
     `.js`), only when the body fits in 64 KB, and only when no field is named like personal
     data and no value looks like an email address or a phone number written with separators;
  3. a top-level navigation of a scanned page to another origin is aborted;
  4. every other same-store request outside the theme's static files is fetched by the guard
     with `route.fetch({ maxRedirects: 0 })`, and the guard follows each redirect itself (307
     and 308 repeat the method and body, the rest become GET), refusing a hop into checkout,
     off the store, or past 10 hops; the browser receives only the final response, so it never
     makes a request the guard has not seen. A redirected document is shown at the URL the
     browser asked for, which the scripts treat as a navigation and undo;
  5. every page in the context other than the scanned ones is closed as soon as it opens;
  6. other requests fall through to the engine's own routes and the egress proxy.
  A request stopped during a script turns its outcome into `blocked`. The engine creates scan
  contexts with `scanContextOptions()`, may call `guardCheckout` when it opens a page, and must
  give the browser its egress proxy at launch or context level so `route.fetch` uses it too.
- **Probe hardening.** The probe is installed under a random key per page, as an init script
  (before page scripts in every later document) and in the current document on first use; its
  API is frozen in a non-writable, non-configurable property. A page cannot plant a fake probe
  at a key it does not know or replace the real one. The probe still runs in the page's main
  world, so a hostile page can mislead it about its own DOM; the network guard, which runs in
  Node, is what enforces checkout, personal data and navigation.
- **Restoring the page.** When a script's key press replaced the document (a navigation, or the
  error page an aborted navigation leaves), the script waits for the guard to go idle and for
  the navigation to commit, then reloads the URL it started from before returning.
- Browser tests prove each guard against fixtures, with the loopback fixture server's request
  log as the witness (`test-browser/guards.test.ts` and `states.test.ts`): a form post
  redirected into checkout and a two-hop chain ending there are stopped before checkout is
  requested; a popup opened by the theme is closed and its checkout request stopped; a form or
  button targeting a new window is refused; a cart post carrying `return_to` is stopped; a page
  in a scan context cannot register a service worker, and a context that allows it is refused;
  a fake probe planted by the page changes nothing; a form-associated custom element is refused;
  a post to a non-cart endpoint is stopped; an off-store link is never a trigger and a scripted
  off-store navigation is stopped; a script that navigated away brings the page back; and the
  earlier guards (a button named `checkout`, a theme jumping to checkout, a filled email field,
  late checkout requests, "Buy it now") still hold.

## Consequences

- A state the page does not have is a typed `not_found`, which the scan reports as not
  checked rather than clean.
- A theme that navigates to the cart page after add-to-cart has no drawer; that is
  `navigated_away`, the page is restored, and the cart page is scanned as its own page type.
- Products whose forms carry fields outside the allow-list (gift-card recipients, engraving,
  app-added properties) are refused, so their cart drawer is not checked; that is the safe side.
- Same-store requests are fetched through Node while the guard is on, which costs time per
  request; static theme files are exempt.

## Rejected alternatives

- Clicking with the mouse: the R1 state is "opened by keyboard", and keyboard activation also
  exercises the keyboard path the custom checks care about.
- A page route: it misses popups, Service Workers and redirect hops.
- Fulfilling a redirect and letting the browser follow it: the next hop never reaches the route.
- Listing Shop Pay hosts: not found in official documentation; refusing every off-store
  navigation covers them without a list to keep current.
- A deny-list of personal-data fields: any field it misses would be submitted.
