DRAFT — attorney review required. Not published.

# Rampsmith Data Processing Addendum

## Placeholders to fill before review

| Placeholder | What it needs | Who decides |
| --- | --- | --- |
| `[LEGAL ENTITY]` | The company that holds the product (PLAN §25) | Founder |
| `[REGISTERED ADDRESS]` | Postal address | Founder |
| `[PRIVACY CONTACT EMAIL]` | Contact for data protection matters and incident notices | Founder |
| `[EFFECTIVE DATE]` | Date this addendum is offered (PLAN §19: offered to every customer from R2) | Founder |
| `[GOVERNING LAW FOR THE SCCs]` | An EU Member State whose law allows third-party beneficiary rights (SCC Clause 17) | Attorney |
| `[FORUM FOR THE SCCs]` | Courts of an EU Member State (SCC Clause 18) | Attorney |
| `[COMPETENT SUPERVISORY AUTHORITY]` | For Annex I.C (SCC Clause 13) | Attorney |
| `[AUDIT NOTICE AND FREQUENCY]` | Notice period and how often the customer may audit | Attorney and founder |
| `[SUBPROCESSOR LOCATIONS]` | The processing location of each subprocessor, from each vendor's own DPA | Founder, from vendor contracts |
| `[UK AND SWISS TRANSFER TERMS]` | The UK and Swiss mechanisms that apply, if any | Attorney |

## Notes for the reviewing attorney

- Structure follows GDPR Article 28(3), points (a) to (h), with Article 28(2) and 28(4) for
  sub-processors and Article 33(2) for breach notice (Regulation (EU) 2016/679, read on EUR-Lex
  on 17 October 2026).
- Transfers use the Standard Contractual Clauses in Commission Implementing Decision (EU)
  2021/914 of 4 June 2021, Module Two (controller to processor) and Module Three (processor to
  processor, for an agency that is itself a processor for its clients).
- Data categories, retention and subprocessors come from PLAN §19; security measures from PLAN
  §18 and §22. Annex II lists them as designed; `docs/threat-model.md` shows which are built.
  Each measure must be in place before this addendum is offered.

---

**Effective date:** `[EFFECTIVE DATE]`

This Data Processing Addendum ("DPA") forms part of the Rampsmith terms of service between the
customer ("Customer") and `[LEGAL ENTITY]`, `[REGISTERED ADDRESS]` ("Rampsmith"). It applies when
Rampsmith processes Customer Personal Data on the Customer's behalf.

## 1. Definitions

- **Data Protection Law**: the GDPR (Regulation (EU) 2016/679), the UK GDPR and any other data
  protection law that applies to the processing.
- **Customer Personal Data**: personal data in the store content, theme files, scan evidence,
  barrier reports and notification addresses that Rampsmith processes for the Customer.
- **Subprocessor**: a third party Rampsmith engages to process Customer Personal Data.
- **Security Incident**: a breach of security leading to the accidental or unlawful destruction,
  loss, alteration, unauthorised disclosure of, or access to, Customer Personal Data.
- **SCCs**: the Standard Contractual Clauses in the annex to Commission Implementing Decision
  (EU) 2021/914.

## 2. Roles

The Customer is the controller of Customer Personal Data, or a processor acting for its own
clients (for example, an agency managing client stores). Rampsmith is the Customer's processor,
or sub-processor where the Customer is itself a processor. Rampsmith is a controller only for
its own account, billing, website and free-scanner data, which its privacy policy covers.

## 3. Details of processing (GDPR Article 28(3), first subparagraph)

Annex I sets out the subject matter, duration, nature and purpose of the processing, the types of
personal data and the categories of data subjects.

## 4. Rampsmith's obligations

**4.1 Documented instructions (Article 28(3)(a)).** Rampsmith processes Customer Personal Data
only on the Customer's documented instructions, including for transfers to a third country.
These terms, this DPA and the Customer's use of the Service's settings and approvals are the
Customer's instructions. If the law requires other processing, Rampsmith tells the Customer
first, unless that law forbids it on important grounds of public interest. Rampsmith tells the
Customer at once if it believes an instruction infringes Data Protection Law (Article 28(3),
last subparagraph).

**4.2 Confidentiality (Article 28(3)(b)).** Everyone Rampsmith authorises to process Customer
Personal Data is bound by confidentiality or a statutory duty of secrecy.

**4.3 Security (Article 28(3)(c), Article 32).** Rampsmith implements the technical and
organisational measures in Annex II and keeps them appropriate to the risk.

**4.4 Subprocessors (Article 28(2), 28(3)(d), 28(4)).**

- The Customer gives Rampsmith general written authorisation to engage the subprocessors listed
  in Annex III.
- Rampsmith gives the Customer at least 30 days' notice, by email and on its website, before
  adding or replacing a subprocessor, so the Customer can object on reasonable data protection
  grounds. If an objection cannot be resolved, the Customer may end the affected service and
  receive a pro-rata refund of prepaid fees for it. `[Attorney: confirm the remedy.]`
