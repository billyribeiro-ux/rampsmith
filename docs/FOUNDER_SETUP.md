# Founder setup: the accounts, keys and decisions only you can provide

This is LAUNCH.md section D's founder checklist. It lists every input in LAUNCH.md section C,
rows 1 to 14, in the order to provide them: the ones with the longest outside wait first. Each
step says what to create, links the vendor's own instructions (read on 17 October 2026, see
`docs/evidence/ws-5-launch-docs.md`), names the exact variables from LAUNCH.md section C, says
where each value goes, and gives the command that proves it works.

The build does not wait for any of this (your decision, 17 October 2026). Builders keep the
"Waiting on founder" list in `docs/STATUS.md` in this order.

## Rules for every step

1. **Never paste a secret into a chat**, including a chat with Claude, an issue, a pull request
   or a commit. Values go only into the two places below.
2. **GitHub Actions secrets** hold what CI and the live end-to-end tests need. Repository secrets:
   Settings → Secrets and variables → Actions → New repository secret. Deploy tokens go in
   **environment secrets** instead: Settings → Environments → (environment) → Add secret. From a
   terminal, `gh secret set NAME < file` reads the value from a file, so it never appears in your
   shell history or on screen; add `--env staging` or `--env production` for an environment
   secret ([GitHub: using secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)).
