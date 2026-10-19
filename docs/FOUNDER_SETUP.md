# Rampsmith founder setup guide

The accounts, credentials and decisions only you can create for Rampsmith, in order, with where each value goes; checked against vendor docs on 17 Oct 2026, and marked "not verified" where the docs did not confirm a detail.

## Start these first

These have outside waits or approvals. Start them in parallel.

1. **Trademark search and attorney clearance** (it gates the domain and app names; PLAN §25). Lead time: no published time.
2. **Legal entity**, if you are forming one. It sets the business name you give Shopify, AWS and Stripe. Lead time: not verified.
3. **Domain registration and DNS on Cloudflare.**
   - Cloudflare Registrar: "may take up to 30 seconds".
   - Moving DNS from another registrar: wait "up to 24 hours".
   - A Free-plan zone that stays Pending for more than 28 days is deleted.
4. **AWS account.** Activation "usually takes a few minutes but can sometimes take up to 24 hours".
5. **SES domain verification.** DNS changes "can take up to 72 hours". A custom MAIL FROM domain is checked for 72 hours, then fails and must be set up again.
6. **SES production access** (leaving the sandbox).
   - AWS's SES guide: "an initial response to your request within 96 hours". An AWS Knowledge Center article says 24 hours.
   - It needs a verified identity first, and you can't edit the request until the review ends.
7. **Shopify Partner account.** No published time.
8. **Shopify App Store review.** No published time. The form needs things that take time to make: an attorney-reviewed privacy policy, an emergency contact (email and phone), an icon, the listing, a screencast and test credentials.
9. **Claude Console organization.** New organizations may start on an "Evaluation tier" with lower limits, which rise automatically as usage history builds. No published time.
10. **Stripe business verification** (only needed for R3 live mode). No published time. A sandbox works as soon as the account exists.

## Checklist, in order

### 0. One-time: where values go

- **GH**: a GitHub Actions repository secret on `billyribeiro-ux/rampsmith`.
  - In the web UI: Settings > Secrets and variables > Actions > Secrets tab > New repository secret > Name, Secret > Add secret.
  - With the CLI: `gh secret set NAME` prompts for the value. For a file such as a PEM key: `gh secret set NAME < file`.
- **GH env**: a secret on a GitHub environment, set with `gh secret set NAME --env production`.
  - First create the environments: Settings > Environments > New environment > `staging`, then `production` > Configure environment.
  - On `production`, add yourself under Required reviewers, set Deployment branches to `main`, then Save protection rules (PLAN §24).
  - In a personal-account repo, only you, the owner, can do this.
- **RW**: a Railway shared variable, in both `staging` and `production` unless the section says otherwise.
  - Path: Project Settings > Shared Variables > choose the environment > name and value > Add.
  - Changes are staged: review and deploy them.
  - To hide a secret: open its ⋯ menu > Seal. Sealing is permanent.
  - Multi-line values: press Cmd/Ctrl+Enter or use the Raw Editor.
- **Both**: GH and RW.
- Never put a value in the repo or a chat. Values marked *public* may be shown to builders.
- When you finish, reply in the Rampsmith chat. Builders then run `rsctl doctor`, which checks each input against its live service (LAUNCH.md B), and the live checks in LAUNCH.md section E. A check that needs a secret builders cannot read runs on your machine instead: for the Shopify dev-store check, `docs/runbooks/shopify-dev-store.md` section 3 has the one command.

