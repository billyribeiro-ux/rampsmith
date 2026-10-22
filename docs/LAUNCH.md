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

Secrets go into **Railway variables** (runtime) and, only for a workflow that needs one, into a
**secret of a GitHub environment** that only `main` can deploy to (`staging`, `production`,
`backup-drill`). There are no repository or organization secrets: the `secrets-scope` job of
`ci.yml` fails when a founder secret name exists at that level, because every workflow of every
branch, and every pull request, could read it (ADR-092). Never into the repository or a chat.

| # | Input | Needed for | Variables | How the code proves it works |
| --- | --- | --- | --- | --- |
| 1 | Shopify Partner organization with the founder as owner, and the production app, created with `shopify app config link` once builders commit `shopify.app.toml`. Public distribution cannot be undone. | Install, auth, webhooks, billing | `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` | `rsctl doctor`, then the dev-store end-to-end suite |
| 2 | Partner API client (only an organization owner can create one; Manage apps permission only) and org id, plus the app's App Automation Token from the Dev Dashboard, which expires after 1, 3 or 6 months and is shown once | Plan state through the Partner API; app deploys from CI ([Shopify CI/CD](https://shopify.dev/docs/apps/tools/cli/ci-cd)) | `SHOPIFY_PARTNER_API_TOKEN`, `SHOPIFY_PARTNER_ORG_ID`, `SHOPIFY_APP_AUTOMATION_TOKEN` (a GitHub environment secret in each environment), `SHOPIFY_APP_GID` (`gid://shopify/App/<id>`, the Partner API app id; ADR-131) | Active-subscription query; `shopify app deploy --config production --allow-updates` in CI |
| 3 | Two Shopify development stores, store B with its theme connected to GitHub, and a test GitHub organization holding that theme repository | End-to-end tests of every fix channel | Store A: `SHOPIFY_DEV_STORE_DOMAIN`, `SHOPIFY_DEV_STORE_PASSWORD`; store B: `SHOPIFY_DEV_STORE_B_DOMAIN`, `SHOPIFY_DEV_STORE_B_PASSWORD` | Install, scan, fix, verify, undo suite |
| 4 | Public GitHub App registered from `infra/github-app-manifest.json` with the builders' registration helper, which completes GitHub's manifest flow inside its one-hour limit | Pull-request channel | `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID` (ADR-122), `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_WEBHOOK_SECRET` | JWT to `GET /app`; pull request opened on the test theme repo |
| 5 | Anthropic API key with a monthly spend limit | Alt text, rewrites, patch proposals | `ANTHROPIC_API_KEY` | Models list; the evaluation harness runs |
| 6 | Cloudflare account: the R2 subscription, two buckets, **three tokens** that each cover one job (the engine's: Object Read & Write on the evidence bucket only, here; the backup service's: Object Read & Write on the backups bucket only; the restore drill's: Object Read only on the backups bucket; the last two are row 16), a Turnstile widget, DNS. The founder sets the evidence bucket's 90-day lifecycle rule in the dashboard, because the bucket token cannot. | Evidence storage, backups, free-scanner protection | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (the engine's token), `R2_BUCKET_EVIDENCE`, `R2_BUCKET_BACKUPS`, `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | Object write, read and delete on the evidence bucket; the same token refused on the backups bucket (the engine never needs to reach it); Turnstile verification |
| 7 | Amazon SES with a verified sending domain, out of the sandbox | Transactional email | `SES_REGION`, `SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY`, `EMAIL_FROM` | Test email delivered to the founder |
| 8 | Railway project with `staging` and `production` environments and one project token per environment (a project token works in one environment only). Creating the services (including the `backup` cron service), PostgreSQL with point-in-time recovery, custom domains and PR environments needs either a workspace token or the founder's dashboard steps from the builders' list. | Staging and production | `RAILWAY_TOKEN` (a secret of the GitHub environment `staging` and of `production`, each with its own token); optional `RAILWAY_API_TOKEN` (workspace token): kept by the founder, stored in neither GitHub nor Railway, because no workflow or service reads it | Staging deploy and synthetic journey |
| 9 | Grafana Cloud OTLP endpoint and token. The free tier keeps logs 14 days; PLAN §21's 30 days come from the R2 log archive unless the founder picks Grafana Pro. | Telemetry and alerts | `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_EXPORTER_OTLP_PROTOCOL` | A trace visible end to end |
| 10 | Domain registered, DNS on Cloudflare, and an inbox on the domain through Cloudflare Email Routing. The founder adds the DNS records unless he gives builders a DNS-scoped Cloudflare token. | App, marketing site, webhooks, email | optional `CLOUDFLARE_API_TOKEN` (DNS edit on the zone) | DNS and TLS checks |
| 11 | Stripe account (test mode first) | Billing for non-Shopify customers only, R3 | `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` | Account retrieve; test subscription lifecycle |
| 12 | Generated secrets, stored by the founder | Token encryption | `RAMPSMITH_MASTER_KEYS`, a key ring `id:base64key[,id:base64key…]`, newest first (ADR-021), generated with `rsctl keys generate` | Encrypt and decrypt round trip |
| 13 | Decisions and legal | Launch | none | Trademark clearance, legal entity, attorney review (including whether Dawn theme files may serve as test fixtures, since Dawn's licence limits use to developing themes), App Store submission (the founder enters the App Pricing plans, the emergency contact, and payout and tax details in the Partner Dashboard). The PLAN §20 pricing is approved as written (17 Oct 2026). |
| 14 | GitHub repository settings: environments `staging` and `production` with the founder as required reviewer (PLAN §24), the environment `backup-drill` (row 16), all three limited to deployments from `main`; branch protection on `main`; and the Renovate GitHub App | Deploy approvals, merge protection, dependency updates (raised in pull request #1) | none | Required checks `rust`, `node` and `contracts` on `main`, squash and merge commits allowed, linear history not required (ADR-034); Renovate opens its first pull request; the `secrets-scope` job of `ci.yml` is green. Branch protection must still let the scheduled STATUS.md commits reach `main`. |
| 15 | Staging copies of the Shopify app (with its own App Automation Token) and of the GitHub App, because each app has one set of URLs and one webhook endpoint | Staging environment | The same names as rows 1, 2 and 4, set in the Railway `staging` environment (the App Automation Token also in the GitHub `staging` environment) | The staging journey installs the staging app |
| 16 | The nightly backup and the weekly restore drill (ADR-090 to ADR-093). The Railway cron service `backup` (declared in `infra/railway`, 02:17 UTC) with its own R2 token (row 6: Object Read & Write, backups bucket only), a PostgreSQL login `rampsmith_backup` (read-only, `BYPASSRLS`), at least two age public keys (one offline) and the offline private key. For the weekly drill in GitHub: the environment `backup-drill` (deployments limited to `main`, no required reviewer) holding the drill's R2 token (Object Read only) and the private key, and the repository variable `BACKUP_DRILL_READY` set to `true` once both are in place | Disaster recovery (PLAN §22) | `BACKUP_R2_ACCESS_KEY_ID`, `BACKUP_R2_SECRET_ACCESS_KEY`, `BACKUP_DB_PASSWORD`, `BACKUP_AGE_RECIPIENTS` (public keys, not secret) as Railway variables of the `backup` service; `DRILL_R2_ACCESS_KEY_ID`, `DRILL_R2_SECRET_ACCESS_KEY`, `BACKUP_DRILL_AGE_KEY` as secrets of `backup-drill` only | `rsctl doctor --row 16` (the backup token writes, the drill token reads and is refused a write, the inputs are well formed); the first nightly run stores the archive and its metadata; the weekly `restore-drill` workflow restores the newest staging backup |

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
| `rsctl doctor`: every input validated against its live service, with the three R2 tokens each proved for its own job (the engine's refused on the backups bucket, the drill's refused a write) | 1 to 12, 16 | Each probe against a fake of its service; the R2 fake models a token's bucket and read-only scope | `rsctl doctor` |
| Secret placement: no founder secret exists as a repository or organization secret, and the guide, the workflows and `rsctl` agree on where each goes | 14 | `crates/rsctl/tests/secret_placement.rs` (the job's list equals rsctl's; only the listed workflows read a founder secret; FOUNDER_SETUP sends nothing to a repository secret) | The `secrets-scope` job of the latest `ci` run on `main` is green; Settings > Secrets and variables > Actions lists no founder secret name |
| Nightly backup service: the first scheduled run on Railway writes the encrypted archive and its metadata over the private network, and a second run prunes by the retention rules. Records how Railway reports a cron deployment of the image (the deploy workflow only warns about it, ADR-090) | 6, 8, 16 | `infra/backup/tests/run.sh` against a PostgreSQL 18 server and a stand-in bucket; the image's smoke test in `release.yml`; the Railway IaC tests | In Railway, trigger one run of the `backup` service (`railway cron --help` lists the commands; syntax not verified), then list the backups bucket with the drill token (`infra/restore-drill/list-backups.sh --environment staging`) |
| Live restore drill: the newest real staging backup restores in a fresh PostgreSQL 18 within the RTO, in a job that can read only the drill's read-only token and the offline key | 6, 8, 14, 16 | The drill and negative cases on a fixture; the live job's hand-off against a stand-in bucket and container (`infra/backup/tests/run.sh`); the environment check's unit tests | Set `BACKUP_DRILL_READY` to `true`, then `gh workflow run restore-drill.yml`; the `live restore (staging)` job passes after `drill-scope` and `drill-protection`. Until then the run shows the warning `live restore drill skipped` naming row 16 |
| Shopify dev store wired (R0), live: the store's domain reaches Shopify's HTTPS token endpoint, and an expired, signed ID token comes back as 400, never as rejected credentials (403) or a token. It proves neither the form (the wiremock substitute does) nor the secret (the first install does); ADR-031. The founder runs it: CI gets no secrets | 1, 3 | wiremock token-exchange and session-token tests in `crates/shopify` | `cargo nextest run -p rampsmith-shopify --test live_dev_store` |
| Dev-store end to end: install, scan, fix, verify and undo on every fix channel | 1 to 5 | Admin GraphQL operations checked against the 2026-10 schema and recorded responses | Builders add it with the suite |
| R1 measures: 10 design-partner stores, install-to-first-fix median under 10 minutes, at least 80% of alt-text drafts approved unedited | 1, 3, 5 | The install flow and the alt-text pipeline on fakes and recorded responses | Builders add it with R1 |
| Plan state on a development store: each plan selected on the hosted page, the redirect's `plan_handle`, `activeSubscription` returning that handle, Free and cancellation as ADR-131 models | 1, 2, 3 | `cargo test -p rampsmith-billing` on recorded fixtures | Builders add it with the suite |
| Staging deploy and the synthetic install-scan-fix journey | 8, 10 and the inputs the journey uses | The release images build, start and pass their smoke tests in CI | Builders add it with the deploy workflow |
| Free scanner bot protection and scan path: Cloudflare accepts the Turnstile secret key and rejects a made-up token; then the widget renders on `/scan` and a real scan returns a result once the engine accepts anonymous scans (ADR-260, ADR-261) | 6 (and the engine side of ADR-260) | `tests/site-scanner.spec.ts` against a local Turnstile stand-in; the scanner answers "not connected yet" until the engine is wired | `TURNSTILE_SITE_KEY=… TURNSTILE_SECRET_KEY=… pnpm --filter @rampsmith/web exec playwright test site-turnstile-live` (the widget and the end-to-end scan are checked by hand on first deploy) |
| Shopify App Review | 1, 13 | The PLAN §14 App Review checklist passes | The founder submits the app for review |
