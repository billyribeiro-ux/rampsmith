# ADR-221: The merchant accessibility statement: structure, status and wording

- Status: Accepted
- Date: 2026-10-18
- Stream: WS-13 (reports and statement generator)

## Context

R1 ships an accessibility statement generator (PLAN §5), and job 5 of PLAN §3 is "an honest
accessibility statement". The merchant publishes the statement on the store, so it must follow
current guidance on what a statement contains, and it must never say or imply that a store is
compliant, certified or protected (PLAN §3 claims policy), nor present automated results as a
complete evaluation. Guidance read on 18 October 2026:

- **W3C WAI, "Developing an Accessibility Statement"** (https://www.w3.org/WAI/planning/statements/,
  updated 11 March 2021). Minimum: a commitment to accessibility, the standard applied (such as
  WCAG 2.2) and a way to contact the organization. Recommended: known limitations, measures taken,
  technical requirements such as compatible browsers, the environments tested, and the laws and
  policies that apply. It says statements "are not technical assessments or declarations of
  conformity" and should ideally refer to such background.
- **W3C WAI generator and complete example** (https://www.w3.org/WAI/planning/statements/generator/,
  updated 20 May 2025; https://www.w3.org/WAI/planning/statements/complete-example/). Sections:
  measures to support accessibility, conformance status (fully, partially, non conformant, or not
  assessed; "Partially conformant means that some parts of the content do not fully conform to
  the accessibility standard"), additional considerations, feedback with a response time,
  compatibility with browsers and assistive technology, technical specifications, limitations
  and alternatives, assessment approach, evaluation report, formal approval, formal complaints,
  and the date the statement was created.
- **EU model accessibility statement**, Commission Implementing Decision (EU) 2018/1523
  (https://legislation.gov.uk/eudn/2018/1523/adopted). Mandatory: the commitment, the scope,
  the compliance status (fully, partially or not compliant, with the standard named), the
  non-accessible content and why (non-compliance, disproportionate burden, out of scope) with
  accessible alternatives, the preparation of the statement (date, method: self-assessment or
  third-party assessment, optional last review date), feedback and contact information, and the
  enforcement procedure. It applies to public-sector bodies, but it is the EU's reference
  structure.
- **European Accessibility Act**, Directive (EU) 2019/882, Article 13(2)
  (https://www.legislation.gov.uk/eudr/2019/882/chapter/IV/data.htm): service providers "shall
  prepare the necessary information in accordance with Annex V and shall explain how the
  services meet the applicable accessibility requirements", available to the public in written
  and oral format, accessible, and kept "for as long as the service is in operation". Annex V
  asks for a general description of the service in accessible formats, the explanations needed
  to understand how it operates, and how the service meets the Annex I requirements (as quoted
  by iubenda's EAA guide, https://www.iubenda.com/en/help/181644-european-accessibility-act-eaa-accessibility-statement-guide-template,
  updated 31 March 2026). The requirements apply from 28 June 2025 (same source).

`claims-lint` (PLAN §3) bans "compliant", "compliance", "conformant", "conformance" and
"conforms" in every user-facing string, so neither the W3C nor the EU status wording can be
used as written.

## Decision

1. The statement follows the W3C generator's section order, which also covers every mandatory
   item of the EU model: introduction and scope; measures we take; status against WCAG 2.2
   Level AA; known limitations; feedback and contact; technical information; how we checked
   (with the coverage disclosure of ADR-225); formal complaints when the merchant gives a route;
   the date prepared and the date last reviewed.
2. The standard is always WCAG 2.2 Level AA. The status is computed, never chosen by the
   merchant, and has three values:
   - `not_evaluated`: no scan has results. "Our automated checks have not yet evaluated {site}
     against WCAG 2.2 Level AA." (W3C "not assessed".) Evaluations the merchant lists under
     "How we checked" still appear; the status speaks only for the automated checks.
   - `known_barriers`: an open or accepted-risk finding, a failed check, or a limitation the
     merchant entered. "{site} partially meets WCAG 2.2 Level AA: some of its content does not
     meet the standard yet." (W3C's definition of "partially conformant".)
   - `no_known_barriers`: the latest automated checks found nothing. The statement says that
     automated checks cannot test every criterion, "so this does not show that {site} meets the
     standard in full", and points to the criteria that need a person.
   There is no "fully meets" status. Rampsmith's evidence is automated checks plus whatever the
   merchant reports, which cannot support it; a merchant with an expert audit lists it under
   "How we checked" (`otherEvaluations`), and the status still never claims full conformance.
3. Every evaluated statement says how many automated checks passed ("passed 1,198 of 1,250
   automated WCAG 2.2 Level AA checks", the claims policy's own form), states the axe-core
   figure for what automation finds, and lists the coverage disclosure.
4. Known limitations list the merchant's own entries first (description, why, alternative,
   planned fix date: the EU model's "non-accessible content" with alternatives), then the open
   and accepted-risk findings, merged when they read the same, most severe first, with their
   criteria and the number of places found. More than 50 are counted, not listed. Findings marked
   false positive, fixed or waiting for review are not listed.
5. Feedback needs at least one route (email, phone, post or an online form, such as the theme app
   embed's barrier-report form); the input is refused without one, because W3C and the EU model
   both make it mandatory.
6. Three outputs from one block model: a full HTML document (preview and PDF), an HTML fragment
   starting at h2 for the merchant's store page, and plain text. The merchant's own words
   (measures, limitations, compatibility, complaints route) are passed through as escaped text.
7. The statement is written in the merchant's voice ("we") and is not legal advice. EAA Annex V
   information beyond the statement (a description of the service and how it operates) belongs
   in the merchant's terms; the statement does not claim it covers Annex V.

## Plan correction

- PLAN §5, R1 detail, add: "The accessibility statement has three computed statuses (not yet
  evaluated; partially meets WCAG 2.2 AA with known barriers; no failures found by automated
  checks, which is not a statement of full conformance). There is no 'fully meets' status
  (ADR-221)."
- PLAN §3, claims policy table, add a row: Never "fully conformant", "conformance status";
  Use instead "Status against WCAG 2.2 Level AA: partially meets" with the known barriers listed.
- PLAN §16 "Reports", add: "Accessibility statement: HTML document, store-page fragment and plain
  text, structured after the W3C WAI generator and the EU model statement (ADR-221)."

## Consequences

- A merchant cannot publish a statement that overstates its status: the status comes from the
  data and the wording is fixed in the catalog, which `claims-lint` checks in CI.
- A statement with no barriers found still reads as partial evidence, which is honest and may
  disappoint merchants who want a stronger line; the listing and onboarding copy must set that
  expectation.
- EU-language statements (R3) are a new catalog per language (ADR-222); the structure already
  covers the EU model's mandatory items.

## Rejected alternatives

- Letting the merchant pick the status, as the W3C generator does: it would allow "fully".
- Using the W3C or EU terms with a `claims-lint` allow marker: the claims policy forbids the
  claim, not just the word, and a computed "fully" would still be a claim automation cannot back.