3. **Railway variables** hold what the running services need, set per environment (staging and
   production) in the Railway dashboard. Seal production secrets: sealed variables are
   write-only, can never be unsealed, and are not copied into pull-request environments
   ([Railway: managing secrets](https://docs.railway.com/guides/managing-secrets-on-railway)).
   Give staging its own test credentials wherever a vendor offers them.
4. **Turn on a hardware security key** on every account you create below: GitHub, Shopify
   Partners, Cloudflare, Anthropic, AWS, Railway, Grafana Cloud and Stripe (PLAN §18).
5. **Spending money is yours to approve.** Steps that cost money say so.

## About `rsctl doctor`

`rsctl doctor` is **not built yet**. LAUNCH.md section B defines it: it validates every founder
input against the live service and prints PASS or FAIL per input. Each step below names the
check it will run. Until it exists, finish the step, then tell the builder (by updating the
"Waiting on founder" list in `docs/STATUS.md` or in the session) which input is now set; the
live test for that input then stops skipping (LAUNCH.md section E).

## Order at a glance

| Order | LAUNCH C row | Input | Outside wait (verified) | Needs first |
| --- | --- | --- | --- | --- |
| 1 | 13 | Trademark clearance, legal entity, attorney review | Depends on the attorney and the formation authority | Nothing |
| 2 | 10 | Domain registered, DNS on Cloudflare | DNS changes can take up to 72 hours | Trademark search |
| 3 | 7 | Amazon SES, verified domain, out of the sandbox | DKIM up to 72 hours; first answer to production access within 96 hours | Domain |
| 4 | 14 | GitHub repository settings: `main` ruleset, Renovate | None | Nothing |
| 5 | 1 | Shopify Partner account and the public app | None stated | Domain (for app URLs) |
| 6 | 2 | Partner API token and org id, App Automation Token, App Pricing plans | None stated; the App Automation Token expires in 1, 3 or 6 months | Row 1 |
| 7 | 3 | Two development stores, one with its theme on GitHub | None | Row 1 |
| 8 | 4 | GitHub App | None | Domain (for URLs) |
| 9 | 6 | Cloudflare R2 buckets and Turnstile | None | Domain (for Turnstile hostnames) |
| 10 | 5 | Anthropic API key with a spend limit | None | Nothing |
| 11 | 9 | Grafana Cloud OTLP endpoint and token | None | Nothing |
| 12 | 8 | Railway project and tokens | None | Most variables above, to configure services |
| 13 | 12 | `TOKEN_MASTER_KEY` | None | `rsctl keys generate`, not built yet |
| 14 | 11 | Stripe, test mode first | None | Only for R3 (non-Shopify billing) |

---

## 1. Decisions and legal (row 13)

**What to do**

- **Trademark clearance** for RAMPSMITH, before paying for anything branded (PLAN §25): search
  classes 9 and 42 in the USPTO's Trademark Search system, `https://tmsearch.uspto.gov/`
  ([USPTO](https://www.uspto.gov/trademarks/search)), and in TMview for EU sales,
  `https://www.tmdn.org/tmview/`, which the EUIPO recommends for availability searches
  ([EUIPO](https://www.euipo.europa.eu/en/trade-marks/before-applying/availability)). An
  attorney's clearance opinion is the decision; the search is the starting point.
- **Legal entity**: decide which entity holds the product (PLAN §25 suggests a separate LLC).
  Its name and address fill the `[LEGAL ENTITY]` and `[REGISTERED ADDRESS]` placeholders in
  `docs/legal/` and `docs/accessibility-statement.md`.
- **Attorney review** of `docs/legal/privacy-policy.md`, `docs/legal/terms-of-service.md` and
  `docs/legal/data-processing-addendum.md`, and of the claims policy (PLAN §3, §25). Each draft
  lists its placeholders and open questions at the top.
- **Insurance quotes** (technology errors-and-omissions and cyber) once revenue starts (PLAN §25).
- **Pricing** is already approved as written in PLAN §20 (17 October 2026).
- **App Store submission** comes last (LAUNCH.md section E) and is yours to make.
- **A decision to make now:** Shopify App Store requirement 5.1.1 says "You or merchants should
  not make any code changes to the theme." ADR-141 explains how this bears on the pull-request
  and theme-package channels and suggests asking Shopify before R2 depends on them.

**Variables:** none.

**Afterwards:** fill the placeholders in `docs/legal/` (or tell the builder the values), and record
the attorney's sign-off in `docs/STATUS.md`. Nothing is published until you approve it.

## 2. Domain and DNS on Cloudflare (row 10)

**Costs money** (domain registration).

**What to create**

1. Register the domain (after the trademark search).
2. In Cloudflare: Domains → Onboard a domain, enter the apex domain, choose a plan, review the
   DNS records, then set the two nameservers Cloudflare assigns at your registrar. Turn off
   DNSSEC at the registrar before changing nameservers if it is on
   ([Cloudflare: onboard a domain](https://developers.cloudflare.com/fundamentals/manage-domains/add-site/)).
3. Leave the service records for later: each Railway service shows the CNAME and TXT records
   to add when its custom domain is created, and both are required. With Cloudflare's proxy on,
   set SSL/TLS to **Full**; Railway says "Full (Strict)" will not work as intended
   ([Railway: domains](https://docs.railway.com/networking/domains/working-with-domains)).

Host names for the app, the marketing site and the webhook host (PLAN §22) are chosen with the
builder of the deploy configuration. Shopify does not accept app URLs that contain "Shopify" or
"Example" ([Shopify: submit for review](https://shopify.dev/docs/apps/launch/app-store-review/submit-app-for-review)).

**Variables:** none.

**Afterwards:** `rsctl doctor` (not built yet) will run the DNS and TLS checks for the app, the
marketing site, the webhook host and the email domain.

## 3. Amazon SES (row 7)

The longest vendor wait: start it as soon as the domain resolves.

**What to create**

1. Choose one AWS Region for sending, near the Railway region (a US region at launch, PLAN §22).
   Sandbox status and DKIM records are per Region.
2. SES console → Configuration → Identities → Create identity → **Domain**. Keep Easy DKIM on,
   then add the three CNAME records SES shows to Cloudflare DNS (DNS only, not proxied). DNS can
   take up to 72 hours ([SES: creating identities](https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html)).
3. Once the domain is verified: Account dashboard → View Get set up page → **Request production
   access**. Choose **Transactional**, enter the website URL and up to 4 extra contacts, accept
   the acknowledgement, and submit. AWS gives "an initial response to your request within 96
   hours". Until then you can send only to verified addresses, at most 200 messages a day and 1
   per second ([SES: production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html)).
4. In IAM, create a user for sending only, with a policy that allows just `ses:SendEmail` and
   `ses:SendRawEmail`, restricted by the `ses:FromAddress` condition to the `EMAIL_FROM` address
   ([SES: identity and access](https://docs.aws.amazon.com/ses/latest/dg/control-user-access.html)).
   Create an access key for that user.

**Variables**

| Variable | GitHub Actions secret | Railway variable (services) |
| --- | --- | --- |
| `SES_REGION` | Yes | Yes (`ctl`) |
| `SES_ACCESS_KEY_ID` | Yes | Yes (`ctl`), sealed in production |
| `SES_SECRET_ACCESS_KEY` | Yes | Yes (`ctl`), sealed in production |
| `EMAIL_FROM` | Yes | Yes (`ctl`) |

**Afterwards:** `rsctl doctor` (not built yet) will send a test email and the check in LAUNCH.md
section C passes when it reaches you.

## 4. GitHub repository settings (row 14)

**What to set**

1. **Branch ruleset on `main`:** Settings → Rulesets → New ruleset → New branch ruleset; target
   the default branch; enforcement **Active**
   ([GitHub: creating rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository)).
   Rules ([available rules](https://docs.github.com/en/enterprise-cloud@latest/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)):
   - Require a pull request before merging, with **Squash** as the only allowed merge method.
   - Require status checks to pass: `rust`, `node` and `contracts` (the job names in
     `.github/workflows/ci.yml`, ADR-016).
   - Require linear history. Block force pushes. Restrict deletions.
2. **Keep the scheduled STATUS.md commits reaching `main`.** The scheduled sessions commit
   `docs/STATUS.md` straight to `main`. A pull-request rule blocks that unless the account those
   sessions push with is on the ruleset's **bypass list** with **Always allow** ("For pull
   requests only" would still block a direct push). The bypass list accepts repository admins,
   maintain or write roles, teams and GitHub Apps. Add the role that account holds (for your own
   account on your own repository, "Repository admin") with **Always allow**. Anyone pushing
   with that account then bypasses every rule above, so keep that account protected by a
   hardware key. After saving, the next scheduled STATUS.md commit should appear on `main`.
3. **Renovate:** install the Mend Renovate app from `https://github.com/apps/renovate` on this
   repository only ("selected repositories")
   ([Renovate: installing](https://docs.renovatebot.com/getting-started/installing-onboarding/)).
   `renovate.json` is committed on the R0 branch, so once R0 merges, Renovate treats the
   repository as onboarded and opens its grouped pull requests on its Monday schedule.
4. **Push protection** for secrets: Settings → Advanced Security → enable Secret Protection, then
   Push protection
   ([GitHub: push protection](https://docs.github.com/en/code-security/secret-scanning/enabling-secret-scanning-features/enabling-push-protection-for-your-repository)).
5. **Environments** `staging` and `production`: Settings → Environments → New environment. For
   `production`, add yourself as a required reviewer and limit deployment branches to `main`
   ([GitHub: environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)).
   Leave "Prevent self-review" off while you are the only reviewer, or you cannot approve your
   own deploys.

**Variables:** none.

**Afterwards:** the check in LAUNCH.md section C is the settings themselves: a test pull request
shows the three required checks; Renovate opens its first pull request; a scheduled STATUS.md
commit lands on `main`.

## 5. Shopify Partner account and the public app (row 1)

**What to create**

1. Join the Shopify Partner Program, free, at `https://app.shopify.com/services/partners/signup`
   ([Shopify Help Center](https://help.shopify.com/en/partners/partner-program/about)).
2. Create the app. App Store apps are built with Shopify CLI, so the builder links the app with
   `shopify app config link`, which "can create a new app", once the app configuration file
   exists in the repository
   ([Shopify CLI: app config link](https://shopify.dev/docs/api/shopify-cli/app/app-config-link)).
   To start earlier, create it in the Dev Dashboard at `https://dev.shopify.com/dashboard/`:
   Apps → Create app → Start from Dev Dashboard; the builder then links it with
   `shopify app config link --client-id <client id>`
   ([Dev Dashboard](https://shopify.dev/docs/apps/build/dev-dashboard/create-apps-using-dev-dashboard)).
   The client ID is public (App Bridge uses it in the browser); the client secret is not.
3. Copy the **Client ID** and **Client secret** from the app's settings in the Dev Dashboard.
4. Add an **emergency developer contact** (email and phone) in the Partner Dashboard
   (requirement 4.5.6;
   [App Store requirements](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements)).

**Variables**

| Variable | Value | GitHub Actions secret | Railway variable (services) |
| --- | --- | --- | --- |
| `SHOPIFY_API_KEY` | Client ID | Yes | Yes (`web`, `api`, `ctl`) |
| `SHOPIFY_API_SECRET` | Client secret | Yes | Yes (`api`, `ctl`), sealed in production |

Use a separate development app for staging if the builder sets one up; the production app's
secret belongs only in production.

**Afterwards:** `rsctl doctor` (not built yet) will check the client credentials, then the
dev-store end-to-end suite (LAUNCH.md section E) runs.

## 6. Partner API, App Automation Token and App Pricing plans (row 2)

**What to create**

1. **Partner API client** (organization owner only): Partner Dashboard → Settings → Partner API
   clients → Manage Partner API clients → create a client with the **Manage apps** permission.
   Copy its access token. The **organization id** is the number in the Partner Dashboard's URL
   ([Partner API](https://shopify.dev/docs/api/partner/2026-10)).
2. **App Automation Token**: Dev Dashboard → your app → Settings → App Automation Token → Create
   token → choose an expiry (1, 3 or 6 months) → copy it at once; it is shown only once. Before
   it expires, use **Rotate**: old and new tokens both work until you revoke the old one
   ([App Automation Tokens](https://shopify.dev/docs/apps/build/dev-dashboard/app-automation-tokens)).
   Put a reminder in your calendar a week before the expiry.
3. **Shopify App Pricing plans**, below.

**Variables**

| Variable | GitHub Actions secret | Railway variable (services) |
| --- | --- | --- |
| `SHOPIFY_PARTNER_API_TOKEN` | Yes | Yes (`api`, `ctl`), sealed in production |
| `SHOPIFY_PARTNER_ORG_ID` | Yes | Yes (`api`, `ctl`) |
| `SHOPIFY_APP_AUTOMATION_TOKEN` | Yes, as an **environment secret** in `production` only | No |

**Afterwards:** `rsctl doctor` (not built yet) will run the active-subscription query against the
Partner API. The release workflow will run
`shopify app deploy --config production --allow-updates` with the token
([Shopify CI/CD](https://shopify.dev/docs/apps/tools/cli/ci-cd)).

### Shopify App Pricing plans to create

Shopify App Pricing is set in the **Partner Dashboard**, not the Dev Dashboard: All apps → your
app → Distribution → Shopify App Store listing → Manage listing → the locale under Published
languages → Pricing content → Settings → choose Shopify App Pricing, default billing frequency
**Monthly** ([Shopify App Pricing](https://shopify.dev/docs/apps/launch/billing/managed-pricing)).
Then Public plans → Add, once per plan
([App Pricing plans](https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing/plans)).
For a new public app, Shopify says the plans are defined in the app submission form.

Shopify asks you to define each plan's **handle** when you create it
([changelog](https://shopify.dev/changelog/new-planhandle-field-managed-pricing)). The handles
below are fixed: the entitlements code (`crates/billing`, ADR-008) reads them. Shopify's pages do
not say whether a handle can be edited later, so enter them exactly at creation.

| Handle | Display name | Billing | Monthly charge | Yearly charge |
| --- | --- | --- | --- | --- |
| `free` | Free | Free | $0 | $0 |
| `starter` | Starter | Monthly with a yearly option | $79 | $790 |
| `growth` | Growth | Monthly with a yearly option | $199 | $1,990 |
| `pro` | Pro | Monthly with a yearly option | $499 | $4,990 |

Prices are PLAN §20, approved as written; yearly prices give two months free. Prices are in US
dollars only. Up to eight public plans are allowed.

**Top features** per plan (PLAN §20, entered under Pricing content for each locale):

- **Free:** monthly scan of the home page and 5 pages; data fixes and alt-text drafts for the
  first 25 images, once.
- **Starter:** weekly scans with 3 sample pages per template; data fixes; patched theme package
  with the 6 core fix recipes; 2,000 alt-text drafts a month.
- **Growth:** daily scans with 10 sample pages per template; adds GitHub pull requests, every fix
  recipe, description rewrites and regression alerts; 10,000 alt-text drafts a month.
- **Pro:** daily scans of every template variant with 25 samples each; adds AI proposals for
  custom widgets, multi-language statements and the priority queue; 50,000 alt-text drafts a month.

Leave "Free trial duration" empty: PLAN §20 sets no trial, and adding one is a pricing decision.
"Free for partners and developers" lets development stores outside your Partner organization
(App Review, agencies) test paid plans at no charge, while production stores still pay; your
own organization's development stores can test every plan free either way. Leave "Welcome link"
empty until the `web` builder names the path. If ADR-141's decision hides the code channels from
the App Store build, the Starter and Growth feature lines change with it.

## 7. Two development stores (row 3)

**What to create**

1. Dev Dashboard → Stores → Create store → **Dev**, twice. The `myshopify.com` address cannot be
   changed later. Dev stores are always password protected
   ([Shopify: dev stores](https://shopify.dev/docs/apps/build/stores/development-stores)).
2. On the second store, connect its theme to GitHub: install the Shopify GitHub app, then Online
   Store → Themes → Add theme → Connect from GitHub, and pick the test repository and branch.
   Admin edits commit back to that branch and this cannot be turned off
   ([Shopify: GitHub integration](https://shopify.dev/docs/storefronts/themes/tools/github)).
   Create the test theme repository in a test GitHub organization (PLAN §22), not in this
   repository.

**Variables**

| Variable | GitHub Actions secret | Railway variable |
| --- | --- | --- |
| `SHOPIFY_DEV_STORE_DOMAIN` | Yes | No |
| `SHOPIFY_DEV_STORE_PASSWORD` | Yes (the storefront password) | No |

LAUNCH.md names one domain and password; which store they point to, and the variables for the
second store, are settled by the builder who writes the end-to-end suite.

**Afterwards:** the dev-store end-to-end suite (install, scan, fix, verify, undo on every fix
channel; LAUNCH.md section E). `rsctl doctor` (not built yet) will check that the storefront
opens with the password.

## 8. GitHub App (row 4)

**What to create**

The app's settings live in `infra/github-app-manifest.json`, which the GitHub App stream (WS-3)
is writing. Once it is merged, register the app from it:

- **From the manifest:** GitHub's manifest flow POSTs the manifest to
  `https://github.com/organizations/ORGANIZATION/settings/apps/new` (or
  `https://github.com/settings/apps/new` for a personal account), then exchanges the returned
  code with `POST /app-manifests/{code}/conversions`, which returns the app `id`, the private key
  (`pem`) and the `webhook_secret`. All steps must finish within one hour
  ([GitHub: manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)).
  Rampsmith has no page or command for this flow yet; the builder adds one or you use the manual
  route.
- **Manually:** your organization's Settings → Developer settings → GitHub Apps → New GitHub App,
  copying each value from the manifest (name at most 34 characters; the permissions in PLAN §15;
  "Workflows" not requested; a webhook secret)
  ([GitHub: registering](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app)).
  Then Private keys → **Generate a private key**: a PEM file downloads; GitHub keeps only the
  public half; keys do not expire, and up to 25 can exist, which allows rotation with overlap
  ([GitHub: private keys](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps)).

**Variables**

| Variable | GitHub Actions secret | Railway variable (services) |
| --- | --- | --- |
| `GITHUB_APP_ID` | Yes | Yes (`api`, `ctl`) |
| `GITHUB_APP_PRIVATE_KEY` | Yes: `gh secret set GITHUB_APP_PRIVATE_KEY < key.pem` | Yes (`ctl`), sealed in production |
| `GITHUB_APP_WEBHOOK_SECRET` | Yes | Yes (`api`), sealed in production |

Delete the downloaded PEM from your computer once both stores hold it and your offline vault has
a copy (PLAN §22: secrets are exported to an offline encrypted vault after every rotation).

**Afterwards:** `rsctl doctor` (not built yet) will sign a JWT and call `GET /app`, which accepts
only a GitHub App JWT ([GitHub: REST apps](https://docs.github.com/en/rest/apps/apps)). Then a pull
request is opened on the test theme repository.

## 9. Cloudflare R2 and Turnstile (row 6)

**What to create**

1. **Two R2 buckets**: one for evidence, one for backups (PLAN §22 keeps backups separate).
   R2 → Create bucket ([R2: S3 get started](https://developers.cloudflare.com/r2/get-started/s3/)).
2. **An R2 API token**: R2 → Overview → API Tokens → Manage → Create Account API token →
   **Object Read & Write**, **Apply to specific buckets only**, both buckets. Copy the Access Key
   ID and Secret Access Key; the secret is shown once. The account id is the first part of the
   S3 endpoint `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` shown on the same page.
3. **Lifecycle rules**: wait for the builder to name the object prefixes. Evidence expires after
   90 days except evidence attached to a fix (PLAN §19), so a rule on the whole bucket would
   delete records it must keep
   ([R2: object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)).
4. **Turnstile widget** for the free scanner: restrict it to your own host names. Each widget has
   one sitekey (public) and one secret key; server-side validation is mandatory
   ([Turnstile: get started](https://developers.cloudflare.com/turnstile/get-started/)). Cloudflare's
   test keys serve CI.

**Variables**

| Variable | GitHub Actions secret | Railway variable (services) |
| --- | --- | --- |
| `R2_ACCOUNT_ID` | Yes | Yes (`api`, `ctl`, `engine`) |
| `R2_ACCESS_KEY_ID` | Yes | Yes (`api`, `ctl`, `engine`), sealed in production |
| `R2_SECRET_ACCESS_KEY` | Yes | Yes (`api`, `ctl`, `engine`), sealed in production |
| `R2_BUCKET_EVIDENCE` | Yes | Yes (`api`, `engine`) |
| `R2_BUCKET_BACKUPS` | Yes | Yes (the backup job's service) |
| `TURNSTILE_SITE_KEY` | Yes | Yes (`web`) |
| `TURNSTILE_SECRET_KEY` | Yes | Yes (`web`), sealed in production |

**Afterwards:** `rsctl doctor` (not built yet) will write an object to each bucket, read it back
and delete it, and verify a Turnstile token.

## 10. Anthropic API key with a spend limit (row 5)

**What to create**

1. In the Claude Console, create workspaces for production and for CI: Workspaces → Create
   workspace. Spend limits cannot be set on the Default Workspace
   ([Claude: workspaces](https://platform.claude.com/docs/en/manage-claude/workspaces)).
2. For each workspace: select it → **Spend limits** → set a monthly cap and alert thresholds.
   Set the organization limit on the Billing page → Spend limits → Set limit; it cannot exceed
   your usage tier's cap ([Claude: rate limits](https://platform.claude.com/docs/en/api/rate-limits)).
   The amounts are your spending decision; PLAN §13 puts alt text at about $0.10 per 1,000 images.
3. Create one API key in each workspace.

**Variables**

| Variable | GitHub Actions secret | Railway variable (services) |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Yes: the CI workspace's key | Yes (`engine`): the production workspace's key, sealed |

When a limit you set is reached, the API answers HTTP 400; the engine stops AI work instead of
retrying (ADR-142).

**Afterwards:** `rsctl doctor` (not built yet) will list the models with the key (LAUNCH.md
section B), and the evaluation harness (PLAN §13) runs live.

## 11. Grafana Cloud OTLP (row 9)

**What to create**

A Grafana Cloud stack on the free tier (PLAN §20). In the Cloud Portal: your stack → the
**OpenTelemetry** tile → **Configure** → generate a token. Copy the endpoint and the header the
flow shows. `OTEL_EXPORTER_OTLP_ENDPOINT` is the base URL; the SDKs add `/v1/traces`,
`/v1/metrics` and `/v1/logs` themselves
([Grafana: OTLP](https://grafana.com/docs/grafana-cloud/send-data/otlp/send-data-otlp/)).

**Variables**

| Variable | GitHub Actions secret | Railway variable (services) |
| --- | --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No | Yes (every service) |
| `OTEL_EXPORTER_OTLP_HEADERS` | No | Yes (every service), sealed in production |

Services export only when the endpoint is set (ADR-019).

**Afterwards:** `rsctl doctor` (not built yet) will send a test span; the LAUNCH.md check passes
when one trace is visible end to end.

## 12. Railway project and tokens (row 8)

**Costs money** (Railway Pro plan and usage, PLAN §20). Production deploys also need your
approval each time.

**What to create**

1. A Railway project with two environments, **staging** and **production**.
2. One **project token per environment**: project settings → Tokens. A project token is scoped to
   one environment and can deploy, redeploy and read logs there
   ([Railway: API tokens](https://docs.railway.com/integrations/api),
   [Railway: deploying with the CLI](https://docs.railway.com/cli/deploying)).
3. Enter the runtime variables from steps 3 to 11 in each environment, sealed in production.

**Variables**

| Variable | GitHub Actions secret | Railway variable |
| --- | --- | --- |
| `RAILWAY_TOKEN` | Yes, as an **environment secret**: the staging token in `staging`, the production token in `production` | No |

LAUNCH.md lists one `RAILWAY_TOKEN`; because Railway project tokens are per environment, it is
one name with two values (ADR-142).

**Afterwards:** the staging deploy and the synthetic install-scan-fix journey (LAUNCH.md
section E), once the deploy workflow exists.

## 13. Token master key (row 12)

**What to create:** a generated key, made with `rsctl keys generate`. **`rsctl` is not built
yet**, so this step waits for it; it is needed only before the first staging deploy. Generate
separate keys for staging and production, store each in your offline encrypted vault (PLAN §22),
and never put it in GitHub.

**Variables**

| Variable | GitHub Actions secret | Railway variable (services) |
| --- | --- | --- |
| `TOKEN_MASTER_KEY` | No: CI generates throwaway keys | Yes (`api`, `ctl`), sealed |

Note for the builder: ADR-021 on `r0-foundations` (after `e43f546`) reads the key ring from
`RAMPSMITH_MASTER_KEYS` as `id:base64key[,id:base64key…]`, while LAUNCH.md names
`TOKEN_MASTER_KEY`. One of the two names changes before you set it.

**Afterwards:** `rsctl doctor` (not built yet) will run an encrypt and decrypt round trip.

## 14. Stripe, test mode first (row 11)

Needed only for R3 billing of customers who do not use Shopify. Shopify merchants pay through
Shopify App Pricing, so the App Store launch does not need Stripe.

**What to create**

1. A Stripe account; work in a **sandbox** first. Sandbox keys start with `pk_test_`,
   `rk_test_` and `sk_test_`. Stripe recommends a **restricted key** over a secret key; the
   variable name stays `STRIPE_SECRET_KEY` either way
   ([Stripe: API keys](https://docs.stripe.com/keys)).
2. A webhook endpoint at the webhook host's `/webhooks/stripe` path (PLAN §22): Workbench →
   Webhooks → Create an event destination → Webhook endpoint; copy the `whsec_` signing secret
   ([Stripe: webhooks](https://docs.stripe.com/webhooks)).

**Variables**

| Variable | GitHub Actions secret | Railway variable (services) |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | Yes (sandbox key) | Yes (`api`), sealed in production |
| `STRIPE_PUBLISHABLE_KEY` | Yes | Yes (`web`) |
| `STRIPE_WEBHOOK_SECRET` | Yes | Yes (`api`), sealed in production |

**Afterwards:** `rsctl doctor` (not built yet) will retrieve the account with the key (LAUNCH.md
section B); then the test subscription lifecycle runs.

---

## Open questions for the founder and builders

1. ADR-141: may the App Store build include the pull-request and theme-package channels, given
   requirement 5.1.1?
2. `TOKEN_MASTER_KEY` (LAUNCH.md) or `RAMPSMITH_MASTER_KEYS` (ADR-021): which name the code reads.
3. The second development store's variables (step 7).
4. Which account the scheduled STATUS.md commits push with, so the right role goes on the
   ruleset's bypass list (step 4).
5. Whether the `images` CI job should also be a required check once it is stable.
6. The exact form of `OTEL_EXPORTER_OTLP_HEADERS` the Rust and Node exporters accept, checked
   against Grafana's Configure flow by the builder.