Docs: [GitHub: use secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets?tool=webui) · [secrets reference](https://docs.github.com/en/actions/reference/security/secrets) · [manage environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments) · [gh secret set](https://cli.github.com/manual/gh_secret_set) · [Railway: secrets](https://docs.railway.com/guides/managing-secrets-on-railway.md) · [variables](https://docs.railway.com/variables.md)

### 1. Trademark and entity (input 13, part 1)

You create: a clearance decision on RAMPSMITH and a choice of legal entity.

1. Search the US register at <https://tmsearch.uspto.gov>. PLAN §25 says to check classes 9 and 42. Expert mode filters by coordinated class.
2. Search the EU register with EUIPO's TMview (https://www.tmdn.org/tmview/welcome#/tmview) or eSearch plus (https://euipo.europa.eu/eSearch/). These links come from Ireland's IP Office; I did not open EUIPO's own pages.
3. Have an attorney confirm before you pay for anything branded (PLAN §25).
4. Choose the entity. PLAN §25 suggests a separate LLC. Use the same legal name everywhere below.

Values: none.

Docs: [USPTO search handout](https://Www.Uspto.gov/sites/default/files/documents/TM-FederalTrademarkSearching-GettingStarted-handout.pdf) · [Irish IP Office: international searches](https://ipoi.gov.ie/en/understanding-ip/international-ip-rights/international-ip-searches/)

### 2. Domain and DNS on Cloudflare (input 10)

You create: a Cloudflare account, the domain, and Cloudflare as its DNS.

The domain must not contain "Shopify" (or a misspelling or abbreviation of it) or "Example". Shopify's review rules ban both in app URLs.

1. Sign up at <https://dash.cloudflare.com/sign-up> and verify your email. You need a verified email to register domains.
2. Register the domain:
   - Open the Register domains page > search > Purchase.
   - Pick a term under Payment option. Auto-renew is on by default.
   - Enter accurate contact details and payment, then select Complete purchase.
   - Domains bought here use Cloudflare DNS from the start.
3. If you bought the domain elsewhere:
   - Domains > Onboard a domain > enter the apex domain > Continue > Free plan > review the records > copy the two nameservers.
   - At your registrar, turn off DNSSEC, then replace the nameservers.
   - Wait for the "Active" email, which can take up to 24 hours. Then turn DNSSEC back on in Cloudflare.
4. You will add DNS records later. Path: DNS Records > Add record > Type > fill the fields > Save.

Values: none.

Docs: [create account](https://developers.cloudflare.com/fundamentals/account/create-account/) · [register a domain](https://developers.cloudflare.com/registrar/get-started/register-domain) · [full setup](https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/) · [pending nameservers](https://developers.cloudflare.com/dns/zone-setups/troubleshooting/pending-nameservers/) · [create DNS records](https://developers.cloudflare.com/dns/manage-dns-records/how-to/create-dns-records) · [Shopify: submit for review](https://shopify.dev/docs/apps/launch/app-store-review/submit-app-for-review)

### 3. Amazon SES (input 7)

You create: an AWS account, an SES domain identity with a custom MAIL FROM domain, production access, and an IAM user that can only send mail.

Pick one Region, such as `us-east-1`, and use it for everything below. Sandbox status, identity verification and sending limits differ between Regions.

1. Create the AWS account. You need a payment method and phone verification. Business and Personal accounts "have the same features and functions".
2. Create the identity:
   - SES console > Configuration > Identities > Create identity > Domain.
   - Enter the apex domain, without "www".
3. Set the MAIL FROM domain:
   - Tick Use a custom MAIL FROM domain and enter a subdomain such as `mail.<domain>`. It must not be used to send or receive mail.
   - For Behavior on MX failure, "Use default MAIL FROM domain" keeps mail flowing.
   - Keep the defaults: Easy DKIM, RSA_2048_BIT, DKIM signatures Enabled. Then Create identity.
4. Add these records in Cloudflare (step 2.4):
   - The 3 DKIM CNAMEs from the identity's Authentication tab > Publish DNS records, as DNS only. Cloudflare can't proxy `dkim.amazonses.com` targets.
   - On the MAIL FROM subdomain: MX `10 feedback-smtp.<region>.amazonses.com`, and TXT `"v=spf1 include:amazonses.com ~all"`. Use exactly one MX record.
   - DMARC: TXT on `_dmarc.<domain>` = `v=DMARC1;p=none;rua=mailto:<your inbox>`. AWS advises starting at `p=none`, then moving to `quarantine`, then `reject`.
5. Wait until Identity status shows Verified, which can take up to 72 hours. If it doesn't, check the record names: SES warns that some providers append the domain a second time.
6. Request production access:
   - Account dashboard > View Get set up page > Request production access.
   - Choose Transactional, then enter your Website URL, up to 4 additional contacts and a contact language.
   - Tick the acknowledgement and select Submit request.
7. Create the sending-only policy:
   - IAM > Policies > Create policy > JSON.
   - Paste the SES "send only" policy, which allows `ses:SendEmail` and `ses:SendRawEmail`.
   - Optional: allow only your From address with the condition `"StringEquals": {"ses:FromAddress": "<EMAIL_FROM address>"}`.
   - Next > Policy Name > Create policy.
8. Create the user and its key:
   - IAM > Users > Create user. Skip console access.
   - Set Permissions: Add user to group > Create group > pick your policy > Create user group > Next > Create user.
   - Security credentials > Create access key > Other > Next > Create access key > Show, or Download .csv.
   - This is the only time the secret is shown.

Values:
- `SES_REGION`, for example `us-east-1` → Both
- `SES_ACCESS_KEY_ID` → Both
- `SES_SECRET_ACCESS_KEY` → Both
- `EMAIL_FROM`, an address on the verified domain (ask builders if they want a display name) → Both

Docs: [create AWS account](https://docs.aws.amazon.com/accounts/latest/reference/manage-acct-creating.html) · [identities](https://docs.aws.amazon.com/ses/latest/dg/creating-identities.md) · [MAIL FROM](https://docs.aws.amazon.com/ses/latest/DeveloperGuide/mail-from.html) · [DMARC](https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-dmarc.md) · [production access](https://docs.aws.amazon.com/console/ses/sandbox) · [production access FAQ](https://repost.aws/knowledge-center/ses-production-access-request-faq) · [Regions](https://docs.aws.amazon.com/ses/latest/DeveloperGuide/regions.html) · [endpoints](https://docs.aws.amazon.com/general/latest/gr/ses.html) · [SES IAM policies](https://docs.aws.amazon.com/ses/latest/DeveloperGuide/control-user-access.html) · [create policy](https://docs.aws.amazon.com/IAM/latest/UserGuide//access_policies_create-console.html) · [IAM user for a workload](https://docs.aws.amazon.com/IAM/latest/UserGuide/getting-started-workloads.html) · [access keys](https://docs.aws.amazon.com/IAM/latest/UserGuide/access-keys-admin-managed.html) · [Cloudflare proxy limits](https://developers.cloudflare.com/dns/proxy-status/limitations/)

### 4. Shopify Partner account and public app (input 1)

You create: a Partner organization with you as owner, and the production app with public distribution.

Wait until builders commit `shopify.app.toml`. Shopify says App Store apps should be built with Shopify CLI rather than the Dev Dashboard's "Start from Dev Dashboard".

1. Sign up at <https://app.shopify.com/services/partners/signup>. Not verified: the sign-up steps, cost and any approval.
2. Partner Dashboard > Settings. Fill in Business details, Contact information and Emergency developer contact information. The emergency contact is required to list on the App Store.
3. Install the CLI with `npm install -g @shopify/cli@4.9.4`. That is the latest version on npm today, and it needs Node 22.12 or later.
4. In a clone of the repo, run `shopify app config link`. Then:
   - Log in through the browser.
   - Pick your Partner organization, not a store organization. The Distribution card exists only for apps in a Partner organization.
   - Create a new app under your cleared name.
   - Name the configuration `production`.
   - Not verified: the exact prompt wording.
5. Give builders the new `shopify.app.production.toml`, or just its `client_id`. Shopify calls it "the app's public identifier".
6. Get the credentials: Dev Dashboard (https://dev.shopify.com/dashboard) > Apps > your app > Settings > Credentials. Copy the Client ID and Client secret.
7. Choose distribution: app Home > Distribution card > Select distribution method > public (Shopify App Store) > confirm. This can't be undone. Do it on this production app only.

Values:
- `SHOPIFY_API_KEY` = Client ID (*public*) → Both. Railway `production` only; staging needs its own app (see the last section).
- `SHOPIFY_API_SECRET` = Client secret → Both. Same Railway note.

Docs: [Partner getting started](https://help.shopify.com/en/partners/partner-program/getting-started) · [Partner settings](https://help.shopify.com/partners/manage-account/settings) · [Partner vs Dev Dashboard](https://help.shopify.com/partners/manage-account/dashboard) · [Dev Dashboard](https://shopify.dev/docs/apps/build/dev-dashboard) · [create apps in Dev Dashboard](https://shopify.dev/docs/apps/build/dev-dashboard/create-apps-using-dev-dashboard) · [manage config files](https://shopify.dev/docs/apps/build/cli-for-apps/manage-app-config-files) · [app config link](https://shopify.dev/docs/api/shopify-cli/app/app-config-link) · [app configuration](https://shopify.dev/docs/apps/build/cli-for-apps/app-configuration) · [credentials](https://shopify.dev/docs/apps/build/authentication-authorization/manage-credentials.md) · [distribution](https://shopify.dev/docs/apps/launch/distribution) · [select distribution](https://shopify.dev/docs/apps/launch/distribution/select-distribution-method) · [scaffold an app](https://www.shopify.dev/docs/apps/getting-started/create)

### 5. Partner API token, org ID, App Automation Token (input 2)

You can do steps 1 and 2 before the app exists.

1. Org ID: the ID in the Partner Dashboard URL while you are logged in. Not verified: its exact format.
2. Partner API client:
   - Partner Dashboard > Settings > Partner API clients > Manage Partner API clients > create a client. Not verified: the create button's label.
   - Only an organization owner can do this.
   - Grant only Manage apps, which the Active Subscription query needs. View financials covers transactions and cancelling App Pricing subscriptions, and the plan uses neither.
   - Copy the token right away. Not verified: whether it is shown only once.
3. App Automation Token:
   - Dev Dashboard > your app > Settings (App settings) > App Automation Token > Create token.
   - Pick an Expiration of 1, 3 or 6 months > Generate token > copy it now. It is shown only once.
   - Set a reminder before it expires. To rotate: Rotate > Generate token > update the secret > Revoke the old token.

Values:
- `SHOPIFY_PARTNER_ORG_ID` → Both
- `SHOPIFY_PARTNER_API_TOKEN` → Both
- `SHOPIFY_APP_AUTOMATION_TOKEN` → GH env `production` only (PLAN §24 deploys Shopify config after production approval). The CLI reads this variable automatically.
- `SHOPIFY_APP_GID`, the app's `gid://shopify/App/<id>`, its Partner API app id (ADR-131) → Both. Builders can read it from the installed app; ask them for the value.

Docs: [Partner API 2026-10](https://shopify.dev/docs/api/partner/2026-10) · [Partner API getting started](https://shopify.dev/docs/partner-api/getting-started?locale=en) · [App Automation Tokens](https://shopify.dev/docs/apps/build/dev-dashboard/app-automation-tokens) · [CI/CD](https://shopify.dev/docs/apps/tools/cli/ci-cd) · [App Pricing](https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing)

### 6. Two development stores (input 3)

You create: store A, store B (its theme connected to GitHub), and a test GitHub organization with a theme repository.

1. Dev Dashboard > Stores > Create store > Dev.
   - The name sets `<name>.myshopify.com`, and it can't be changed later.
   - Plan: Basic, Grow, Advanced or Plus.
   - Then Create store. Repeat for store B.
   - Give both stores the same language as the app listing. Shopify warns that draft apps can show a 404 on the plan page when the languages differ.
2. Storefront password: in each store's admin, Online Store > Preferences > Store access > Password. Dev stores are always password protected. Not verified: that dev stores show this field in the same place.
3. Create the test organization: GitHub > Settings > Organizations > New organization (PLAN §22).
4. Create a repository there whose branch holds a theme in Shopify's default folder structure. Builders can fill it if you give them push access. Not verified: how best to seed it.
5. Install the Shopify GitHub app (github.com/apps/shopify) on that organization, with access to that repository only.
6. Connect store B: its admin > Online Store > Themes > Theme library > Add theme > Connect from GitHub > organization > repository > branch.
7. When builders say the app is deployed, install it on both stores: Dev Dashboard > your app > Installs card > Install app > pick the store > Install.

Values:
- `SHOPIFY_DEV_STORE_DOMAIN`, as `<name>.myshopify.com` → GH
- `SHOPIFY_DEV_STORE_PASSWORD` → GH
- `SHOPIFY_DEV_STORE_B_DOMAIN` and `SHOPIFY_DEV_STORE_B_PASSWORD`, for store B → GH

Docs: [dev stores](https://shopify.dev/docs/apps/build/stores/development-stores) · [store password](https://help.shopify.com/manual/using-themes/password-page) · [GitHub theme integration](https://shopify.dev/docs/storefronts/themes/tools/github) · [Shopify GitHub app](https://shopify.dev/docs/api/github-app) · [new GitHub organization](https://docs.github.com/en/organizations/collaborating-with-groups-in-organizations/creating-a-new-organization-from-scratch)

### 7. Railway (input 8)

You create: a project with `production` and `staging` environments, and one project token per environment.

1. Plan: Pro, $20 a month including $20 of usage (PLAN §20). Pro or Enterprise is needed to add workspace members.
2. Create the project with `railway init --name rampsmith`, or in the dashboard. Not verified: the dashboard button wording.
3. New projects start with `production`. Add staging: environment drop-down > + New Environment > Empty Environment > name it `staging`.
4. Project Settings > Tokens: create a token for `production`, then one for `staging`. Not verified: whether each is shown only once.
   - A project token works in one environment only, and only for deploy, redeploy and logs.

Values:
- `RAILWAY_TOKEN` → GH env only:
  - the staging token: `gh secret set RAILWAY_TOKEN --env staging`
  - the production token: `gh secret set RAILWAY_TOKEN --env production`

Docs: [plans](https://docs.railway.com/pricing/plans.md) · [railway init](https://docs.railway.com/cli/init.md) · [environments](https://docs.railway.com/environments.md) · [tokens](https://docs.railway.com/integrations/api) · [deploying from CI](https://docs.railway.com/cli/deploying.md) · [CLI](https://docs.railway.com/guides/cli) · [projects](https://docs.railway.com/projects.md)

### 8. RAMPSMITH_MASTER_KEYS (input 12)

1. Run `rsctl keys generate` on your own machine, once for `production` and once for `staging`. Builders provide the tool.
2. Put each key in Railway as a service or shared variable in its own environment, then Seal it.
3. Save copies in your offline encrypted vault (PLAN §22). If the key is lost, merchants re-authenticate the next time they open the app (PLAN §22).

Values:
- `RAMPSMITH_MASTER_KEYS` → RW, sealed, with a different key ring per environment. Its format is `id:base64key[,id:base64key…]`, newest first, and a rotation adds the new key at the front (ADR-021).
- GH only if builders ask, and then use a separate CI key, never production's.
- Sealed values are not copied into PR environments, so builders need a non-sealed test value there.

Docs: [Railway: sealed variables](https://docs.railway.com/guides/managing-secrets-on-railway.md)

### 9. Grafana Cloud (input 9)

1. Sign up for the free tier. The pricing page says no credit card is required. Not verified: the sign-up steps.
2. Cloud Portal > Launch your stack > OpenTelemetry tile > Configure.
3. Password / API token > Generate now > enter a name. Save the token now: "You won't be able to view it again."
4. Environment Variables > Copy. Use the values exactly as generated.

Values:
- `OTEL_EXPORTER_OTLP_ENDPOINT` → Both
- `OTEL_EXPORTER_OTLP_HEADERS`, which contains the token → Both
- The tile also generates `OTEL_EXPORTER_OTLP_PROTOCOL`. It isn't in LAUNCH.md, so pass it to builders.

Docs: [send data via OTLP](https://grafana.com/docs/grafana-cloud/send-data/otlp/send-data-otlp.md) · [same, newer path](https://grafana.com/docs/grafana-cloud/observe-and-act/send-data/otlp/send-data-otlp.md) · [configure the OTLP endpoint](https://grafana.com/docs/learning-paths/beyla-tempo/configure-otlp-endpoint.md) · [pricing](https://grafana.com/pricing/?pg=pricing)

### 10. Cloudflare R2 and Turnstile (input 6)

You create: an R2 subscription, two buckets, one S3 token scoped to them, and one Turnstile widget.

1. Storage & databases > R2 > Overview. Complete the checkout to add the R2 subscription. Tokens can't be created before this.
2. Create bucket, twice:
   - Name them, for example, `rampsmith-evidence` and `rampsmith-backups`.
   - Location: Automatic, or a North America hint. Don't set a jurisdiction; it can never be changed.
   - Storage class: Standard. The free tier covers Standard only.
   - Then Create bucket.
3. Lifecycle rule:
   - Evidence bucket > Settings > Object Lifecycle Rules > Add rule.
   - Delete objects after 90 days (PLAN §19, §22), on the prefix builders give you, so fix evidence is kept. Then Save changes.
   - Not verified: the form's field names.
4. Token:
   - R2 Overview > API Tokens > Manage > Create Account API token.
   - Choose Object Read & Write > Apply to specific buckets only > tick both buckets > Create API Token.
   - Copy the Access Key ID and Secret Access Key. The secret is never shown again. The S3 endpoint is also shown here.
5. Account ID: Account home > Cmd/Ctrl+K > "Copy account ID".
6. Turnstile widget:
   - Turnstile > Add widget > Widget name.
   - Hostname management: your production and staging hosts.
   - Widget mode: Managed, Non-Interactive or Invisible.
   - Then Create, and copy the sitekey and secret key.

Values:
- `R2_ACCOUNT_ID` → Both
- `R2_ACCESS_KEY_ID` → Both
- `R2_SECRET_ACCESS_KEY` → Both
- `R2_BUCKET_EVIDENCE` and `R2_BUCKET_BACKUPS`, the bucket names (*public*) → Both
- `TURNSTILE_SITE_KEY` (*public*) → Both
- `TURNSTILE_SECRET_KEY` → Both

Docs: [R2 get started](https://developers.cloudflare.com/r2/get-started/index.md) · [R2 via S3](https://developers.cloudflare.com/r2/get-started/s3/) · [R2 tokens](https://developers.cloudflare.com/r2/api/tokens/) · [data location](https://developers.cloudflare.com/r2/reference/data-location) · [lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles) · [R2 pricing](https://developers.cloudflare.com/r2/pricing) · [account ID](https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/) · [Turnstile get started](https://developers.cloudflare.com/turnstile/get-started/) · [Turnstile widget](https://developers.cloudflare.com/turnstile/get-started/widget-management/dashboard/)

### 11. Anthropic API key (input 5)

You create: credits, spend limits, a `rampsmith` workspace, a service account, and one API key.

1. Log in to the Claude Console (platform.claude.com) with an Admin role.
2. Settings > Billing > Buy credits.
   - Credits expire one year after purchase and are non-refundable.
   - Auto-reload is optional, under Credit balance.
3. On the Billing page, under Spend limits, select Set limit (or Adjust limit). The limit can't exceed your tier's cap; the Start tier cap is $500 a month.
4. Workspaces > Create workspace > name it `rampsmith` > Create workspace.
5. Select that workspace > Spend limits, and set a monthly limit. The Default Workspace can't take limits.
6. Service accounts (`/settings/service-accounts`): create one and add it to `rampsmith`. Not verified: the exact steps.
7. API keys (`/settings/keys`) > Create key:
   - Enter a name and choose an expiration. The expiration can't be changed later.
   - Set Linked account to the service account, and scope the key to `rampsmith`.
   - Copy the `sk-ant-api…` value. Not verified: whether it is shown only once.

Values:
- `ANTHROPIC_API_KEY` → Both. One key in GH and another in Railway lets you revoke either one alone.

Docs: [rate and spend limits](https://platform.claude.com/docs/en/api/rate-limits.md) · [workspaces](https://platform.claude.com/docs/en/manage-claude/workspaces) · [API keys](https://platform.claude.com/docs/en/manage-claude/authentication) · [paying for usage](https://support.claude.com/en/articles/8977456) · [higher limits](https://support.claude.com/en/articles/10366389)

### 12. GitHub App (input 4)

Wait until the domain works, since it gives the webhook URL, and until builders commit `infra/github-app-manifest.json` plus a helper that posts it.

1. Pick the owner: your account, or an organization. You can transfer it later via the app's settings > Advanced > Transfer ownership.
2. Check that the manifest says `"public": true`. A private app can only be installed on the owner's account.
3. Run the builders' helper.
   - It POSTs the manifest to `https://github.com/settings/apps/new`, or to `https://github.com/organizations/<org>/settings/apps/new` for an organization.
   - On GitHub, confirm the name and click Create GitHub App.
4. GitHub redirects back with a code. The helper must exchange it with `POST /app-manifests/{code}/conversions` within one hour of starting. The reply contains `id`, `pem` and `webhook_secret`.
5. Store the values. Put the PEM in your vault, then delete the downloaded file. GitHub keeps only the public half of the key.
6. Install the app on the test theme repository only.

Values:
- `GITHUB_APP_ID` → Both
- `GITHUB_APP_CLIENT_ID` → Both (ADR-122). The manifest conversion returns it as `client_id`.
- `GITHUB_APP_PRIVATE_KEY`, the whole PEM → Both. Use `gh secret set GITHUB_APP_PRIVATE_KEY < app.pem`, and in Railway use the Raw Editor or Cmd/Ctrl+Enter for the line breaks.
- `GITHUB_APP_WEBHOOK_SECRET` → Both

To make a new key later: Settings > Developer settings > GitHub Apps > Edit > Private keys > Generate a private key.

Docs: [register from a manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest) · [manifest conversion API](https://docs.github.com/zh/enterprise-cloud@latest/rest/apps/apps) · [public or private](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/making-a-github-app-public-or-private) · [private keys](https://docs.github.com/en/enterprise-cloud@latest/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps) · [transfer ownership](https://docs.github.com/en/apps/maintaining-github-apps/transferring-ownership-of-a-github-app)

### 13. Stripe, only for R3 (input 11)

1. Create the account at <https://dashboard.stripe.com/register>. Turn on 2FA with a passkey or security key.
2. Work in a sandbox. Its keys start with `pk_test_`, `rk_test_` and `sk_test_`.
3. API keys page: Stripe recommends a restricted key (`rk_…`) over a secret key. Builders list the permissions it needs; store it as `STRIPE_SECRET_KEY`.
4. Create the webhook:
   - Workbench > Webhooks > Create an event destination > Your account.
   - Choose the payload format, then the events builders list > Webhook endpoint.
   - Endpoint URL: `https://<webhook host>/webhooks/stripe`.
   - On its settings page, select Reveal secret and copy the `whsec_…` value.
5. Live mode later requires business verification. You can't change the business country after you activate live mode.

Values:
- `STRIPE_SECRET_KEY` → Both
- `STRIPE_PUBLISHABLE_KEY` (*public*) → Both
- `STRIPE_WEBHOOK_SECRET` → Both. Sandbox and live endpoints have different secrets.

Docs: [account setup](https://docs.stripe.com/get-started/account/activate) · [API keys](https://docs.stripe.com/keys) · [webhooks](https://docs.stripe.com/webhooks) · [signing secret](https://docs.stripe.com/webhooks/signature)

### 14. Attorney review and App Store submission (input 13, part 2)

1. Have the attorney review the privacy policy, terms and DPA. The privacy policy is required for the listing.
2. Partner Dashboard > Settings > Payouts and Taxes. Payouts go through Hyperwallet, with a $25 minimum.
3. Fill in the App Store review page:
   - Configuration: URLs, compliance webhooks, a 1200×1200 icon, an API contact email without "Shopify" in it, and the emergency contact's email and phone.
   - Create a listing, using the builders' package.
   - Pricing: enter the PLAN §20 plans. New public apps define plans in this form, in the Partner Dashboard rather than the Dev Dashboard.
   - Protected customer data: opt out, since there are no customer scopes (PLAN §14). You can't apply while the app is under review.
   - Run the automated checks until they pass.
   - Add the testing instructions, test credentials and a screencast.
   - Then Submit.
4. Add noreply@shopify.com to your allowed senders, and answer reviewer emails. Repeatedly not responding can get you temporarily suspended.
5. The status moves Draft > Submitted > (Paused) > Reviewed > Published.

Docs: [review process](https://shopify.dev/docs/apps/launch/app-store-review/review-process) · [submit for review](https://shopify.dev/docs/apps/launch/app-store-review/submit-app-for-review) · [prepare for review](https://shopify.dev/docs/apps/launch/app-store-review/pass-app-review) · [requirements checklist](https://shopify.dev/docs/apps/launch/app-requirements-checklist) · [App Pricing](https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing) · [getting paid](https://help.shopify.com/partners/getting-started/getting-paid)

## Gotchas

- **Shopify distribution** can't be changed after you choose it. Choose it on the production app only. Custom apps can't use Shopify billing.
- **App Automation Token** expires after 1 to 6 months and is shown only once. Partner Dashboard CLI tokens (`SHOPIFY_CLI_PARTNERS_TOKEN`) can no longer be created.
- **Partner API clients:**
  - Only owners can create them, and each works for one organization.
  - Manage apps is enough for subscription checks.
  - The limit is 4 requests per second per client.
  - `activeSubscription` works only for public apps.
- **Dev stores** keep their URL forever. They can't be transferred or turned into real stores, and they can't take real payments.
- **Shopify GitHub sync:**
  - It can't be turned off, and admin edits commit back to the branch.
  - A disconnected branch can't be reconnected to the same theme.
  - Outside collaborators can't connect a repository.
- **SES sandbox:**
  - It sends only to verified addresses, at most 200 messages per 24 hours and 1 per second.
  - Sandbox status, identity verification and sending limits differ between Regions, so request production access in the Region you send from.
- **SES records:**
  - The MAIL FROM subdomain needs exactly one MX and must not be used for any other mail.
  - The DKIM CNAMEs can't be proxied.
- **R2 tokens:**
  - The secret is shown only once.
  - Object Read & Write can't change bucket settings, so set lifecycle rules yourself. Through the API, lifecycle rules need a "Workers R2 Storage Write" token.
  - A jurisdiction can't be changed after the bucket exists.
- **Turnstile:** Server-side Siteverify is mandatory. Tokens last 300 seconds and can be used once. Use Cloudflare's testing sitekey in CI; production secret keys reject its dummy tokens.
- **Anthropic:**
  - At the tier cap, requests fail with a 429 that has no `retry-after` until 00:00 UTC on the 1st of the next month.
  - A personal key stops working if its user leaves, which is why a service account is better.
  - Anthropic emails expiry warnings only for keys that live 7 days or more.
- **GitHub App:**
  - Finish the manifest flow within one hour.
  - Private keys never expire and can't be recovered. Each app can have up to 25.
  - GitHub warns that a key in an environment variable is weaker than one in a key vault.
- **GitHub, public repo:** Secrets aren't passed to workflows triggered from forks. With "Prevent self-review" on, you can't approve runs you started yourself.
- **Railway:**
  - A project token only deploys, redeploys and reads logs, in one environment.
  - Sealed values are permanent.
  - On domains proxied through Cloudflare, set SSL/TLS to Full, since "Full (Strict) will not work as intended".
- **Grafana free tier** keeps logs, traces and metrics for 14 days; PLAN §21 wants logs for 30. Builders archive logs to R2 for 30 days by default. Grafana Pro keeps logs for 30 days and is your option, at a cost.
- **Cloudflare:** Turn off DNSSEC before you switch nameservers. Domains registered with Cloudflare must stay on Cloudflare's nameservers.

## Also on your list

1. **Staging copies of the apps.**
   - A Shopify app has one set of URLs, and a GitHub App has one webhook URL. Shopify advises separate apps for development, staging and production.
   - Staging therefore needs its own Shopify app (client ID, secret and App Automation Token), and probably its own GitHub App.
   - Builders choose the variable names and the staging app's distribution.
2. **Railway setup that a project token can't do.**
   - That covers creating the services (web, api, ctl, engine, egress), PostgreSQL with point-in-time recovery (database > Backups > Enable PITR), and custom domains (service > Settings > Public Networking > + Custom Domain).
   - Either you do these from the builders' list, or you give CI a workspace or account token as `RAILWAY_API_TOKEN`.
   - PR preview environments (PLAN §22) need the same token, or Railway's PR Environments switch (Project Settings > Environments) with the project connected to GitHub.
3. **DNS records.** Unless you give builders a Cloudflare API token, only you can add them:
   - for Railway domains, a CNAME and a TXT for each;
   - for SES, 3 CNAMEs, 1 MX and 2 TXT;
   - for Email Routing.
4. **An inbox on the domain** for support mail, DMARC reports and Shopify review mail.
   - Use Cloudflare Email Routing: Compute > Email Service > Email Routing > Onboard Domain.
   - Add and verify a destination address, then add a routing rule.
   - SES here only sends.
5. **App Store form items.** You enter the App Pricing plans and the emergency contact's phone number, and you prepare the privacy policy URL, support contact, icon, test credentials, demo store and screencast. Payout and tax details are needed to get paid.
6. **GitHub settings only the owner can change:**
   - the `staging` and `production` environments with you as reviewer (section 0);
   - protection for `main` (PLAN §24; steps not verified here).
7. **A test GitHub organization and theme repository** (PLAN §22), with both GitHub apps installed on that repository only.
8. **The staging copies' variables** use the same names as production, set in the `staging` environments (LAUNCH.md section C, row 15).
9. **Optional:** separate staging R2 buckets and token, and a separate staging Anthropic key.
10. **A GitHub App registration helper.** GitHub's flow needs a form POST and a code exchange within the hour, so ask builders to provide one.
11. **Security:**
    - hardware security keys on GitHub, Railway, Shopify Partners, Cloudflare, Anthropic and Stripe (PLAN §18);
    - an offline encrypted vault for every secret (PLAN §22);
    - reminders before each token expires.
12. **Alerts to your phone** through Grafana Cloud (PLAN §21). Setup not verified.
13. **Insurance quotes** once revenue starts (PLAN §25).

Docs for this section: [Railway PR environments](https://docs.railway.com/guides/preview-deployments-with-pr-environments.md) · [Railway domains](https://docs.railway.com/networking/domains/working-with-domains) · [Railway PITR](https://docs.railway.com/volumes/point-in-time-recovery.md) · [Cloudflare Email Routing](https://developers.cloudflare.com/email-service/get-started/route-emails/) · [Email Routing overview](https://developers.cloudflare.com/email-routing/get-started/enable-email-routing/)
