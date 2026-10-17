# Launch-ready: scope, evidence and founder inputs

Rampsmith is launch-ready when every item in A, B and D below is done with recorded evidence,
and the only open items are the founder inputs in C. This file overrides "Current release" wording
anywhere else: the target is the full product through R2 (PLAN §5), not one release.

## A. Product scope (PLAN §5)

- [ ] **R0 Foundations**, every exit criterion.
- [ ] **R1 Private beta**, every exit criterion that does not need real merchants. "10 design-partner
      stores" and "median install-to-first-fix" are measured on development stores once C exists.
- [ ] **R2 Public launch**, every exit criterion except passing Shopify App Review, which is a
      founder submission. Everything App Review checks (PLAN §14 checklist) must already pass.

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
| 1 | Shopify Partner account and a public app | Install, auth, webhooks, billing | `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` | `rsctl doctor`, then the dev-store end-to-end suite |
| 2 | Shopify Partner API token and org id, plus the app's App Automation Token from the Dev Dashboard | Plan state through the Partner API; app deploys from CI ([Shopify CI/CD](https://shopify.dev/docs/apps/tools/cli/ci-cd)) | `SHOPIFY_PARTNER_API_TOKEN`, `SHOPIFY_PARTNER_ORG_ID`, `SHOPIFY_APP_AUTOMATION_TOKEN` | Active-subscription query; `shopify app deploy --config production --allow-updates` in CI |
| 3 | Two Shopify development stores, one with its theme on GitHub | End-to-end tests of every fix channel | `SHOPIFY_DEV_STORE_DOMAIN`, `SHOPIFY_DEV_STORE_PASSWORD` | Install, scan, fix, verify, undo suite |
| 4 | GitHub App registered from `infra/github-app-manifest.json` | Pull-request channel | `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_WEBHOOK_SECRET` | JWT to `GET /app`; pull request opened on the test theme repo |
| 5 | Anthropic API key with a monthly spend limit | Alt text, rewrites, patch proposals | `ANTHROPIC_API_KEY` | Models list; the evaluation harness runs |
| 6 | Cloudflare account: R2 buckets, Turnstile, DNS | Evidence storage, backups, free-scanner protection | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_EVIDENCE`, `R2_BUCKET_BACKUPS`, `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | Object write and read; Turnstile verification |
| 7 | Amazon SES with a verified sending domain, out of the sandbox | Transactional email | `SES_REGION`, `SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY`, `EMAIL_FROM` | Test email delivered to the founder |
| 8 | Railway project and token | Staging and production | `RAILWAY_TOKEN` | Staging deploy and synthetic journey |
| 9 | Grafana Cloud OTLP endpoint and token | Telemetry and alerts | `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS` | A trace visible end to end |
| 10 | Domain registered, DNS on Cloudflare | App, marketing site, webhooks, email | none | DNS and TLS checks |
| 11 | Stripe account (test mode first) | Billing for non-Shopify customers only, R3 | `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` | Account retrieve; test subscription lifecycle |
| 12 | Generated secrets, stored by the founder | Token encryption | `TOKEN_MASTER_KEY` (generated with `rsctl keys generate`) | Encrypt and decrypt round trip |
| 13 | Decisions and legal | Launch | none | Trademark clearance, legal entity, attorney review, final pricing, App Store submission |

Shopify merchants pay through Shopify App Pricing, so Stripe (row 11) is not needed for the
Shopify App Store launch.

## D. Final evidence pack

- [ ] `docs/evidence/LAUNCH-READINESS.md`: every item above with its evidence: CI run links on
      the pinned toolchains, test counts, coverage, performance budgets, the own-UI accessibility
      results, the `security-auditor` report, and the `release-verifier` sign-off for R0, R1 and R2.
- [ ] A one-page founder checklist: the inputs in C still missing, in the order to provide them,
      and the command to run after each one.
