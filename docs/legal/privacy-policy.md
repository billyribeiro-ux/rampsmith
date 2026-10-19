DRAFT — attorney review required. Not published.

# Rampsmith privacy policy

## Placeholders to fill before review

| Placeholder | What it needs | Who decides |
| --- | --- | --- |
| `[LEGAL ENTITY]` | The legal name of the company that holds the product (PLAN §25: "Decide which legal entity holds the product") | Founder |
| `[ENTITY TYPE AND STATE OR COUNTRY OF FORMATION]` | For example, a limited liability company and where it is formed | Founder |
| `[REGISTERED ADDRESS]` | Postal address for privacy requests | Founder |
| `[PRIVACY CONTACT EMAIL]` | A monitored mailbox for privacy requests | Founder |
| `[DOMAIN]` | The registered domain (LAUNCH.md section C, row 10) | Founder |
| `[EFFECTIVE DATE]` | The date this policy is published | Founder |
| `[EU REPRESENTATIVE]` and `[UK REPRESENTATIVE]` | Whether GDPR Article 27 or the UK equivalent requires a representative, and who | Attorney |
| `[GOVERNING LAW]` | Only if the attorney wants one stated here; the terms of service carry it | Attorney |
| `[FREE-SCANNER EMAIL RETENTION]` | How long a free-scanner lead's email is kept after double opt-in; PLAN.md sets no period | Founder |
| `[RATE-LIMIT IP RETENTION]` | How long IP addresses used for the free scanner's daily caps are kept; PLAN.md sets no period | Founder |

## Notes for the reviewing attorney

- Sources: PLAN.md §19 (data inventory, retention, subprocessors, rules), §18 (security), §13
  (AI data handling), §16 (free scanner), §22 (backups) and §25 (legal setup), plus the vendor
  pages listed in `docs/evidence/ws-5-launch-docs.md`, read on 17 October 2026.
- This draft describes the practices PLAN.md specifies for the public launch (release R2).
  Several are not built yet; `docs/threat-model.md` marks each control built or planned. The
  founder publishes only after each practice described here is confirmed in the running product.
- Rampsmith's roles (PLAN §19): a processor for store data it handles on a merchant's behalf,
  and a controller for its own users' account and billing data, for website visitors, and for
  free-scanner leads. Please confirm this split, especially for barrier reports that shoppers
  submit through the merchant's storefront.
- Open questions are collected at the end.

---

**Effective date:** `[EFFECTIVE DATE]`

This policy explains what personal data `[LEGAL ENTITY]` ("Rampsmith", "we") collects when you
use the Rampsmith Shopify app, the Rampsmith dashboard, the free scanner and the website at
`[DOMAIN]`, why we collect it, how long we keep it, and the choices you have.

## 1. Who we are and our role

`[LEGAL ENTITY]`, a `[ENTITY TYPE AND STATE OR COUNTRY OF FORMATION]`, at `[REGISTERED ADDRESS]`,
provides Rampsmith: software that checks websites against automated WCAG 2.2 AA tests, proposes
fixes, applies the fixes a merchant approves to store data, and keeps a dated remediation record.

- **When we process store data for a merchant** (products, media, pages, menus, theme files,
  scan evidence and barrier reports), we act on the merchant's instructions as a **processor**.
  The merchant decides why that data is processed. Our Data Processing Addendum governs this.
- **When we process data about our own users, website visitors and free-scanner leads**, we act
  as a **controller**.

## 2. What we collect, why, and how long we keep it

