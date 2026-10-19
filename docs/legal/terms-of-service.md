DRAFT — attorney review required. Not published.

# Rampsmith terms of service

## Placeholders to fill before review

| Placeholder | What it needs | Who decides |
| --- | --- | --- |
| `[LEGAL ENTITY]` | The company that holds the product (PLAN §25) | Founder |
| `[ENTITY TYPE AND STATE OR COUNTRY OF FORMATION]` | For example, a limited liability company and where it is formed | Founder |
| `[REGISTERED ADDRESS]` | Postal address for legal notices | Founder |
| `[LEGAL NOTICES EMAIL]` and `[SUPPORT EMAIL]` | Monitored mailboxes | Founder |
| `[DOMAIN]` | The registered domain (LAUNCH.md section C, row 10) | Founder |
| `[EFFECTIVE DATE]` | The date these terms are published | Founder |
| `[GOVERNING LAW]` | The state or country whose law governs these terms | Attorney and founder |
| `[VENUE]` | Courts or arbitration body for disputes, and whether to include arbitration or a class-action waiver | Attorney and founder |
| `[NOTICE PERIOD FOR PRICE CHANGES]` | How much notice before a price change takes effect | Founder |
| `[NOTICE PERIOD FOR TERMS CHANGES]` | How much notice before changed terms take effect | Attorney |

## Notes for the reviewing attorney

- PLAN §25 asks for: "no compliance guarantee, the customer stays responsible for their site,
  liability capped at fees paid in the prior 12 months, no legal advice, scanning only sites the
  customer owns or controls". Sections 3, 4, 11 and 12 carry those points.
- The claims policy (PLAN §3) bans saying or implying that a site is compliant, certified or
  protected from lawsuits. These terms use those words only to disclaim them (section 11).
- Plans and prices are PLAN §20, approved by the founder on 17 October 2026. Shopify merchants
  pay through Shopify App Pricing (ADR-008); Stripe billing for other customers starts in a
  later release (R3).
- Product behaviour described here (merchant approval, undo, no theme writes, preview scans) is
  PLAN §12 and ADR-004. Several parts are not built yet; publish only once they are.
- Section 5 describes a copy of the theme that the customer installs as an unpublished theme. Shopify's
  App Store requirement 1.1.3 ("Your app must not allow merchants to download themes") may rule that
  channel out of the App Store build (ADR-141); if the founder retires it, delete that sentence.

---

**Effective date:** `[EFFECTIVE DATE]`

These terms are an agreement between you (the "Customer") and `[LEGAL ENTITY]`, a
`[ENTITY TYPE AND STATE OR COUNTRY OF FORMATION]` ("Rampsmith", "we"), for the Rampsmith
Shopify app, dashboard, free scanner and website at `[DOMAIN]` (together, the "Service"). By
installing the app, creating an account or using the free scanner, you agree to these terms. If
you accept them for a company, you confirm you can bind it.

## 1. What the Service does

Rampsmith runs automated checks against WCAG 2.2 Level A and AA success criteria, ranks what it
finds, proposes fixes, applies the fixes you approve to your store's data, prepares code changes
for your developer to review, and keeps a dated record of findings, fixes, approvals and
verification scans.

## 2. What automated checks can and cannot do

Automated tools detect only part of all accessibility barriers. Many WCAG success criteria need
a person to judge them. Each Rampsmith report lists which criteria were checked automatically,
which only partly, and which need human review. A clean automated result does not mean a site
has no barriers.

## 3. No legal advice

Rampsmith is a software tool. Nothing in the Service, its reports, its accessibility statement
generator or our support is legal advice. Accessibility statements the Service generates are
drafts for you to review and publish under your own name. If you need advice about your legal
obligations, consult a lawyer.

## 4. Your responsibilities

- **Your site stays yours.** You remain responsible for your website, its content, its theme,
  any third-party apps on it, and its accessibility.
- **Only sites you own or control.** You may scan only websites you own or are authorized to
  manage. Rampsmith scans only sites verified as yours: a Shopify store where the app is
  installed, or a domain verified by a DNS record or meta tag. The free scanner's limits are in
  section 7.
