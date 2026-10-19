# Launch-ready: scope, evidence and founder inputs

The build is complete when every item in A, B and D below is done with recorded evidence and the
only open items are the founder inputs in C and the live checks in E. Rampsmith is launch-ready
once the founder has added those inputs and every check in E passes. The founder's accounts come
last (his decision, 17 Oct 2026), so builders never wait for them. This file overrides "Current
release" wording anywhere else: the target is the full product through R2 (PLAN §5), not one release.

## A. Product scope (PLAN §5)

- [ ] **R0 Foundations**, every exit criterion.
- [ ] **R1 Private beta**, every exit criterion. A criterion that needs a founder input passes on a
      substitute now and moves its live check to E; "10 design-partner stores" and "median
      install-to-first-fix" are measured on development stores in E.
- [ ] **R2 Public launch**, every exit criterion except passing Shopify App Review, which is a
      founder submission in E. Everything App Review checks (PLAN §14 checklist) must already
      pass, and a criterion that needs a founder input passes on a substitute now, with its live
      check in E.

## B. Launch extras that are not features but block launch

- [ ] Marketing site, pricing page, free scanner (PLAN §16), all passing Rampsmith's own scanner.
- [ ] Privacy policy, terms of service and Data Processing Addendum as drafts marked
      "attorney review required" (PLAN §25). Never published without founder approval.
- [ ] Accessibility statement for rampsmith itself.
- [ ] App Store listing package: copy that passes `claims-lint`, screenshots captured from the
      running app, a demo screencast script, and reviewer test instructions.
- [ ] `rsctl doctor`: validates every founder input against the live service and prints PASS or
      FAIL per input (for example: the Anthropic key lists models; the R2 keys write and read an
      object; the GitHub App JWT reaches `GET /app`; Stripe test keys retrieve the account).
- [ ] Deployment as configuration: Railway service definitions, Dockerfiles, the CI and release
      workflows, migrations as a pre-deploy step. Deploy steps skip with an explicit notice
      when their secrets are absent, and never pretend to pass.
- [ ] Runbooks in `docs/runbooks/` (PLAN §22), plus a scripted restore drill.
- [ ] Onboarding and transactional email templates, plain-text and HTML, passing `claims-lint`.

## C. Founder inputs (only the founder can create these)

Secrets go into **GitHub Actions secrets** (for CI and end-to-end tests) and **Railway
variables** (for runtime). Never into the repository or a chat.

