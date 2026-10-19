Draft, not published. Publishing it is the founder's decision.

# Accessibility statement for Rampsmith

## Placeholders to fill before publishing

| Placeholder | What it needs |
| --- | --- |
| `[LEGAL ENTITY]` | The company that holds the product (PLAN §25) |
| `[ACCESSIBILITY CONTACT EMAIL]` | A monitored mailbox for accessibility feedback |
| `[POSTAL ADDRESS]` | An alternative contact route |
| `[RESPONSE TIME]` | How quickly a person replies to feedback, for example 5 business days |
| `[STATEMENT DATE]` | The date of the review this statement reflects |
| `[SUPPORTED BROWSERS AND ASSISTIVE TECHNOLOGIES]` | The combinations tested in the latest release |
| `[KNOWN LIMITATIONS]` | Barriers found in the latest release and not yet fixed, each with a target date |

## Notes for the founder

- This statement follows the W3C Web Accessibility Initiative's guidance: a commitment, the
  standard applied, contact details, known limitations, technical prerequisites and the
  measures taken. W3C notes that accessibility statements are "not technical assessments or
  declarations of conformity" ([W3C WAI](https://www.w3.org/WAI/planning/statements/)).
- It states intent and method only. It makes no claim that Rampsmith conforms to WCAG
  (PLAN §3). WCAG 2.2 itself presents conformance claims as optional
  ([WCAG 2.2](https://www.w3.org/TR/WCAG22/), section 5.3).
- The testing method is PLAN §8 and §23. At the date of this draft (17 October 2026) no part of
  Rampsmith's user interface is built yet, so no results exist; the statement is ready to be
  completed with the first release's results.

---

**Statement date:** `[STATEMENT DATE]` (draft prepared 17 October 2026)

## Our commitment

`[LEGAL ENTITY]` builds Rampsmith to help merchants remove accessibility barriers from their
stores, and we hold our own product to the same standard we check for. We want everyone,
including people who use screen readers, keyboard navigation, voice control, magnification or
other assistive technology, to be able to use Rampsmith.

This statement covers:

- the Rampsmith app inside the Shopify admin;
- the Rampsmith dashboard for agencies and non-Shopify sites;
- the Rampsmith website, pricing page and free scanner;
- the reports and accessibility statements Rampsmith generates (HTML and PDF);
- the storefront elements Rampsmith adds through its optional theme app embed: an
  "Accessibility" footer link and a barrier-report form.

## The standard we work to

Our target is the Web Content Accessibility Guidelines (WCAG) 2.2, Level AA, published by the
W3C. We treat it as the minimum for every new screen and every change.

This statement is not a claim that Rampsmith conforms to WCAG 2.2. It describes what we aim for
and how we check. Automated tools find only part of all accessibility barriers, so we combine
them with keyboard and screen-reader testing by people.

## How we test

| Method | What it covers | When it runs |
| --- | --- | --- |
| Rampsmith's own scanner and axe-core, through `@axe-core/playwright` | Every route of the app, dashboard and website must report zero violations of the WCAG A and AA rules | On every code change, in continuous integration |
| Keyboard-only scripts | Every main flow, completed using the keyboard alone, with visible focus throughout | On every code change, in continuous integration |
| Component tests | Each shared interface component (buttons, links, dialogs, tabs, combobox, menus, data tables, notifications) is tested with axe and with the keyboard, following the WAI-ARIA Authoring Practices patterns | On every code change, in continuous integration |
| Screen-reader checks by a person | NVDA with Firefox and VoiceOver with Safari, through the main flows | Before every release |
| Design rules | Text contrast of at least 4.5:1 and interface boundaries of at least 3:1; a visible focus ring; reduced motion respected when the user asks for it | In the design system |
| Generated PDFs | Reports are produced as tagged PDFs with a document outline | Each report |
| Copy review | Interface text, emails and listing copy are checked so they never overstate what automated checks show | On every code change, in continuous integration |

Inside the Shopify admin, Rampsmith uses Shopify's Polaris web components so its screens behave
like the rest of the admin. Only the diff viewer and the evidence viewer are custom there, and
they are tested the same way.

## Technical prerequisites

Rampsmith works in current versions of major web browsers and relies on HTML, CSS, JavaScript and
WAI-ARIA. Pages render on the server and work before JavaScript loads.

Tested combinations in the latest release: `[SUPPORTED BROWSERS AND ASSISTIVE TECHNOLOGIES]`.

## Known limitations

`[KNOWN LIMITATIONS]`

Parts we do not control:

- The Shopify admin around the Rampsmith app, including its navigation and App Bridge elements,
  is provided by Shopify.
- The free scanner uses Cloudflare Turnstile to stop automated abuse; Cloudflare provides that
  widget. If it blocks you, contact us using the details below.
- Content that merchants or third-party apps add to a storefront is outside Rampsmith's control;
  Rampsmith reports issues it finds there to the merchant.

## Feedback and contact

If you find a barrier in Rampsmith, or need information in a different format, tell us:

- Email: `[ACCESSIBILITY CONTACT EMAIL]`
- Post: `[POSTAL ADDRESS]`

A person will reply within `[RESPONSE TIME]`. We log every report and tell you what we will do
about it and when.

## How we keep this statement current

We review this statement at every Rampsmith release and update the date above. Each review adds
the latest test results and any new known limitations.