- **You approve every change.** No fix reaches your store data until you approve it, and no code
  change reaches your theme unless you or your developer merge or publish it. Review each
  proposed change, including every AI-drafted text, before approving it.
- **Accurate information.** Keep your account and notification details current, and keep your
  sign-in credentials safe.

## 5. How changes reach your store

- **Store data fixes** (such as image alt text, product descriptions, pages and menus) are
  written through Shopify's Admin API after you approve them. Each one can be undone with one
  click, as long as nobody has changed that field since.
- **Code fixes** are prepared as a pull request against a GitHub repository you connect, or as a
  copy of your theme with the fixes applied that you can install as an unpublished theme.
  Rampsmith never writes to your theme files, never merges a pull request, and never publishes a
  theme. Your original theme stays in your theme library.
- **Verification.** After a fix is applied, Rampsmith re-scans to confirm the finding is gone and
  nothing new appeared, and records the result.

## 6. AI-drafted content

Some proposals are drafted by AI models from Anthropic. AI drafts can be wrong. They are labelled
as AI-drafted and are never applied without a person's approval. Section 4 of our privacy policy
explains what data is sent.

## 7. Acceptable use

You must not:

- scan, or ask us to scan, a website you do not own or are not authorized to manage;
- use the free scanner beyond its published limits, or to overload any website;
- try to get around plan limits, rate limits, authentication or bot protection;
- use the Service to send unlawful, harmful or deceptive content;
- probe, scan or test the Service's security without our written permission;
- copy, resell or reverse engineer the Service, except where the law allows it;
- describe the Service's results as a legal opinion, a certification or a promise of any outcome.

Rampsmith never solves or evades bot challenges on the sites it scans. If a site blocks the
scanner, the scan is reported as blocked.

## 8. Plans, billing and changes to plans

- **Plans.** The current plans are listed on our pricing page and in the Shopify App Store. At
  the effective date: Free ($0), Starter ($79 a month or $790 a year), Growth ($199 a month or
  $1,990 a year) and Pro ($499 a month or $4,990 a year), in US dollars, each with the limits
  shown on the pricing page.
- **Shopify merchants** are billed by Shopify through Shopify App Pricing. Shopify's terms govern
  that payment relationship, and charges appear on your Shopify bill. You can upgrade or
  downgrade at any time from Shopify's plan page, without contacting us.
- **Other customers** (available in a later release) are billed through Stripe in advance for
  each billing period.
- **Taxes.** Prices exclude taxes unless stated; taxes are charged where required.
- **Price changes.** We will give at least `[NOTICE PERIOD FOR PRICE CHANGES]` notice before a
  price change takes effect. The new price applies from your next billing period.
- **Refunds.** `[Founder: refund policy, if any, beyond what Shopify App Pricing provides.]`

## 9. Your content and our software

- **Your content.** You own your store content, theme code, scan targets and everything the
  Service produces for you, including fixes and reports ("Customer Content"). You give us the
  rights we need to host, copy, analyze and change Customer Content only to provide the Service
  to you, as described in our privacy policy and Data Processing Addendum.
- **Our software.** We own the Service, its software, rules, recipes and documentation. We give
  you a non-exclusive, non-transferable right to use the Service during your subscription.
- **Feedback.** If you send us ideas or feedback, we may use them without obligation to you.
- **Open-source components.** The Service includes open-source software under its own licenses,
  listed in our open-source notices.

## 10. Data protection

Our privacy policy explains how we handle personal data. Where we process personal data on your
behalf, our Data Processing Addendum, including the Standard Contractual Clauses where they
apply, forms part of these terms.

## 11. Disclaimers

`[Attorney: confirm wording and conspicuousness requirements.]`

THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE". TO THE EXTENT THE LAW ALLOWS, WE DISCLAIM ALL
WARRANTIES, EXPRESS OR IMPLIED, INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NON-INFRINGEMENT.