| Data | Where it comes from | Why we use it | How long we keep it |
| --- | --- | --- | --- |
| Store content: products, media metadata, pages, blogs and menus | The Shopify Admin API, with the merchant's permission | Running accessibility checks and applying the fixes the merchant approves | While the app is installed; deleted after Shopify's `shop/redact` request (see section 8) |
| Theme file snapshots | The Shopify Admin API, read only | Finding where a problem sits in the theme's source and preparing code fixes | 30 days on a rolling basis; deleted after `shop/redact` |
| Screenshots and page snapshots from scans | Our scanner loading the store's public pages | Showing the merchant the evidence for each finding | 90 days on a rolling basis, except before-and-after evidence attached to a fix, which stays with the remediation record |
| Remediation record and audit log | Our system | The merchant's dated record of what was found, fixed, approved and verified | For the life of the account; the merchant can export it at any time |
| Barrier reports from shoppers (only if the merchant turns on the optional form) | The shopper, through a form on the merchant's storefront | Passing the report to the merchant | 12 months; the merchant can delete a report at any time |
| Dashboard accounts: email address and passkeys | You, when you sign up | Signing you in | Until you delete your account |
| Store notification email address | The merchant, in the app's settings | Sending scan results, alerts and the export link after uninstall | Until the merchant changes it; deleted after `shop/redact` |
| Storefront password (only for password-protected stores) | The merchant | Letting our scanner open the store's pages | While the app is installed; stored encrypted |
| Records of AI calls: model, token counts, cost | Our system | Controlling cost and quality | 13 months; we do not store the prompt content |
| Billing records | Shopify (for Shopify merchants) and, from a later release, Stripe (for other customers) | Accounting | As long as tax law requires |
| Free scanner: the website address you enter and the results | You | Showing you a short automated report | Results are cached for 24 hours per domain |
| Free scanner: your email address (only if you ask for the full report and confirm by email) | You | Sending you the full report you asked for | `[FREE-SCANNER EMAIL RETENTION]` |
| IP address of free-scanner visitors | Your browser | Enforcing daily scan limits; bot protection by Cloudflare Turnstile (section 5) | `[RATE-LIMIT IP RETENTION]` |
| Service logs | Our services | Running and securing the service | 30 days; logs are designed to contain no personal data, tokens or store content |
| Telemetry | Our services | Measuring performance and reliability | Carries account identifiers only, never names, email addresses or store content |

### What we do not collect

- The Rampsmith app requests no access to the store's customer or order data from Shopify.
- Our scanner never enters checkout and never submits a storefront form that carries personal
  data. Before a page snapshot is stored, we remove form values, email addresses and phone
  number patterns from it.
- We use no third-party analytics, advertising pixels or session replay anywhere in the product.
  Website analytics are cookieless and run on our own servers, and we set only cookies that are
  strictly necessary (for example, to keep you signed in).
- We do not sell personal data and do not share it for advertising.

## 3. Why we are allowed to use your data

`[Attorney: confirm the legal bases and any US state-law notices.]` Where the GDPR or a similar
law applies to data we control, we rely on:

- **Performing our contract with you**: running your account, the scans you ask for, and billing.
- **Our legitimate interests**: keeping the service secure, preventing abuse of the free
  scanner, and improving reliability, balanced against your rights.
- **Your consent**: sending the full free-scanner report and any follow-up email. You can
  withdraw consent at any time with the link in every email.
- **Legal obligations**: keeping billing records and answering lawful requests.

For store data we process as a processor, the merchant is responsible for having a legal basis.

## 4. AI processing

Rampsmith uses Anthropic's Claude models to draft alt text, rewrite headings and link text in
product descriptions and pages, and propose code fixes.

- We send only what each task needs: a product image, the product title and type, or the
  relevant piece of page or theme source. We never send customer data.
- Nothing an AI drafts reaches a store or a theme until a person approves it.
- Anthropic states that, by default, it does not use inputs or outputs from its commercial
  products to train its models, and that it deletes API inputs and outputs within 30 days of
  receipt or generation. Anthropic keeps Batch API data for 29 days, and may keep data longer
  where the law requires or where its automated safety systems flag content (up to 2 years).
  Sources: Anthropic's privacy center and API data-retention documentation.

## 5. Who we share data with

We use the service providers ("subprocessors") below. Each receives only the data its role
needs. We publish this list on our website and give customers 30 days' notice before adding or
replacing a subprocessor.

| Provider | Role | Personal data it may receive |
| --- | --- | --- |
| Railway | Hosting and database | Account data, store content |
| Cloudflare | Object storage (R2) for evidence files and backups; Turnstile bot protection on the free scanner | Evidence files; for Turnstile, the visitor's IP address, TLS fingerprint and browser user agent |
| Anthropic | AI drafts and proposed fixes | None by design: images and product or page text only |
| Amazon Web Services | Transactional email (Amazon SES) | Recipient email addresses |
| GitHub | Pull requests, only when a customer connects a repository | Commit metadata |
| Grafana Labs | Telemetry | None by design |
| Stripe (from a later release, for customers who do not use Shopify) | Billing | Billing contact |

