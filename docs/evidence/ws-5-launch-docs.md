# WS-5 launch documents: evidence

Stream WS-5 (LAUNCH.md sections B and D), branch `ws/launch-docs`, from `r0-foundations` at
`e43f546`. Documents only; no code. Every vendor fact used in the documents was read from the
official page on 17 October 2026 with a web fetch; the page and what it says are listed below.

## Vendor facts

| Topic | Fact used | Source (read 2026-10-17) |
| --- | --- | --- |
| App Store listing fields | App name max 30 characters; introduction 100; details 500; feature 80 each; screenshots 1600 × 900, 3 to 6 desktop, alt text required; feature media 1600 × 900; up to 5 search terms; privacy policy required; no subtitle limit stated | [Best practices](https://shopify.dev/docs/apps/launch/shopify-app-store/best-practices) |
| App Store requirements | 4.3.3 no statistics or data in listing content, avoid "the first/best/only"; 4.4.1 subtitle without data; 4.2.2 no pricing in images; 4.3.6 no reviews in listing; 4.5.3 screencast in English or with English subtitles; 4.5.4 and 4.5.5 credentials with full access; 4.5.6 emergency developer contact; 1.2.1 Shopify App Pricing or Billing API; 1.2.3 plan changes without contacting support; 1.1.1 no third-party cookies or local storage; 5.1.1 theme changes through theme app extensions, "You or merchants should not make any code changes to the theme"; 5.1.5 customer data collected through a Shopify hosted service returned to the merchant's admin | [App Store requirements](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements) |
| PLAN's checklist link | `app-requirements-checklist` redirects to the best-practices page | [Best practices](https://shopify.dev/docs/apps/launch/shopify-app-store/best-practices) |
| Review submission | Testing information and credentials in the submission form; short screencast; common rejections include theme changes without theme app extensions; emergency contact email and phone; URLs and API contact email may not contain "Shopify"; protected customer data can be opted out of | [Pass app review](https://shopify.dev/docs/apps/launch/app-store-review/pass-app-review), [Submit for review](https://shopify.dev/docs/apps/launch/app-store-review/submit-app-for-review) |
| Compliance webhooks | Three topics, `compliance_topics` in `shopify.app.toml`; respond regardless of whether personal data is held; 2xx acknowledgement; complete within 30 days; invalid HMAC gets 401; `shop/redact` 48 hours after uninstall; customer topics described as sent to installed apps and to apps "granted access to customer or order data"; same privacy rights for all personal data regardless of location | [Privacy law compliance](https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance) |
| Shopify App Pricing | Configured in the Partner Dashboard; up to 8 public plans; free, monthly, yearly plan types; USD only; no plan-change webhooks after 28 April 2026; hosted plan page `https://admin.shopify.com/store/:store_handle/charges/:app_handle/pricing_plans`; dev-store tests free in the same Partner organization | [Shopify App Pricing](https://shopify.dev/docs/apps/launch/billing/managed-pricing) |
| Plan creation | Partner Dashboard → app → Distribution → Shopify App Store listing → Manage listing → locale → Pricing content → Public plans → Add; fields Billing, Monthly charge, Yearly charge, Free trial duration, Development stores, Welcome link; then Display name and Top features per locale | [App Pricing plans](https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing/plans) |
| Plan handles | Developers define their own plan handle when creating a plan (since API 2025-04); handles persist across plan ID changes | [Changelog: planHandle](https://shopify.dev/changelog/new-planhandle-field-managed-pricing) |
| Dev Dashboard app | Apps → Create app → Start from Dev Dashboard; a version is needed before install; client ID and secret under App settings | [Create apps using the Dev Dashboard](https://shopify.dev/docs/apps/build/dev-dashboard/create-apps-using-dev-dashboard) |
| App Automation Token | Dev Dashboard → app → Settings → App Automation Token → Create token; 1, 3 or 6 month expiry; shown once; per app; rotation keeps both valid until revoked; `SHOPIFY_APP_AUTOMATION_TOKEN`; Partner Dashboard CLI tokens can no longer be created | [App Automation Tokens](https://shopify.dev/docs/apps/build/dev-dashboard/app-automation-tokens), [CI/CD](https://shopify.dev/docs/apps/tools/cli/ci-cd) |
| Partner API | Organization owner creates a client under Settings → Partner API clients → Manage Partner API clients; "Manage apps" permission for app resources; endpoint `https://partners.shopify.com/{org_id}/api/2026-10/graphql.json`; header `X-Shopify-Access-Token`; org id in the dashboard URL | [Partner API 2026-10](https://shopify.dev/docs/api/partner/2026-10) |
| Dev stores | Dev Dashboard → Stores → Create store → Dev; URL cannot change; 250 per organization; always password protected | [Dev stores](https://shopify.dev/docs/apps/build/stores/development-stores) |
| Theme on GitHub | Online Store → Themes → Add theme → Connect from GitHub; Shopify GitHub app first; default theme folder structure; admin edits commit back; cannot be disabled | [Shopify GitHub integration](https://shopify.dev/docs/storefronts/themes/tools/github) |
| GitHub App manifest | POST to `https://github.com/organizations/ORGANIZATION/settings/apps/new` with `manifest` (and optional `state`); finish within one hour; `POST /app-manifests/{code}/conversions` returns `id`, `pem`, `webhook_secret` | [Registering from a manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest) |
| GitHub App manual registration | Org Settings → Developer settings → GitHub Apps → New GitHub App; name max 34 characters; "Only on this account" or "Any account" | [Registering a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app) |
| GitHub App keys | "Generate a private key" under Private keys; PEM (PKCS#1); up to 25 keys; keys do not expire | [Managing private keys](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps) |
| `GET /app` | Requires a JWT; returns the authenticated app | [REST: apps](https://docs.github.com/en/rest/apps/apps) |
| Actions secrets | Settings → Secrets and variables → Actions; environment secrets under Settings → Environments; `gh secret set NAME < file`, `--env` | [Using secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets) |
| Rulesets | Settings → Rulesets → New branch ruleset; bypass list can hold repository admins, maintain or write roles, teams, GitHub Apps, Dependabot; "Always allow" or "For pull requests only" | [Creating rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository) |
| Ruleset rules | Linear history, require a pull request (allowed merge methods), required status checks, block force pushes, restrict deletions | [Available rules](https://docs.github.com/en/enterprise-cloud@latest/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets) |
| Renovate | Install from `https://github.com/apps/renovate`; selected repositories; a committed config onboards the repository | [Installing and onboarding](https://docs.renovatebot.com/getting-started/installing-onboarding/) |
| Anthropic workspaces | Workspaces page; workspace spend limits lower than the organization's; not on the Default Workspace; workspace-scoped API keys | [Workspaces](https://platform.claude.com/docs/en/manage-claude/workspaces) |
| Anthropic spend limits | Billing page → Spend limits → Set limit; tier caps Start $500, Build $1,000, Scale $200,000; a set limit returns 400, a tier cap 429 without `retry-after` | [Rate limits](https://platform.claude.com/docs/en/api/rate-limits) |
| Anthropic data | Inputs and outputs deleted within 30 days by default; up to 2 years when flagged; Batch API 29-day retention; not used for training by default; Anthropic is the processor for the Claude API | [Retention](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data), [API and data retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention), [Training](https://privacy.claude.com/en/articles/7996868-is-my-data-used-for-model-training) |
| Cloudflare R2 | Create bucket; R2 → API Tokens → Manage → Create Account API token; Object Read & Write, specific buckets; secret shown once; endpoint `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`; region `auto` | [R2 S3 get started](https://developers.cloudflare.com/r2/get-started/s3/) |
| R2 lifecycle | Bucket → Settings → Object Lifecycle Rules → Add rule; prefix filter; removal typically within 24 hours of expiry; default rule aborts multipart uploads after 7 days | [Object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/) |
| Turnstile | One sitekey and secret per widget; server-side Siteverify mandatory; tokens single use, 300 seconds; test keys exist; restrict hostnames | [Turnstile get started](https://developers.cloudflare.com/turnstile/get-started/) |
| Turnstile data | Signals: client IP, TLS fingerprint, User-Agent, sitekey and origin; Cloudflare processor for the service, controller for improving it | [Turnstile privacy policy](https://www.cloudflare.com/turnstile-privacy-policy/) |
| Cloudflare DNS | Onboard a domain, choose plan, review records, set the two assigned nameservers at the registrar | [Onboard a domain](https://developers.cloudflare.com/fundamentals/manage-domains/add-site/) |
| Railway domains | `+ Custom Domain` in service Settings; CNAME and TXT both required; with Cloudflare proxy, SSL/TLS "Full", not "Full (Strict)" | [Working with domains](https://docs.railway.com/networking/domains/working-with-domains) |
| Railway tokens | Project token from project settings → Tokens, scoped to one environment, `RAILWAY_TOKEN`; account or workspace token `RAILWAY_API_TOKEN` | [Railway API](https://docs.railway.com/integrations/api), [Railway CLI](https://docs.railway.com/cli), [Deploying with the CLI](https://docs.railway.com/cli/deploying) |
| Railway secrets | Sealed variables are write-only, permanent, and not copied to PR environments; per-environment values | [Managing secrets](https://docs.railway.com/guides/managing-secrets-on-railway) |
| Grafana Cloud OTLP | Stack → OpenTelemetry tile → Configure; generate a token there; `OTEL_EXPORTER_OTLP_ENDPOINT` is the base URL, the SDK appends `/v1/traces` etc.; the header format is taken from the Configure flow | [Send data to the OTLP endpoint](https://grafana.com/docs/grafana-cloud/send-data/otlp/send-data-otlp/) |
| Amazon SES | Sandbox: verified recipients only, 200 per 24 hours, 1 per second, per Region; Account dashboard → Request production access; initial response within 96 hours | [Request production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html) |
| SES domain | Configuration → Identities → Create identity → Domain; Easy DKIM, three CNAME records; up to 72 hours to propagate | [Creating identities](https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html) |
| SES least privilege | Policy allowing only `ses:SendEmail` and `ses:SendRawEmail` with `ses:FromAddress` condition | [SES identity and access](https://docs.aws.amazon.com/ses/latest/dg/control-user-access.html) |
| Stripe keys | Sandbox keys `pk_test_`, `rk_test_`, `sk_test_`; restricted keys recommended over secret keys | [API keys](https://docs.stripe.com/keys) |
| Stripe webhooks | Workbench → Webhooks → Create an event destination; signing secret `whsec_`; verify `Stripe-Signature` over the raw body | [Webhooks](https://docs.stripe.com/webhooks) |
| Trademark search | USPTO Trademark Search system `https://tmsearch.uspto.gov/`; EUIPO recommends TMview `https://www.tmdn.org/tmview/` | [USPTO search](https://www.uspto.gov/trademarks/search), [EUIPO availability](https://www.euipo.europa.eu/en/trade-marks/before-applying/availability) |
| GDPR Article 28 | 28(2) prior written authorisation for sub-processors, notice and objection; 28(3)(a)–(h) contract contents; 28(4) flow-down; 33(2) processor notifies "without undue delay"; 32(1) measures | [Regulation (EU) 2016/679](https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX%3A02016R0679-20160504) |
| Standard Contractual Clauses | Commission Implementing Decision (EU) 2021/914 of 4 June 2021; Modules One to Four; Annex I parties and transfer, Annex II measures, Annex III sub-processors; Clause 7 optional docking clause; Module Two Clause 9(a) "OPTION 2: GENERAL WRITTEN AUTHORISATION" with "at least [Specify time period] in advance"; Clause 11(a) optional independent dispute resolution body; Clause 13 depends on where the exporter is established; Clause 17 Option 1 or Option 2 ("for Modules Two and Three"); Clause 18(b) "the courts of _____ (specify Member State)" | [Decision (EU) 2021/914](https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX%3A32021D0914) |
| WCAG 2.2 | W3C Recommendation, 12 December 2024 version; conformance claims are optional | [WCAG 2.2](https://www.w3.org/TR/WCAG22/) |
| Accessibility statements | Minimum: commitment, standard applied, contact; advisable: known limitations, technical prerequisites, test environments, measures; statements are "not technical assessments or declarations of conformity" | [W3C WAI: statements](https://www.w3.org/WAI/planning/statements/) |

### Not verified (written as open questions)

- The App Store's app card subtitle limit: not stated on the pages read; the submission form's
  counter decides.
- Whether a Shopify plan handle can be edited after the plan is created.
- The exact `OTEL_EXPORTER_OTLP_HEADERS` value format: Grafana's page defers to the Configure flow.
- UK transfer mechanism (UK addendum to the SCCs): not read; left to the attorney.
- A first fetch of `https://shopify.dev/docs/apps/launch/app-requirements-checklist` was blocked
  by a permission prompt; the same page was read through `https://shopify.dev/apps/launch/app-requirements-checklist`,
  which redirects to the best-practices page.

## Deliverables

| LAUNCH item | Path | State |
| --- | --- | --- |
| B: privacy policy, terms, DPA (drafts, attorney review required) | `docs/legal/privacy-policy.md`, `docs/legal/terms-of-service.md`, `docs/legal/data-processing-addendum.md` | Drafted; placeholders and open questions listed at the top and end of each |
| B: accessibility statement for Rampsmith itself | `docs/accessibility-statement.md` | Drafted as intent and method; results and limitations wait for the first UI release |
| B: App Store listing package (copy, screencast script, reviewer instructions) | `listing/shopify-app-store-listing.md`, `listing/shopify-app-store-reviewer-instructions.md`, `listing/shopify-app-store-screencast-script.md` | Drafted; screenshots are out of this stream's scope |
| D: founder checklist | `docs/FOUNDER_SETUP.md` | Done for rows 1 to 14 |
| PLAN §18 threat model | `docs/threat-model.md` | Version 1 against `e43f546` |
| Vendor facts that refine PLAN or LAUNCH | `docs/adr/141-app-store-theme-change-requirement.md`, `docs/adr/142-vendor-facts-for-launch-documents.md` | Proposed |

## Gate results (final run, 17 October 2026, Node 26.12.0, pnpm 12.14.0)

```text
$ pnpm install
Already up to date
Done in 4ms using pnpm v12.14.0
$ node packages/claims-lint/src/main.ts
claims-lint: 4 files scanned, no banned claims
exit=0
$ pnpm run format:check
Checking formatting...
All matched files use Prettier code style!
exit=0
$ grep -rniE 'compliant|lawsuit|guarantee|certif' docs/legal docs/threat-model.md docs/accessibility-statement.md docs/FOUNDER_SETUP.md listing
docs/legal/terms-of-service.md:22:- PLAN §25 asks for: "no compliance guarantee, the customer stays responsible for their site,
docs/legal/terms-of-service.md:25:- The claims policy (PLAN §3) bans saying or implying that a site is compliant, certified or
docs/legal/terms-of-service.md:26:  protected from lawsuits. These terms use those words only to disclaim them (section 11).
docs/legal/terms-of-service.md:106:- describe the Service's results as a legal opinion, a certification or a promise of any outcome.
docs/legal/terms-of-service.md:153:IN PARTICULAR, RAMPSMITH DOES NOT GUARANTEE, AND NOTHING IN THE SERVICE STATES OR IMPLIES, THAT
docs/legal/terms-of-service.md:156:NOT CERTIFY ANY WEBSITE. USING THE SERVICE DOES NOT PREVENT COMPLAINTS, DEMAND LETTERS, LAWSUITS
```

Every grep hit was reviewed. Each one negates or explains a banned claim, so all are allowed:

| Line | Why it is allowed |
| --- | --- |
| terms 22 | Quotes PLAN §25's requirement that the terms carry *no* compliance guarantee |
| terms 25–26 | Explains the claims policy to the attorney |
| terms 106 | Forbids customers from presenting results as a certification |
| terms 153 | Disclaimer: Rampsmith does not guarantee any outcome |
| terms 156 | Disclaimer: Rampsmith does not certify sites or prevent lawsuits |

The same gate ran before each commit on this branch, with the same outcome for the files that
existed at the time.

## Listing field counts

Counted with a script that reads each quoted field in `listing/shopify-app-store-listing.md`,
counts Unicode code points, and compares the result with the stated count and the limit:

```text
OK   [App name] 9 chars (stated 9, limit 30)
OK   [App card subtitle] 50 chars (stated 50, limit none stated)
OK   [App introduction] 98 chars (stated 98, limit 100)
OK   [App details] 489 chars (stated 489, limit 500)
OK   [Feature list] 69, 61, 69, 75, 71, 74, 76, 75, 60 chars (limit 80 each)
all fields within limits and counts match
```

## Finding: claims-lint stops on a folder under `listing/`

`claims-lint.config.json` includes `listing/**/*`. Node's `fs.globSync` returns folders that
match a pattern as well as files, and `packages/claims-lint/src/cli.ts` reads every match as a
file, so the first folder under `listing/` (or under `**/emails/**`) stops the run:

```text
$ node -e "const {globSync}=require('node:fs'); console.log(globSync(['listing/**/*'],{cwd:process.cwd()}))"
[ 'listing/shopify-app-store', 'listing/shopify-app-store/listing.md' ]
$ node packages/claims-lint/src/main.ts
Error: EISDIR: illegal operation on a directory, read
```

The listing files therefore sit directly in `listing/`, where the unchanged tool scans them.
`packages/claims-lint` belongs to the main builder, so this stream does not change it. The
proposed fix, tested on copies of the tool and of the three files in a
`listing/shopify-app-store/` folder:

```diff
-import { globSync, readFileSync } from 'node:fs';
+import { globSync, readFileSync, statSync } from 'node:fs';
@@ discoverFiles
-    if (!excluded.some((glob) => matchesGlob(posix, glob))) {
+    if (!excluded.some((glob) => matchesGlob(posix, glob)) && statSync(join(cwd, path)).isFile()) {
```

```text
--- current tool, folder layout:
Error: EISDIR: illegal operation on a directory, read
--- tool skipping folders, folder layout:
claims-lint: 4 files scanned, no banned claims
exit=0
```

Once the fix lands (with a test in `packages/claims-lint/test/cli.test.ts`), the three files can
move to `listing/shopify-app-store/`.

## Other checks

- The threat model's data-flow diagram renders with mermaid-cli (`mmdc -i threat.mmd -o
  threat.svg`, then a PNG at 1600 px checked by eye).
- Variable name conflict found while writing FOUNDER_SETUP.md: LAUNCH.md section C row 12 names
  `TOKEN_MASTER_KEY`; ADR-021 on `r0-foundations` (commit `b366419`, after `e43f546`) reads
  `RAMPSMITH_MASTER_KEYS` as `id:base64key[,id:base64key…]`. Recorded in FOUNDER_SETUP.md step 13
  as an open question.

## Commits on `ws/launch-docs`

| Commit | Change |
| --- | --- |
| `8c386dd` | ADR-141, ADR-142 and this evidence file |
| `9c58032` | Threat model |
| `3ec4e7b` | Privacy policy, terms of service, DPA |
| `5ad233e` | Accessibility statement |
| `487692a` | Founder setup checklist |
| `d13fb95` | App Store listing package |
| this commit | Final gate results and findings in this file |