- Rampsmith binds each subprocessor by written contract to data protection obligations no less
  protective than this DPA, and remains fully liable to the Customer for each subprocessor's
  performance of those obligations.

**4.5 Data subject requests (Article 28(3)(e)).** Rampsmith helps the Customer answer requests
from data subjects, by appropriate technical and organisational measures where possible:

- the Customer can export and delete data in the Service without contacting Rampsmith;
- Rampsmith acts on Shopify's `customers/data_request`, `customers/redact` and `shop/redact`
  requests within 30 days of receiving them, as Shopify requires;
- if a data subject contacts Rampsmith directly about Customer Personal Data, Rampsmith refers
  them to the Customer and tells the Customer, unless the law forbids it.

**4.6 Assistance with Articles 32 to 36 (Article 28(3)(f)).** Taking into account the nature of
the processing and the information available to it, Rampsmith helps the Customer with security,
Security Incident notification, data protection impact assessments and prior consultation.

**4.7 Security Incidents (Article 33(2)).** Rampsmith notifies the Customer without undue delay
after becoming aware of a Security Incident, and aims to do so within 24 hours of confirming it.
The notice describes, as far as then known, the nature of the incident, the categories and
approximate number of data subjects and records concerned, the likely consequences, and the
measures taken or proposed. Rampsmith adds information as it becomes available.

**4.8 Return and deletion (Article 28(3)(g)).** At the end of the Service, the Customer can export
its remediation record. For a Shopify store, Rampsmith deletes Customer Personal Data within 30
days of Shopify's `shop/redact` request, which Shopify sends 48 hours after the app is
uninstalled. For other customers, Rampsmith deletes it within 30 days of the account's closure.
Rampsmith keeps only what the law requires it to keep. Copies in encrypted backups expire on the
backup schedule in Annex II and are used only to restore the Service.

**4.9 Information and audits (Article 28(3)(h)).** Rampsmith makes available the information
needed to demonstrate compliance with Article 28, and allows for and contributes to audits,
including inspections, by the Customer or an auditor the Customer mandates, on
`[AUDIT NOTICE AND FREQUENCY]`. Rampsmith may first offer its most recent penetration test
summary and this DPA's annexes to answer the request.

## 5. International transfers

- Where Customer Personal Data is transferred from the European Economic Area to a country
  without an adequacy decision, the parties enter into the SCCs, which are incorporated by
  reference: Module Two where the Customer is a controller, Module Three where the Customer is a
  processor. The Customer is the data exporter and Rampsmith the data importer.
- Choices in the SCCs: Clause 7 (docking clause) applies; Clause 9(a) Option 2 (general written
  authorisation) applies, with the 30-day notice in section 4.4; the optional wording in Clause
  11(a) does not apply; Clause 13: `[COMPETENT SUPERVISORY AUTHORITY]`; Clause 17:
  `[GOVERNING LAW FOR THE SCCs]`; Clause 18(b): `[FORUM FOR THE SCCs]`.
- Annexes I, II and III of this DPA are Annexes I, II and III of the SCCs.
- Transfers from the United Kingdom or Switzerland: `[UK AND SWISS TRANSFER TERMS]`.
- If the SCCs conflict with this DPA, the SCCs prevail.

## 6. Liability and order of precedence

Each party's liability under this DPA is subject to the limitations in the terms of service, to
the extent Data Protection Law allows. If this DPA conflicts with the terms of service, this DPA
prevails for the processing of Customer Personal Data.

---

## Annex I: Description of the processing

### A. Parties

- **Data exporter:** the Customer, as identified in its account. Role: controller, or processor
  for its clients.
- **Data importer:** `[LEGAL ENTITY]`, `[REGISTERED ADDRESS]`, `[PRIVACY CONTACT EMAIL]`. Role:
  processor or sub-processor.

### B. Description of transfer

| Item | Description |
| --- | --- |
| Categories of data subjects | The Customer's staff and collaborators who use the Service; shoppers who choose to submit a barrier report through the Customer's storefront; individuals who appear in or are named in store content (for example, product images or descriptions) |
| Categories of personal data | Names and email addresses of users and notification recipients; barrier-report contents, including an email address if the shopper gives one; personal data that happens to be present in store content, theme files, screenshots and page snapshots (snapshots are scrubbed of form values, email addresses and phone number patterns before storage) |
| Sensitive data | None intended. Rampsmith requests no customer or order data from Shopify, never enters checkout and never submits storefront forms that carry personal data |
| Frequency | Continuous while the Service is in use |
| Nature of processing | Collection through the Shopify Admin API and public page loads; storage; automated accessibility analysis; drafting fixes, partly with AI; writing approved fixes back to store data; preparing code changes; email notifications; deletion |
| Purpose | Providing the Service under the terms of service: finding accessibility barriers, proposing and applying approved fixes, verifying them, and keeping the remediation record |
| Retention | Store content: while installed. Theme snapshots: 30 days rolling. Screenshots and page snapshots: 90 days rolling, except before-and-after evidence attached to a fix. Remediation record and audit log: life of the account. Barrier reports: 12 months, deletable by the Customer. All deleted within 30 days of `shop/redact` or account closure, except billing records the law requires |
| Transfers to subprocessors | As listed in Annex III, for the role stated there |