Cloudflare states that it acts as a processor of Turnstile signals to provide the service and as
a controller when it uses them to improve Turnstile (Cloudflare's Turnstile privacy policy).

**Shopify.** Merchants install Rampsmith through Shopify, and Shopify bills Shopify merchants for
their Rampsmith plan through Shopify App Pricing. Shopify's own privacy policy covers the data
Shopify holds. `[Attorney: confirm how Shopify should be described; PLAN §19 does not list it as
a Rampsmith subprocessor.]`

We may also disclose personal data when the law requires it, to protect the security of the
service or our users, or as part of a merger or sale of the business, in which case this policy
continues to apply to the data transferred.

## 6. International transfers

Rampsmith runs in a United States region of Railway at launch. When we transfer personal data
from the European Economic Area, the United Kingdom or Switzerland, we rely on the European
Commission's Standard Contractual Clauses (Commission Implementing Decision (EU) 2021/914),
included in our Data Processing Addendum, or another lawful mechanism.
`[Attorney: confirm the UK and Swiss mechanisms.]`

## 7. How we protect data

- TLS on every public endpoint.
- Shopify access and refresh tokens and storefront passwords are encrypted in our application
  with a separate key for each record, and those keys are protected by a master key held only in
  our hosting environment.
- Each customer's data is isolated in our database by row-level security, and our test suite
  checks that one customer's data cannot be read through another customer's account.
- Evidence files are reachable only through links that expire after 5 minutes and are issued
  after an access check.
- Our scanner's browser reaches only the public internet through a proxy that refuses internal
  network addresses.
- Access to production systems is limited and logged.

No method of storage or transmission is perfectly secure. If a security incident affects your
data, we will notify affected customers without undue delay; our internal target is 24 hours
from confirming the incident.

## 8. Shopify merchants, uninstalling and deletion

- **Uninstalling.** When a merchant uninstalls the app, we stop scanning, cancel pending work and
  revoke our access tokens. We email the shop owner a link to export the remediation record.
- **Deleting the store's data.** Shopify sends us a `shop/redact` request 48 hours after
  uninstall. Within 30 days of receiving it, we delete all of the shop's data except billing
  records the law requires us to keep. The export link expires when the data is deleted.
- **Requests from a store's customers.** Shopify can send us `customers/data_request` and
  `customers/redact` requests. Because the app requests no customer data from Shopify, the only
  shopper data we may hold is a barrier report a shopper chose to submit. Within 30 days we send
  the merchant any reports that carry that shopper's email address, or delete them, as Shopify
  requests. A shopper can also ask the merchant to delete a report, or contact us directly.
- **Backups.** Deleted data can remain in our encrypted backups until they expire. Backups are
  kept for 30 days (daily) and 12 months (monthly), and are used only to restore the service.
  `[Attorney: confirm this disclosure meets the deletion rules that apply.]`

## 9. Your rights

Depending on where you live, you may have the right to access, correct, delete, export or
restrict the use of your personal data, to object to processing based on legitimate interests,
and to withdraw consent.

- **Dashboard users** can export and delete their own account data in the dashboard, without
  contacting us.
- **Shoppers** who submitted a barrier report should contact the merchant, who controls that
  report. We will help the merchant respond.
- **Anyone** can write to `[PRIVACY CONTACT EMAIL]`. We answer within 30 days. We extend the same
  rights to everyone, wherever they live.
- If you are in the EEA or the UK, you can complain to your data protection authority.
  `[EU REPRESENTATIVE]`, `[UK REPRESENTATIVE]`

## 10. Children

Rampsmith is a business service and is not directed to children. We do not knowingly collect
personal data from children.

## 11. Changes to this policy

We will post any change on this page with a new effective date, and notify customers by email
before a material change takes effect.

## 12. Contact

`[LEGAL ENTITY]`, `[REGISTERED ADDRESS]`, `[PRIVACY CONTACT EMAIL]`

---

## Open questions for the attorney and founder

1. Controller or processor for barrier reports: the shopper submits the report through the
   merchant's storefront and Rampsmith passes it to the merchant (PLAN §19). This draft treats
   Rampsmith as the merchant's processor for it.
2. Shopify's privacy page says the customer compliance topics are sent to apps installed on the
   store and also to apps "granted access to customer or order data"; Rampsmith requests no such
   access (ADR-142). Section 8 therefore also offers the merchant and a direct contact as routes.
3. Retention periods PLAN.md does not set: free-scanner lead emails and rate-limit IP addresses.
4. Whether the 12-month monthly backup retention (PLAN §22) needs a shorter period or a
   suppression list so restored backups do not revive deleted data.
5. US state privacy-law notices (for example, California) and whether any apply at launch.
6. UK and Swiss transfer mechanisms, and whether an Article 27 representative is needed.