IN PARTICULAR, RAMPSMITH DOES NOT GUARANTEE, AND NOTHING IN THE SERVICE STATES OR IMPLIES, THAT
ANY WEBSITE IS ACCESSIBLE TO EVERY USER, CONFORMS TO WCAG OR ANY OTHER STANDARD, OR MEETS THE
AMERICANS WITH DISABILITIES ACT, THE EUROPEAN ACCESSIBILITY ACT OR ANY OTHER LAW. RAMPSMITH DOES
NOT CERTIFY ANY WEBSITE. USING THE SERVICE DOES NOT PREVENT COMPLAINTS, DEMAND LETTERS, LAWSUITS
OR REGULATORY ACTION, AND RAMPSMITH MAKES NO PROMISE ABOUT THEIR OUTCOME.

## 12. Limitation of liability

`[Attorney: confirm enforceability and carve-outs.]`

TO THE EXTENT THE LAW ALLOWS:

- NEITHER PARTY IS LIABLE FOR INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL OR PUNITIVE DAMAGES,
  OR FOR LOST PROFITS, REVENUE OR DATA, EVEN IF TOLD THEY WERE POSSIBLE.
- RAMPSMITH'S TOTAL LIABILITY FOR ALL CLAIMS RELATING TO THE SERVICE IS LIMITED TO THE FEES YOU
  PAID FOR THE SERVICE IN THE 12 MONTHS BEFORE THE EVENT THAT GAVE RISE TO THE CLAIM. FOR THE
  FREE PLAN AND THE FREE SCANNER, THAT AMOUNT IS ZERO DOLLARS `[Attorney: confirm or set a
  nominal amount]`.

## 13. Indemnity

You will defend and indemnify Rampsmith against third-party claims arising from websites you
directed us to scan without authority, from content you supplied, or from your breach of section
7. `[Attorney: confirm scope and procedure.]`

## 14. Suspension and termination

- You can stop using the Service at any time by uninstalling the app or deleting your account.
- We may suspend or end your access if you breach these terms, if your use puts the Service or
  others at risk, or if the law requires it. Where practical, we will tell you first.
- **After termination,** you can export your remediation record until your data is deleted. For
  Shopify stores, deletion follows Shopify's `shop/redact` request, which Shopify sends 48 hours
  after uninstall; we delete the data within 30 days of that request. Sections 3, 9, 11, 12, 13,
  15 and 16 survive termination.

## 15. Third-party services

The Service works with Shopify, GitHub and other third-party services. Their own terms govern
your use of them. We are not responsible for third-party services, or for third-party apps or
code on your site, which Rampsmith reports but does not change.

## 16. General

- **Governing law and disputes:** `[GOVERNING LAW]`; `[VENUE]`.
- **Changes to these terms:** we will post changes with a new effective date and give at least
  `[NOTICE PERIOD FOR TERMS CHANGES]` notice of a material change. Continuing to use the Service
  after that means you accept the change.
- **Entire agreement:** these terms, the privacy policy and the Data Processing Addendum are the
  whole agreement about the Service.
- **Assignment:** you may not assign these terms without our consent; we may assign them as
  part of a merger or sale of the business.
- **Severability and waiver:** an unenforceable term is limited to the minimum extent; not
  enforcing a term is not a waiver.
- **Notices:** to us at `[LEGAL NOTICES EMAIL]` and `[REGISTERED ADDRESS]`; to you at your
  account or notification email.

## 17. Contact

`[LEGAL ENTITY]`, `[REGISTERED ADDRESS]`, `[SUPPORT EMAIL]`

---

## Open questions for the attorney and founder

1. Whether to add arbitration, a class-action waiver, or a minimum liability amount for free use.
2. Refund policy for paid plans, given Shopify App Pricing handles the charge.
3. Agency terms: PLAN §20 leaves agency commercial terms to the launch-strategy session; these
   terms cover an agency only as a dashboard user.
4. Whether the generated accessibility statement needs its own disclaimer text inside the
   statement itself.