### C. Competent supervisory authority

`[COMPETENT SUPERVISORY AUTHORITY]`

## Annex II: Technical and organisational measures

Measures as designed in PLAN §18, §19 and §22. `[Before offering this DPA: confirm each measure
is in place; see docs/threat-model.md.]`

| Area | Measure |
| --- | --- |
| Encryption in transit | TLS on every public endpoint; HTTP redirects to HTTPS |
| Encryption at rest | Application-level encryption of Shopify access and refresh tokens and storefront passwords with per-record data keys (AES-256-GCM) wrapped by a master key held only in the hosting environment; provider encryption at rest for the database and object storage |
| Tenant isolation | Each customer's rows are isolated by PostgreSQL row-level security and by tenant-scoped queries in the application; database roles used by the application cannot bypass row-level security; an automated isolation test suite runs on every code change |
| Access to evidence | Evidence files reachable only through signed links valid for 5 minutes, issued after an authorization check; storage keys prefixed by tenant |
| Data minimisation | No customer or order scopes requested from Shopify; page snapshots scrubbed before storage; only an image, product title and type, or the relevant source text sent to the AI provider; no prompt content stored |
| Scanner containment | Browser traffic passes through a proxy that refuses loopback, private, link-local, carrier-grade NAT, unique-local and IPv4-mapped addresses; browser sandbox on; non-root containers |
| AI safeguards | AI models receive no tools and no secrets; output must match a schema; nothing AI-written is applied without human approval |
| Logging | Logs and telemetry carry identifiers only, no personal data, tokens or store content; logs kept 30 days |
| Integrity of records | The audit log is append-only at the database level |
| Access control | Production access limited to named operators; cross-customer access only through an audited operator tool; hardware security keys on vendor accounts |
| Availability and recovery | Point-in-time recovery of the database (about 4 weeks); nightly encrypted logical backups kept 30 days (daily) and 12 months (monthly) in separate storage; quarterly restore drills; recovery targets of at most 5 minutes of lost data and 4 hours to restore |
| Secure development | Dependency lockfiles; minimum release age before upgrades; license and advisory checks; software bill of materials and vulnerability scan for every image; pinned build actions |
| Testing | External penetration test before the R3 release and yearly after; weekly automated web scan of staging |
| Incident response | Incident runbook with severity levels; customer notification target of 24 hours after confirming an incident; blameless postmortems |

## Annex III: Subprocessors

Changed only with 30 days' notice (section 4.4). Source: PLAN §19.

| Subprocessor | Service | Personal data | Location |
| --- | --- | --- | --- |
| Railway | Hosting and database | Account data, store content | United States region at launch (PLAN §22); `[SUBPROCESSOR LOCATIONS]` |
| Cloudflare | Object storage (R2) for evidence and backups; Turnstile on the free scanner | Evidence files; visitor IP address for Turnstile | `[SUBPROCESSOR LOCATIONS]` |
| Anthropic | AI drafts and proposed fixes | None by design: images and product or page text only. Anthropic states it deletes API inputs and outputs within 30 days by default, keeps Batch API data 29 days, and does not train on commercial inputs and outputs by default | `[SUBPROCESSOR LOCATIONS]` |
| Amazon Web Services (Amazon SES) | Transactional email | Recipient email addresses | `[SUBPROCESSOR LOCATIONS]` (the SES Region chosen in LAUNCH.md row 7) |
| GitHub | Pull requests, only for customers who connect a repository | Commit metadata | `[SUBPROCESSOR LOCATIONS]` |
| Grafana Labs | Telemetry | None by design | `[SUBPROCESSOR LOCATIONS]` |
| Stripe (from R3, for customers not billed through Shopify) | Billing | Billing contact | `[SUBPROCESSOR LOCATIONS]` |

Shopify is the platform the Customer uses and the billing channel for Shopify merchants; it is
not engaged by Rampsmith to process Customer Personal Data. `[Attorney: confirm.]`

---

## Open questions for the attorney and founder

1. The objection remedy in section 4.4 and the audit terms in section 4.9.
2. Whether to include Module Three by default or offer it only to agencies.
3. UK International Data Transfer Addendum and Swiss adjustments.
4. Each subprocessor's processing location and transfer mechanism, taken from its own DPA.
5. Whether an agency's dashboard access to a client store (PLAN §16) needs its own clause.