| # | Input | Needed for | Variables | How the code proves it works |
| --- | --- | --- | --- | --- |
| 1 | Shopify Partner organization with the founder as owner, and the production app, created with `shopify app config link` once builders commit `shopify.app.toml`. Public distribution cannot be undone. | Install, auth, webhooks, billing | `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` | `rsctl doctor`, then the dev-store end-to-end suite |
| 2 | Partner API client (only an organization owner can create one; Manage apps permission only) and org id, plus the app's App Automation Token from the Dev Dashboard, which expires after 1, 3 or 6 months and is shown once | Plan state through the Partner API; app deploys from CI ([Shopify CI/CD](https://shopify.dev/docs/apps/tools/cli/ci-cd)) | `SHOPIFY_PARTNER_API_TOKEN`, `SHOPIFY_PARTNER_ORG_ID`, `SHOPIFY_APP_AUTOMATION_TOKEN` (a GitHub environment secret in each environment), `SHOPIFY_APP_GID` (`gid://shopify/App/<id>`, the Partner API app id; ADR-131) | Active-subscription query; `shopify app deploy --config production --allow-updates` in CI |
| 3 | Two Shopify development stores, store B with its theme connected to GitHub, and a test GitHub organization holding that theme repository | End-to-end tests of every fix channel | Store A: `SHOPIFY_DEV_STORE_DOMAIN`, `SHOPIFY_DEV_STORE_PASSWORD`; store B: `SHOPIFY_DEV_STORE_B_DOMAIN`, `SHOPIFY_DEV_STORE_B_PASSWORD` | Install, scan, fix, verify, undo suite |
| 4 | Public GitHub App registered from `infra/github-app-manifest.json` with the builders' registration helper, which completes GitHub's manifest flow inside its one-hour limit | Pull-request channel | `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID` (ADR-122), `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_WEBHOOK_SECRET` | JWT to `GET /app`; pull request opened on the test theme repo |
| 5 | Anthropic API key with a monthly spend limit | Alt text, rewrites, patch proposals | `ANTHROPIC_API_KEY` | Models list; the evaluation harness runs |
| 6 | Cloudflare account: the R2 subscription, two buckets and a token scoped to them, a Turnstile widget, DNS. The founder sets the evidence bucket's 90-day lifecycle rule in the dashboard, because the bucket token cannot. | Evidence storage, backups, free-scanner protection | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_EVIDENCE`, `R2_BUCKET_BACKUPS`, `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | Object write and read; Turnstile verification |
| 7 | Amazon SES with a verified sending domain, out of the sandbox | Transactional email | `SES_REGION`, `SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY`, `EMAIL_FROM` | Test email delivered to the founder |
| 8 | Railway project with `staging` and `production` environments and one project token per environment (a project token works in one environment only). Creating the services, PostgreSQL with point-in-time recovery, custom domains and PR environments needs either a workspace token or the founder's dashboard steps from the builders' list. | Staging and production | `RAILWAY_TOKEN` (a GitHub environment secret in each environment); optional `RAILWAY_API_TOKEN` (workspace token) | Staging deploy and synthetic journey |
| 9 | Grafana Cloud OTLP endpoint and token. The free tier keeps logs 14 days; PLAN §21's 30 days come from the R2 log archive unless the founder picks Grafana Pro. | Telemetry and alerts | `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_EXPORTER_OTLP_PROTOCOL` | A trace visible end to end |
| 10 | Domain registered, DNS on Cloudflare, and an inbox on the domain through Cloudflare Email Routing. The founder adds the DNS records unless he gives builders a DNS-scoped Cloudflare token. | App, marketing site, webhooks, email | optional `CLOUDFLARE_API_TOKEN` (DNS edit on the zone) | DNS and TLS checks |
| 11 | Stripe account (test mode first) | Billing for non-Shopify customers only, R3 | `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` | Account retrieve; test subscription lifecycle |
| 12 | Generated secrets, stored by the founder | Token encryption | `RAMPSMITH_MASTER_KEYS`, a key ring `id:base64key[,id:base64key…]`, newest first (ADR-021), generated with `rsctl keys generate` | Encrypt and decrypt round trip |
| 13 | Decisions and legal | Launch | none | Trademark clearance, legal entity, attorney review (including whether Dawn theme files may serve as test fixtures, since Dawn's licence limits use to developing themes), App Store submission (the founder enters the App Pricing plans, the emergency contact, and payout and tax details in the Partner Dashboard). The PLAN §20 pricing is approved as written (17 Oct 2026). |
| 14 | GitHub repository settings: environments `staging` and `production` with the founder as required reviewer (PLAN §24), branch protection on `main`, and the Renovate GitHub App | Deploy approvals, merge protection, dependency updates (raised in pull request #1) | none | Required checks `rust`, `node` and `contracts`, linear history and squash merges on `main`; Renovate opens its first pull request. Branch protection must still let the scheduled STATUS.md commits reach `main`. |
| 15 | Staging copies of the Shopify app (with its own App Automation Token) and of the GitHub App, because each app has one set of URLs and one webhook endpoint | Staging environment | The same names as rows 1, 2 and 4, set in the Railway `staging` environment and the GitHub `staging` environment | The staging journey installs the staging app |

Steps for every row, checked against the vendors' documentation on 17 Oct 2026: `docs/FOUNDER_SETUP.md`.

Shopify merchants pay through Shopify App Pricing, so Stripe (row 11) is not needed for the
Shopify App Store launch.

## D. Final evidence pack

- [ ] `docs/evidence/LAUNCH-READINESS.md`: every item above with its evidence: CI run links on
      the pinned toolchains, test counts, coverage, performance budgets, the own-UI accessibility
      results, the `security-auditor` report, and the `release-verifier` sign-off for R0, R1 and R2.
- [ ] The founder checklist, `docs/FOUNDER_SETUP.md`: the inputs in C still missing, in the order
      to provide them (longest approval waits first), and the command to run after each one.

## E. Live checks, run once the founder adds the inputs in C

A check that needs an input from C counts toward A or B only when all three hold:
1. A substitute test passes in CI now: a fake, a recorded fixture of the vendor's documented
   responses, or a local service container.
2. The live test exists, runs whenever the input is present, and otherwise skips with a notice
   naming the input's row in C. It never passes silently.
3. It has a row in this table with the command that runs it live.

| Live check | Inputs (C) | Substitute test now | Live command |
| --- | --- | --- | --- |
| `rsctl doctor`: every input validated against its live service | 1 to 12 | Each probe against a fake of its service | `rsctl doctor` |
| Shopify dev store wired (R0): the store's domain, the token endpoint, the form and the error mapping, live (an expired, signed ID token must come back as Shopify's documented 400, never as rejected credentials; it does not prove the secret, which the first install does; ADR-031). The founder runs it: CI gets no secrets | 1, 3 | wiremock token-exchange and session-token tests in `crates/shopify` | `cargo nextest run -p rampsmith-shopify --test live_dev_store` |
| Dev-store end to end: install, scan, fix, verify and undo on every fix channel | 1 to 5 | Admin GraphQL operations checked against the 2026-10 schema and recorded responses | Builders add it with the suite |
| R1 measures: 10 design-partner stores, install-to-first-fix median under 10 minutes, at least 80% of alt-text drafts approved unedited | 1, 3, 5 | The install flow and the alt-text pipeline on fakes and recorded responses | Builders add it with R1 |
| Plan state on a development store: each plan selected on the hosted page, the redirect's `plan_handle`, `activeSubscription` returning that handle, Free and cancellation as ADR-131 models | 1, 2, 3 | `cargo test -p rampsmith-billing` on recorded fixtures | Builders add it with the suite |
| Staging deploy and the synthetic install-scan-fix journey | 8, 10 and the inputs the journey uses | The release images build, start and pass their smoke tests in CI | Builders add it with the deploy workflow |
| Shopify App Review | 1, 13 | The PLAN §14 App Review checklist passes | The founder submits the app for review |
