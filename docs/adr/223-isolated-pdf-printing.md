# ADR-223: Tagged PDFs through an isolated Chromium print

- Status: Accepted
- Date: 2026-10-18
- Stream: WS-13 (reports and statement generator)

## Context

PLAN §16: "PDFs render from HTML through Chromium's print with `tagged: true` and a document
outline, so the reports themselves are accessible." Playwright 1.64.1's `page.pdf()` has both
options (`tagged`, "Whether or not to generate tagged (accessible) PDF", and `outline`, "Whether
or not to embed the document outline into the PDF"; `playwright-core/types/types.d.ts`, read
18 October 2026), and has no timeout option of its own.

Merchant data is inside the printed page, so the page is untrusted content running in a browser
on Rampsmith's servers: it must reach neither the network (request forgery, PLAN §18) nor local
files. Probes run here on 18 October 2026 with Chromium 153.0.8010.0 from
`@sparticuz/chromium` 153.0.0 and `playwright-core` 1.64.1 (scripts in
`docs/evidence/ws-13-reports.md`):

- With `@sparticuz/chromium`'s own argument list (`chromium.args`, which `docs/ENVIRONMENT.md`
  tells sessions to use), a page set with `setContent` **loaded `file:///` iframes and objects**:
  the list includes `--disable-web-security`, `--allow-running-insecure-content` and
  `--disable-site-isolation-trials`. With only `--no-sandbox`, Chromium refused them.
- A `<meta>` content security policy of `default-src 'none'` stopped every subresource before the
  network (`context.route` saw none), but Playwright still emitted a `request` event for each
  attempt, so attempts are observable.
- A `<meta http-equiv="refresh">` navigates whatever the policy says; with the context offline it
  lands on `chrome-error://chromewebdata/`, which `page.url()` reveals.

The CI `node` job installs no Playwright browser, and this stream may not change `ci.yml`.

## Decision

1. `renderPdf(document, browser, options)` prints only a `ReportDocument` this package rendered
   (checked at run time too), through a browser the caller owns. The package declares the small
   structural interface it uses (`PdfBrowser`, `PdfContext`, `PdfPage`); the tests pass a real
   Playwright `Browser`, so the type checker proves Playwright satisfies it. No runtime
   dependency on Playwright.
2. Isolation, every layer independent of the others:
   - the document carries `default-src 'none'; style-src 'sha256-…'; img-src 'none';
     font-src 'none'; base-uri 'none'; form-action 'none'`, allowing only its own style sheet by
     hash, and contains no script, image, link, font, frame or inline style (tested);
   - the context has JavaScript off, is offline, blocks service workers and downloads, keeps the
     CSP, sends everything through a proxy nothing listens on (`http://127.0.0.1:9` with
     `<-loopback>`, which removes Chromium's implicit loopback bypass), and aborts every routed
     request;
   - any `request` event, any navigation away from `about:blank`, or any extra frame discards
     the PDF and raises `ReportRenderError`. The error carries counts only, never the URL, which
     could hold merchant data;
   - one deadline (default 60 s) covers the whole print, from opening the context to the PDF;
     a context that opens after the deadline is closed at once, and closing has its own 5 s
     limit. Every failure, including a browser crash, becomes a `ReportRenderError` naming the
     step and the error's class only, never the browser's log;
   - the layers do not depend on one another: tests turn all but one off and send an image, a
     style sheet, a font, an iframe and a prefetch at a local server. The policy alone, the
     offline flag alone and the dead proxy alone each stop all five with zero requests reaching
     the server; routing alone stops all but the prefetch, which Chromium issues outside
     Playwright's request interception (found by the security audit).
3. The output is A4 by the document's `@page` rule, or Letter on request, with `tagged: true`,
   `outline: true` and backgrounds printed. Chromium writes `/MarkInfo /Marked true`, a
   structure tree (H1–H3, P, L/LI, Table/TR/TH/TD/Caption, and a Figure per chart whose `/Alt`
   is the chart's caption and text summary), `/Outlines` nested by heading level, `/Lang`, the
   title, and `/DisplayDocTitle true`. The tests check each of these with `pdfjs-dist` 6.4.299
   and the raw catalog.
4. Tests launch Chromium 153 from `@sparticuz/chromium` 153.0.0 (a devDependency: an npm tarball
   with no lifecycle scripts, so `ci.yml`'s node job runs the browser suites after its frozen
   install), with `--no-sandbox` only, **never with `chromium.args`**. The package reuses any
   `chromium` already in the temporary directory without checking it, so the test setup
   unpacks it into a fresh private directory (mode 0700) for each run and removes it after.
   `CHROMIUM_EXECUTABLE_PATH` overrides it. Production printing uses the engine's Playwright Chromium (1.64.1 bundles
   Chromium 156.0.8078.4), which the engine already launches with `chromiumSandbox: true`.
5. Hostile-markup tests feed the isolated printer images, style sheets, CSS imports and
   backgrounds, fonts, iframes, objects and SVG images pointing at a local HTTP server and at a
   local file, a meta refresh, and a script: each is refused or inert, and the server records zero
   hits. Hostile merchant data rendered through the real renderers prints successfully, shows
   the markup as text, and fetches nothing.

## Plan correction

- PLAN §16 "Reports", PDFs bullet, append: "The print is isolated: JavaScript off, a
  fetch-nothing content security policy, an offline context that aborts every request, and the PDF
  discarded if the page tried a request or a navigation (ADR-223)."
- PLAN §18 threats table, add a row: "Report rendering: merchant data in a page printed by
  Chromium → isolated print of ADR-223; never launch a rendering browser with
  `--disable-web-security` or `--allow-file-access-from-files`."
- `docs/ENVIRONMENT.md`, Chromium row: replace "launch with ... `args: chromium.args`" with
  "launch with `args: ['--no-sandbox']`; `chromium.args` includes `--disable-web-security`,
  under which a page can read local files (ADR-223)".

## Consequences

- The PDF suites run in CI's existing node job on Chromium 153, not the Chromium 156 the engine
  ships. Tagging and outlines come from Skia's PDF backend in both; if the integrator adds a
  browser job, `CHROMIUM_EXECUTABLE_PATH` points the same tests at Playwright's build and the
  devDependency can go.
- `@sparticuz/chromium` adds a 70 MB tarball to the pnpm store for every install of the
  workspace.
- PDF text depends on the printing machine's fonts. On the GitHub runner's system fonts the
  outline titles lost their spaces ("ExampleGoods", run 39089310452), so the suites pin the
  Open Sans files `@sparticuz/chromium` ships through their own fontconfig file, and the style
  sheet turns ligatures off so text extracts and searches as typed. The image that prints
  reports in production must ship real fonts (for example Noto or Open Sans) and repeat the
  outline check.
- The engine's browser is launched with a per-context proxy; a reports context sets none and is
  offline, so printing never goes through egress.

## Rejected alternatives

- A PDF library (pdf-lib, PDFKit): no tagged structure tree from HTML; PLAN §16 names Chromium.
- Navigating to a `data:` URL instead of `setContent`: same isolation, and the HTML size limit
  of URLs.
- Sanitizing the HTML again before printing: the renderers already escape by construction
  (ADR-222); the print layer instead refuses any page that tries to fetch or navigate.
