# Rampsmith founder setup guide

The accounts, credentials and decisions only you can create for Rampsmith, in order, with where each value goes; checked against vendor docs on 17 Oct 2026, and marked "not verified" where the docs did not confirm a detail.

This is LAUNCH.md section D's founder checklist. It covers every input in LAUNCH.md section C (rows 1 to 16), names the exact variables, says where each value goes and gives the `rsctl doctor` command that proves it. The vendor facts behind it are listed in `docs/evidence/ws-5-launch-docs.md`.

The build does not wait for any of this (your decision, 17 Oct 2026). Builders keep the "Waiting on founder" list in `docs/STATUS.md` in this order. You give builders names and ids, never secrets: a secret goes only into Railway variables, and, for the few values a workflow needs, into the secrets of a GitHub environment limited to `main` (section 0). There are no repository secrets.

Rules for every step:

1. **Never paste a secret** into a chat (including a chat with Claude), an issue, a pull request or a commit.
2. **Spending money is yours to approve.** Steps that cost money say so.
3. **Turn on a hardware security key** on every account you create: GitHub, Shopify Partners, Cloudflare, Anthropic, AWS, Railway, Grafana Cloud and Stripe (PLAN §18).
4. **Give staging its own test credentials** wherever a vendor offers them. Production's secrets belong only in production.

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

## A decision to make now

This is a decision, not an input, and R2 depends on it. Shopify's App Store requirements say, in 5.1.1, "You or merchants should not make any code changes to the theme", and in 1.1.3, "Your app must not allow merchants to download themes" and "Themes can only be installed via the Shopify Theme Store" ([App Store requirements](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements), re-read 19 Oct 2026). The GitHub pull-request channel falls under the first; the patched theme package falls under both. ADR-141 has the analysis. The architect recommends retiring the theme package, keeping pull requests behind their flag, and asking Shopify before the R2 submission whether a pull request the merchant's developer reviews and merges meets 5.1.1. Until you answer, both channels are built behind a flag that is off in the App Store build. If the package goes, the Starter plan needs a replacement feature, which is a pricing decision for you.

## About `rsctl doctor`

`rsctl doctor` is the operator CLI that checks your inputs against the live services (LAUNCH.md B5). It is built on branch `ws/rsctl` (draft pull request #8) and reaches `main` when the integrator merges it. Each step below ends with the check that proves its input.

- It reads only the documented variables of LAUNCH.md section C rows 1 to 12 and 16, prints one line per check (PASS, FAIL with a reason, or SKIP naming the missing C row), and prints no secret. It makes the smallest documented read for each input and creates nothing, except one throwaway object in an R2 bucket that it deletes. It also tries what each of the three R2 tokens must be refused (the engine's token on the backups bucket, the drill's token writing) and passes only when R2 says no.
- Flags: `--row N` runs one row; `--environment staging` or `production` (also for the staging-only row 15 check); `--json`; `--strict` (a missing required input fails the run); `--timeout`. Exit 0 means nothing failed, 1 means an input failed, 2 means it could not run.
- **What it cannot check**, because the vendor documents no way to without using the input: the App Automation Token (`shopify app deploy` in CI is its test), the dev-store storefront passwords, the GitHub App webhook secret, Stripe's publishable key and webhook secret, the Turnstile site key, the R2 evidence bucket's 90-day lifecycle rule, and that mail reaches an inbox. Those report SKIP "not verifiable" when set.
- **What it does not do**: it sends no email (the test email delivered to you stays a manual step in LAUNCH.md section E), checks no DNS or TLS for your hosts, runs the Partner API `app(id)` query rather than the billing query, and checks only that a dev store's password page answers, not the password.
- Run it where the variables are set (your machine with a local env file, or a Railway shell), never in a chat.

## Checklist, in order

### 0. One-time: where values go

Founder secrets live in two places only: Railway variables (what the running services read), and, for the few values a workflow needs, secrets of a GitHub environment that only `main` can deploy to. There are no repository or organization secrets at all. A repository secret can be read by every workflow on every branch and by every pull request opened from this repository, so it is only as safe as the least-reviewed workflow. The `secrets-scope` job in `.github/workflows/ci.yml` fails the build when any founder secret name below exists at repository or organization level (ADR-253). Do not set a secret there "temporarily".

- **RW**: a Railway shared variable, in both `staging` and `production` unless the section says otherwise.
  - Path: Project Settings > Shared Variables > choose the environment > name and value > Add.
  - Changes are staged: review and deploy them.
  - To hide a secret: open its ⋯ menu > Seal. Sealing is permanent.
  - Multi-line values: press Cmd/Ctrl+Enter or use the Raw Editor.
- **GH env**: a secret of a GitHub environment, only for a value that a workflow needs. There are three environments and each deploys from `main` only:
  - `staging` and `production`: `RAILWAY_TOKEN` and `SHOPIFY_APP_AUTOMATION_TOKEN`, for the deploy workflow. On `production`, add yourself under Required reviewers (PLAN §24).
  - `backup-drill`: the three secrets of the weekly restore drill (section 16). It has no required reviewer, because the drill runs on a schedule and a reviewer would hold every run.
  - Create each one: Settings > Environments > New environment > name > Configure environment. Under Deployment branches and tags choose Selected branches and tags, add the branch rule `main` (not a tag, not a pattern), then Save protection rules.
  - Set a secret on it: `gh secret set NAME --env <environment>` prompts for the value. For a file such as a PEM key: `gh secret set NAME --env <environment> < file`.
  - The workflows read each environment's settings before a job can touch its secrets, and stop unless deployments are limited to `main`.
  - In a personal-account repo, only you, the owner, can do this.
- **Repository variable**: not a secret: Settings > Secrets and variables > Actions > Variables tab > New repository variable. Only `BACKUP_DRILL_READY` (section 16).
- **Vault**: your offline encrypted vault, and your machine when you run `rsctl doctor`. For a value that no workflow and no service reads.
- Never put a value in the repo or a chat. Values marked *public* may be shown to builders.
- Railway services read the RW values through shared variables that the deploy configuration (`infra/railway`) wires to the right service, so you set each value once per environment and do not choose which service gets it. The `backup` service is wired to its own five values and nothing else.
- When you finish, run `rsctl doctor` yourself, on your machine or on Railway, where the inputs are (LAUNCH.md B; see "About `rsctl doctor`"). It checks each input against its live service and prints PASS or FAIL per input, never a value. Then reply in the Rampsmith chat with that output. Live checks in LAUNCH.md section E that need a secret builders cannot read also run on your machine: for the Shopify dev-store check, `docs/runbooks/shopify-dev-store.md` section 3 has the one command.

Docs: [GitHub: use secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets?tool=webui) · [secrets reference](https://docs.github.com/en/actions/reference/security/secrets) · [manage environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments) · [gh secret set](https://cli.github.com/manual/gh_secret_set) · [gh variable set](https://cli.github.com/manual/gh_variable_set) · [Railway: secrets](https://docs.railway.com/guides/managing-secrets-on-railway.md) · [variables](https://docs.railway.com/variables.md)

### 1. Trademark and entity (input 13, part 1)

You create: a clearance decision on RAMPSMITH and a choice of legal entity.

1. Search the US register at <https://tmsearch.uspto.gov>. PLAN §25 says to check classes 9 and 42. Expert mode filters by coordinated class.
2. Search the EU register with EUIPO's TMview (https://www.tmdn.org/tmview/), which the EUIPO recommends for availability searches ([EUIPO: availability](https://www.euipo.europa.eu/en/trade-marks/before-applying/availability)), or eSearch plus (https://euipo.europa.eu/eSearch/).
3. Have an attorney confirm before you pay for anything branded (PLAN §25). The attorney's clearance opinion is the decision; the search is the starting point.
4. Choose the entity. PLAN §25 suggests a separate LLC. Use the same legal name everywhere below. Its name and address fill the `[LEGAL ENTITY]` and `[REGISTERED ADDRESS]` placeholders in `docs/legal/` and `docs/accessibility-statement.md`; tell builders the values, or fill them yourself.

Values: none.

Check: none; the decision is the result.

Docs: [USPTO search handout](https://Www.Uspto.gov/sites/default/files/documents/TM-FederalTrademarkSearching-GettingStarted-handout.pdf) · [Irish IP Office: international searches](https://ipoi.gov.ie/en/understanding-ip/international-ip-rights/international-ip-searches/)

### 2. Domain and DNS on Cloudflare (input 10)

**Costs money** (domain registration).

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
   - Each Railway service shows the CNAME and TXT records to add when its custom domain is created, and both are required.
   - With Cloudflare's proxy on, set SSL/TLS to Full. Railway says "Full (Strict)" will not work as intended.
5. The host names for the app, the marketing site and the webhook host (PLAN §22) are chosen with the builder of the deploy configuration.

Values: none required. Optional: `CLOUDFLARE_API_TOKEN` (a token with DNS edit on the zone) → Vault, only if you want to run `rsctl doctor --row 10` or to give builders the DNS records instead of adding them yourself (LAUNCH.md row 10). No workflow and no service reads it, so it is stored in neither GitHub nor Railway; if a workflow ever needs it, it becomes a secret of the `production` environment.

Check: `rsctl doctor --row 10`, only when you gave a token. It lists up to three zones and reads the first zone's DNS records, creating nothing. LAUNCH.md names no domain variable, so it cannot pick the Rampsmith zone itself: read the zone names it prints. Nothing else checks the domain; DNS and TLS for each host are checked by the staging deploy (LAUNCH.md section E).

Docs: [create account](https://developers.cloudflare.com/fundamentals/account/create-account/) · [register a domain](https://developers.cloudflare.com/registrar/get-started/register-domain) · [full setup](https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/) · [pending nameservers](https://developers.cloudflare.com/dns/zone-setups/troubleshooting/pending-nameservers/) · [create DNS records](https://developers.cloudflare.com/dns/manage-dns-records/how-to/create-dns-records) · [Shopify: submit for review](https://shopify.dev/docs/apps/launch/app-store-review/submit-app-for-review)

### 3. Amazon SES (input 7)

You create: an AWS account, an SES domain identity with a custom MAIL FROM domain, production access, and an IAM user that can only send mail.

Pick one Region and use it for everything below. Rampsmith runs in a US Region at launch (PLAN §22), so a US Region such as `us-east-1` is the natural choice. Sandbox status, identity verification and sending limits differ between Regions.

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
7. Create the policy for the sending user:
   - IAM > Policies > Create policy > JSON.
   - Paste the policy below, replacing `<region>`, `<account id>`, `<your domain>` and `<EMAIL_FROM address>`. It lets the user send only from your address, and read the account's sandbox status and the identity's verification, which `rsctl doctor` needs (`ses:GetAccount` and `ses:GetEmailIdentity`). Without those two, the row 7 check fails with a 403 that says so.
   - Next > Policy Name > Create policy.

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Sid": "SendFromTheOneAddress",
         "Effect": "Allow",
         "Action": ["ses:SendEmail", "ses:SendRawEmail"],
         "Resource": "arn:aws:ses:<region>:<account id>:identity/<your domain>",
         "Condition": { "StringEquals": { "ses:FromAddress": "<EMAIL_FROM address>" } }
       },
       {
         "Sid": "ReadIdentityForRsctlDoctor",
         "Effect": "Allow",
         "Action": "ses:GetEmailIdentity",
         "Resource": [
           "arn:aws:ses:<region>:<account id>:identity/<your domain>",
           "arn:aws:ses:<region>:<account id>:identity/<EMAIL_FROM address>"
         ]
       },
       {
         "Sid": "ReadAccountStatusForRsctlDoctor",
         "Effect": "Allow",
         "Action": "ses:GetAccount",
         "Resource": "*"
       }
     ]
   }
   ```

   - The Service Authorization Reference lists no resource type for `ses:GetAccount`, so it takes `"*"`; `ses:GetEmailIdentity` and the send actions take the identity ARN. The doctor reads the domain's identity first and the exact address if the domain is not found, so both ARNs are listed.
8. Create the user and its key:
   - IAM > Users > Create user. Skip console access.
   - Set Permissions: Add user to group > Create group > pick your policy > Create user group > Next > Create user.
   - Security credentials > Create access key > Other > Next > Create access key > Show, or Download .csv.
   - This is the only time the secret is shown.

Values:
- `SES_REGION`, for example `us-east-1` → RW
- `SES_ACCESS_KEY_ID` → RW
- `SES_SECRET_ACCESS_KEY` → RW
- `EMAIL_FROM`, an address on the verified domain (ask builders if they want a display name) → RW
- `EMAIL_POSTAL_ADDRESS`, Rampsmith's physical postal address on two or more lines (street, then city, region, postal code and country) → RW. Marketing email must carry it (CAN-SPAM, ADR-191), and the sender refuses to send marketing without it. R1 sends no marketing email, so this can wait; a P.O. box or a registered-agent address is acceptable under CAN-SPAM if it can receive mail. Decide with your attorney which address to publish.

These four reach only the `mailer` service (ADR-276). It is a separate Railway service so the SES key never sits in the process that runs Chromium. It adds one small always-on Railway service to the bill; you accept that at deploy time, or tell builders to fold it into `ctl` instead (which keeps SES next to the Shopify and GitHub credentials, and is the weaker choice).

Check: `rsctl doctor --row 7`. It reads the account (out of the sandbox, sending enabled) and the identity (verified for sending) and sends no mail. The test email delivered to you stays a manual step in LAUNCH.md section E.

Docs: [create AWS account](https://docs.aws.amazon.com/accounts/latest/reference/manage-acct-creating.html) · [identities](https://docs.aws.amazon.com/ses/latest/dg/creating-identities.md) · [MAIL FROM](https://docs.aws.amazon.com/ses/latest/DeveloperGuide/mail-from.html) · [DMARC](https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-dmarc.md) · [production access](https://docs.aws.amazon.com/console/ses/sandbox) · [production access FAQ](https://repost.aws/knowledge-center/ses-production-access-request-faq) · [Regions](https://docs.aws.amazon.com/ses/latest/DeveloperGuide/regions.html) · [endpoints](https://docs.aws.amazon.com/general/latest/gr/ses.html) · [SES IAM policies](https://docs.aws.amazon.com/ses/latest/DeveloperGuide/control-user-access.html) · [create policy](https://docs.aws.amazon.com/IAM/latest/UserGuide//access_policies_create-console.html) · [IAM user for a workload](https://docs.aws.amazon.com/IAM/latest/UserGuide/getting-started-workloads.html) · [access keys](https://docs.aws.amazon.com/IAM/latest/UserGuide/access-keys-admin-managed.html) · [Cloudflare proxy limits](https://developers.cloudflare.com/dns/proxy-status/limitations/) · [GetAccount](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_GetAccount.html) · [GetEmailIdentity](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_GetEmailIdentity.html) · [SES v2 actions, resources and condition keys](https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonsimpleemailservicev2.html)

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
5. Give builders the new `shopify.app.production.toml`, or just its `client_id`. Shopify calls it "the app's public identifier". The file `config link` writes has no webhook subscriptions: builders copy the `[[webhooks.subscriptions]]` tables of `shopify.app.toml` into it and set their host to your `RAMPSMITH_WEBHOOK_HOST` (ADR-088); `deploy.yml` refuses to push a file that lacks them.
6. Get the credentials: Dev Dashboard (https://dev.shopify.com/dashboard) > Apps > your app > Settings > Credentials. Copy the Client ID and Client secret.
7. Choose distribution: app Home > Distribution card > Select distribution method > public (Shopify App Store) > confirm. This can't be undone. Do it on this production app only.

Values:
- `SHOPIFY_API_KEY` = Client ID (*public*) → RW. Railway `production` only; staging needs its own app (see the last section).
- `SHOPIFY_API_SECRET` = Client secret → RW only. Same Railway note. No workflow uses it. If one ever does, it goes in as a secret of a GitHub environment limited to `main` (ADR-031, ADR-253).

These are the names in LAUNCH.md section C, row 1, and the ones `rsctl doctor` reads. The code on `r0-foundations` reads the same two values as `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET` (`crates/api`, `crates/ctl`, `apps/web`, `.env.example`; finding 2 of ADR-156 on `ws/rsctl`), and the Railway configuration on `ws/deploy` (ADR-182) maps the first pair to the second. You set only the names above.

Check: `rsctl doctor --row 1`. It needs development store A with the app installed (step 6.7 below), because the client-credentials grant it uses works only for a store in the app's own organization; until then it reports SKIP naming row 3. It requests a token with the key and secret and reads the app's installation.

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
- `SHOPIFY_PARTNER_ORG_ID` → RW
- `SHOPIFY_PARTNER_API_TOKEN` → RW
- `SHOPIFY_APP_AUTOMATION_TOKEN` → GH env `production` for the production app's token, and GH env `staging` for the staging app's own token (section "Also on your list"); nowhere else (PLAN §24 deploys Shopify config after production approval). The CLI reads this variable automatically.
- `SHOPIFY_APP_GID`, the app's `gid://shopify/App/<id>`, its Partner API app id (ADR-131) → RW. Builders can read it from the installed app; ask them for the value. Shopify's Partner API reference shows the id as `gid://partners/App/<id>`; the doctor tries the configured form and then the other, and the first live run says which Shopify accepts.

Check: `rsctl doctor --row 2`. It asks the Partner API for the app (`app(id)`) and compares its `apiKey` with `SHOPIFY_API_KEY`, so the client and the app belong together. It cannot check the App Automation Token: the release workflow's `shopify app deploy --config production --allow-updates` is that token's test ([Shopify CI/CD](https://shopify.dev/docs/apps/tools/cli/ci-cd)).

#### Shopify App Pricing plans to create

Shopify App Pricing is set in the **Partner Dashboard**, not the Dev Dashboard: All apps > your app > Distribution > Shopify App Store listing > Manage listing > the locale under Published languages > Pricing content > Settings > choose Shopify App Pricing, default billing frequency **Monthly**. Then Public plans > Add, once per plan ([App Pricing](https://shopify.dev/docs/apps/launch/billing/managed-pricing), [plans](https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing/plans)). For a new public app, Shopify says the plans are defined in the app submission form (section 14).

Shopify asks you to define each plan's **handle** when you create it ([changelog](https://shopify.dev/changelog/new-planhandle-field-managed-pricing)). The handles below are fixed: the entitlements code (`crates/billing`, ADR-131 and ADR-132) reads them, and the same handle is used for a plan's monthly and yearly price. Shopify's pages do not say whether a handle can be edited later, so enter them exactly at creation.

| Handle | Display name | Billing | Monthly charge | Yearly charge |
| --- | --- | --- | --- | --- |
| `free` | Free | Free | $0 | $0 |
| `starter` | Starter | Monthly with a yearly option | $79 | $790 |
| `growth` | Growth | Monthly with a yearly option | $199 | $1,990 |
| `pro` | Pro | Monthly with a yearly option | $499 | $4,990 |

Prices are PLAN §20, approved as written; yearly prices give two months free. Prices are in US dollars only, and up to eight public plans are allowed.

**Top features** per plan (PLAN §20, entered under Pricing content for each locale):

- **Free:** monthly scan of the home page and 5 pages; data fixes and alt-text drafts for the first 25 images, once.
- **Starter:** weekly scans with 3 sample pages per template; data fixes; patched theme package with the 6 core fix recipes; 2,000 alt-text drafts a month.
- **Growth:** daily scans with 10 sample pages per template; adds GitHub pull requests, every fix recipe, description rewrites and regression alerts; 10,000 alt-text drafts a month.
- **Pro:** daily scans of every template variant with 25 samples each; adds AI proposals for custom widgets, multi-language statements and the priority queue; 50,000 alt-text drafts a month.

The code-channel lines (the patched theme package and the pull requests) change or go if your decision under "A decision to make now" retires them. Leave "Free trial duration" empty: PLAN §20 sets no trial, and adding one is a pricing decision. "Free for partners and developers" lets development stores outside your Partner organization (App Review, agencies) test paid plans at no charge, while production stores still pay; your own organization's development stores can test every plan free either way. Leave "Welcome link" empty until the `web` builder names the path.

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
- `SHOPIFY_DEV_STORE_DOMAIN`, as `<name>.myshopify.com` → RW, in the `staging` environment only
- `SHOPIFY_DEV_STORE_PASSWORD` → RW, in the `staging` environment only
- `SHOPIFY_DEV_STORE_B_DOMAIN` and `SHOPIFY_DEV_STORE_B_PASSWORD`, for store B → RW, in the `staging` environment only
- No workflow reads these: the dev-store end-to-end suite runs where you run it (LAUNCH.md section E), so CI gets no store credentials.

Check: `rsctl doctor --row 3`. It asks each store's `/password` page and passes when the store exists with a storefront password page. It does not test the password (that would be a login attempt on the store); the dev-store end-to-end suite uses it. Then the suite itself runs (install, scan, fix, verify, undo on every fix channel; LAUNCH.md section E).

Docs: [dev stores](https://shopify.dev/docs/apps/build/stores/development-stores) · [store password](https://help.shopify.com/manual/using-themes/password-page) · [GitHub theme integration](https://shopify.dev/docs/storefronts/themes/tools/github) · [Shopify GitHub app](https://shopify.dev/docs/api/github-app) · [new GitHub organization](https://docs.github.com/en/organizations/collaborating-with-groups-in-organizations/creating-a-new-organization-from-scratch)

### 7. Railway (input 8)

**Costs money** (the Railway Pro plan and usage, PLAN §20). Production deploys also need your approval each time (PLAN §24).

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
- LAUNCH.md lists one `RAILWAY_TOKEN`; because Railway project tokens are per environment, it is one name with two values (ADR-142).
- Optional `RAILWAY_API_TOKEN` (a workspace token) → Vault. No workflow and no service reads it: you use it from your machine (`rsctl doctor --row 8`, the dashboard-only steps in "Also on your list"). If a workflow ever creates services or domains with it, it becomes a secret of the `production` environment.
- The `backup` cron service (section 16) is created by the deploy configuration like the other services and holds no Railway token of its own.
- Then enter the runtime variables from the other sections in each environment, sealed in production.

Check: `rsctl doctor --row 8 --environment staging`, and the same with `production`, each run with that environment's token. It reads the token's project and environment and compares the environment name. A workspace token, if you gave one, is read through the project the project token names. The staging deploy and the synthetic install-scan-fix journey (LAUNCH.md section E) follow once the deploy workflow exists.

Docs: [plans](https://docs.railway.com/pricing/plans.md) · [railway init](https://docs.railway.com/cli/init.md) · [environments](https://docs.railway.com/environments.md) · [tokens](https://docs.railway.com/integrations/api) · [deploying from CI](https://docs.railway.com/cli/deploying.md) · [CLI](https://docs.railway.com/guides/cli) · [projects](https://docs.railway.com/projects.md)

### 8. RAMPSMITH_MASTER_KEYS (input 12)

1. Run `rsctl keys generate` on your own machine, once for `production` and once for `staging`. It prints a key ring once, to standard output (`rsctl keys generate --output ring.txt` writes a new file with mode 0600 and never overwrites one), in the exact format `crates/crypto` reads (ADR-021, ADR-153). Each key is 32 random bytes from the operating system. Builders provide the tool.
2. Put each ring in Railway as a service or shared variable in its own environment, then Seal it.
3. Save copies in your offline encrypted vault (PLAN §22). If the key is lost, merchants re-authenticate the next time they open the app (PLAN §22).
4. Later, to rotate: `printf '%s' "$RAMPSMITH_MASTER_KEYS" | rsctl keys rotate --stdin --output new-ring.txt` adds a fresh key first and keeps the old ones, so existing values still open. The master-key rotation runbook has the full order. No job re-wraps stored values yet (ADR-153), so old keys stay in the ring until one exists.

Values:
- `RAMPSMITH_MASTER_KEYS` → RW, sealed, with a different key ring per environment. Its format is `id:base64key[,id:base64key…]`, newest first, and a rotation adds the new key at the front (ADR-021).
- Never in GitHub: no workflow uses it.
- Sealed values are not copied into PR environments, so builders need a non-sealed test value there.

Two more secrets belong to this input (ADR-266, ADR-267). Generate `RAMPSMITH_SCAN_SECRET_KEYS` with `rsctl keys generate` too, a ring of its own that is never the master ring, and set it, sealed, on `ctl` and `engine` only: ctl re-seals a store's storefront password under it for the length of one scan, and the engine, which never holds the master keys, opens it. Generate `FREE_SCAN_SERVICE_TOKEN` as 32 or more random characters (`openssl rand -base64 36`) and set the same sealed value on `api` and `web`. `rsctl doctor --row 12` checks both when they are set (the ring parses and round-trips and shares no key with the master ring; the token has 32 or more characters). Until they are set the free scanner stays closed, and a password-protected store is reported as blocked.

One more belongs here (ADR-274): `EMAIL_LINK_KEYS`, a third ring from `rsctl keys generate`, never shared with the other two, set, sealed, on `api` and `mailer` only (ADR-276). The mailer signs the unsubscribe and preferences links in every notification email with it and the api checks them; without it notification email is not sent (the job waits and retries), and the unsubscribe pages answer that they are unavailable. `rsctl doctor --row 12` checks it when set. Rotate it like the others, by adding the new key at the front: links already sent stay valid for 180 days under the old one.

Check: `rsctl doctor --row 12`. It parses the ring and checks that every key seals and opens a test value. It needs no network.

Docs: [Railway: sealed variables](https://docs.railway.com/guides/managing-secrets-on-railway.md)

### 9. Grafana Cloud (input 9)

1. Sign up for the free tier. The pricing page says no credit card is required. Not verified: the sign-up steps.
2. Cloud Portal > Launch your stack > OpenTelemetry tile > Configure.
3. Password / API token > Generate now > enter a name. Save the token now: "You won't be able to view it again."
4. Environment Variables > Copy. Use the values exactly as generated.

Values:
- `OTEL_EXPORTER_OTLP_ENDPOINT` → RW
- `OTEL_EXPORTER_OTLP_HEADERS`, which contains the token → RW
- The tile also generates `OTEL_EXPORTER_OTLP_PROTOCOL`. LAUNCH.md row 9 lists it; the doctor requires `http/protobuf` when it is set.
- `OTEL_EXPORTER_OTLP_ENDPOINT` is the base URL: the SDKs add `/v1/traces`, `/v1/metrics` and `/v1/logs` themselves. Services export only when the endpoint is set (ADR-019).
- The `ws/deploy` branch changes where these values go: its services send telemetry to a collector inside Railway and only the collector holds the Grafana credential (ADR-182, ADR-184). When it merges, the integrator updates this step to match.

Check: `rsctl doctor --row 9`. It posts an empty trace export to `<endpoint>/v1/traces` with your header; an empty request is valid, so nothing is stored, and a 200 proves the endpoint and token. That a trace becomes visible in Grafana is the end-to-end check in LAUNCH.md section E, done with the deployed services.

Docs: [send data via OTLP](https://grafana.com/docs/grafana-cloud/send-data/otlp/send-data-otlp.md) · [same, newer path](https://grafana.com/docs/grafana-cloud/observe-and-act/send-data/otlp/send-data-otlp.md) · [configure the OTLP endpoint](https://grafana.com/docs/learning-paths/beyla-tempo/configure-otlp-endpoint.md) · [pricing](https://grafana.com/pricing/?pg=pricing)

### 10. Cloudflare R2 and Turnstile (input 6)

You create: an R2 subscription, **three** buckets (evidence, and one backups bucket per environment), **four** S3 tokens, and one Turnstile widget.

1. Storage & databases > R2 > Overview. Complete the checkout to add the R2 subscription. Tokens can't be created before this.
2. Create bucket, three times:
   - Name them exactly `rampsmith-evidence`, `rampsmith-backups-staging` and `rampsmith-backups-production`. The backup scripts refuse a backups bucket whose name does not end in its environment (ADR-252).
   - Location: Automatic, or a North America hint. Don't set a jurisdiction; it can never be changed.
   - Storage class: Standard. The free tier covers Standard only.
   - Then Create bucket.
3. Locks and lifecycle rules:
   - Backups buckets, each one: apply the retention lock and lifecycle rules in the repository, with an account API token that can edit R2 buckets, from a checkout: `npx wrangler r2 bucket lock set rampsmith-backups-<environment> --file infra/backup/r2/bucket-lock.json` and `npx wrangler r2 bucket lifecycle set rampsmith-backups-<environment> --file infra/backup/r2/lifecycle.json` (do it for `staging` and `production`; Cloudflare docs: *Bucket locks* and *Object lifecycles*). `rsctl doctor` cannot check this, because the engine's and backups' tokens cannot read bucket settings: LAUNCH.md section E keeps a row until you confirm it in the dashboard (Bucket > Settings).
   - Evidence bucket (it has no lock):
   - Evidence bucket > Settings > Object Lifecycle Rules > Add rule.
   - Delete objects after 90 days (PLAN §19, §22), on the prefix builders give you. Evidence attached to a fix is kept (PLAN §19), so a rule on the whole bucket would delete records that must stay. Then Save changes.
   - Not verified: the form's field names.
4. Tokens. R2 Overview > API Tokens > Manage > Create Account API token, **four times**. Each covers one job and one bucket, so a leak of one reaches no more than that job ([R2 token permissions](https://developers.cloudflare.com/r2/api/tokens/#permissions)):

   | Token name | Permission | Apply to | Used by |
   | --- | --- | --- | --- |
   | `rampsmith-engine` | Object Read & Write | the evidence bucket only | the engine, which handles untrusted scan content |
   | `rampsmith-backup-production` | Object Read & Write | `rampsmith-backups-production` only | the production `backup` service (section 16) |
   | `rampsmith-backup-staging` | Object Read & Write | `rampsmith-backups-staging` only | the staging `backup` service (section 16) |
   | `rampsmith-drill` | Object Read only | `rampsmith-backups-staging` only | the weekly restore drill (section 16). It never reads production |

   A fifth token, Object Read only on `rampsmith-backups-production`, is for you when you restore production by hand (`docs/runbooks/restore-from-logical-backup.md`). Keep it in your password manager; it is not a Railway or GitHub value.

   - For each: choose the permission, then Apply to specific buckets only and tick the one bucket, then Create API Token.
   - Copy each Access Key ID and Secret Access Key. The secret is never shown again. The S3 endpoint is also shown here.
   - One token or one bucket for both environments would let a leak in staging overwrite or delete production's backups. `rsctl doctor` checks this: the engine's token must be refused on the backups bucket, and the drill's token must be refused a write.
5. Account ID: Account home > Cmd/Ctrl+K > "Copy account ID".
6. Turnstile widget:
   - Turnstile > Add widget > Widget name.
   - Hostname management: your production and staging hosts.
   - Widget mode: Managed, Non-Interactive or Invisible.
   - Then Create, and copy the sitekey and secret key.

Values:
- `R2_ACCOUNT_ID` → RW. Also an environment variable of `backup-drill` (section 16); it is an identifier, not a secret.
- `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`, the `rampsmith-engine` token → RW
- `R2_BUCKET_EVIDENCE` and `R2_BUCKET_BACKUPS`, the bucket names (*public*) → RW. `R2_BUCKET_BACKUPS` is `rampsmith-backups-staging` in staging and `rampsmith-backups-production` in production, and `rampsmith-backups-staging` as an environment variable of `backup-drill`.
- The `rampsmith-backup-<environment>` and `rampsmith-drill` tokens are row 16: `BACKUP_R2_ACCESS_KEY_ID` and `BACKUP_R2_SECRET_ACCESS_KEY` → RW, and `DRILL_R2_ACCESS_KEY_ID` and `DRILL_R2_SECRET_ACCESS_KEY` → GH env `backup-drill` only (section 16).
- `TURNSTILE_SITE_KEY` (*public*) → RW
- `TURNSTILE_SECRET_KEY` → RW, on the `api` service (it verifies the challenge itself, ADR-267); the `web` service no longer needs it

Check: `rsctl doctor --row 6`. With the engine's token it writes one object to the evidence bucket, reads it back and deletes it, and then tries the backups bucket, where R2 must answer `AccessDenied` (HTTP 403) for a write and a read. For Turnstile it sends a made-up token and expects the answer `invalid-input-response`, which proves the secret was accepted; it fails a Cloudflare testing secret when run with `--environment production`. It cannot check the evidence bucket's lifecycle rule or the public site key. The other two tokens are checked by `rsctl doctor --row 16` (section 16).

Docs: [R2 get started](https://developers.cloudflare.com/r2/get-started/index.md) · [R2 via S3](https://developers.cloudflare.com/r2/get-started/s3/) · [R2 tokens](https://developers.cloudflare.com/r2/api/tokens/) · [R2 error codes](https://developers.cloudflare.com/r2/api/error-codes/) · [data location](https://developers.cloudflare.com/r2/reference/data-location) · [lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles) · [R2 pricing](https://developers.cloudflare.com/r2/pricing) · [account ID](https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/) · [Turnstile get started](https://developers.cloudflare.com/turnstile/get-started/) · [Turnstile widget](https://developers.cloudflare.com/turnstile/get-started/widget-management/dashboard/)

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
- `ANTHROPIC_API_KEY` → RW. No workflow uses it. If the evaluation harness ever runs in CI, it gets its own key in its own workspace with its own limit, as a secret of a GitHub environment limited to `main`.

When a limit you set is reached, the API answers HTTP 400; the engine stops AI work instead of retrying (ADR-142). Setting the limits is your spending decision; PLAN §13 puts alt text at about $0.10 per 1,000 images.

Check: `rsctl doctor --row 5`. It lists models with the key and passes when the three models PLAN §13 names (Haiku 5.5, Sonnet 5.5 and Opus 5.5) are among them. The evaluation harness (PLAN §13) then runs live.

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

If you prefer to register it by hand: your organization's Settings > Developer settings > GitHub Apps > New GitHub App, copying each value from `infra/github-app-manifest.json` (the name is at most 34 characters; the permissions are PLAN §15's; Workflows is not requested; set a webhook secret). Then Private keys > Generate a private key; a PEM downloads ([registering a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app)).

Values:
- `GITHUB_APP_ID` → RW
- `GITHUB_APP_CLIENT_ID` → RW (ADR-122). The manifest conversion returns it as `client_id`.
- `GITHUB_APP_PRIVATE_KEY`, the whole PEM → RW. In Railway use the Raw Editor or Cmd/Ctrl+Enter for the line breaks. (GitHub refuses secret names that start with `GITHUB_`, so these could not be GitHub secrets in any case.)
- `GITHUB_APP_WEBHOOK_SECRET` → RW
- `GITHUB_APP_CLIENT_SECRET` → RW, **`api` only** (ADR-291). The manifest conversion returns it as `client_secret`; if you register by hand, App settings > Client secrets > Generate a new client secret (it is shown once). The api exchanges the installer's authorization code with it when a merchant connects GitHub; no other service holds it.
- `GITHUB_APP_SLUG` → RW on `web` (not a secret): the App's URL name, the last part of `https://github.com/apps/<slug>`. The manifest conversion returns it as `slug`.
- `CODE_FIX_CHANNEL_ENABLED` → RW on `api`, `ctl` and `web`: `false` until you have decided to ship the pull-request channel. The App Store build keeps it `false` (ADR-290); with it off, every route and job of the channel answers 404 or does not run.

To make a new key later: Settings > Developer settings > GitHub Apps > Edit > Private keys > Generate a private key. Keys do not expire and up to 25 can exist, which allows a rotation with an overlap.

Check: `rsctl doctor --row 4`. It signs an App JWT with the private key and calls `GET /app`, which accepts only an App JWT, then compares the returned `id` and `client_id` with `GITHUB_APP_ID` and `GITHUB_APP_CLIENT_ID`. It cannot check the webhook secret. Then a pull request is opened on the test theme repository (LAUNCH.md section E).

Docs: [register from a manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest) · [manifest conversion API](https://docs.github.com/zh/enterprise-cloud@latest/rest/apps/apps) · [public or private](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/making-a-github-app-public-or-private) · [private keys](https://docs.github.com/en/enterprise-cloud@latest/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps) · [transfer ownership](https://docs.github.com/en/apps/maintaining-github-apps/transferring-ownership-of-a-github-app)

### 13. Stripe, only for R3 (input 11)

Shopify merchants pay through Shopify App Pricing, so the App Store launch does not need Stripe. Skip this until R3.

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
- `STRIPE_SECRET_KEY` → RW
- `STRIPE_PUBLISHABLE_KEY` (*public*) → RW
- `STRIPE_WEBHOOK_SECRET` → RW. Sandbox and live endpoints have different secrets.

Check: `rsctl doctor --row 11`. It retrieves the account with the secret key and checks the documented shapes of the three values and that the publishable key and secret key are in the same mode. The publishable key and the signing secret have no read call, so only their shapes are checked. Then the test subscription lifecycle runs.

Docs: [account setup](https://docs.stripe.com/get-started/account/activate) · [API keys](https://docs.stripe.com/keys) · [webhooks](https://docs.stripe.com/webhooks) · [signing secret](https://docs.stripe.com/webhooks/signature)

### 14. Attorney review and App Store submission (input 13, part 2)

1. Have the attorney review the drafts, each marked "attorney review required" and listing its placeholders and open questions at the top: `docs/legal/privacy-policy.md`, `docs/legal/terms-of-service.md`, `docs/legal/data-processing-addendum.md` and `docs/accessibility-statement.md`, and the claims policy (PLAN §3, §25). The privacy policy is required for the listing. Nothing is published until you approve it, and you record the attorney's sign-off in `docs/STATUS.md`.
2. Partner Dashboard > Settings > Payouts and Taxes. Payouts go through Hyperwallet, with a $25 minimum.
3. Fill in the App Store review page:
   - Configuration: URLs, compliance webhooks, a 1200×1200 icon, an API contact email without "Shopify" in it, and the emergency contact's email and phone.
   - Create a listing, using the builders' package in `listing/shopify-app-store/` (`listing.md` has the copy, `reviewer-instructions.md` the testing instructions, `screencast-script.md` the screencast). Its copy may be used only once each line is true in the running app. Decide first what ADR-141 asks (see "A decision to make now").
   - Pricing: enter the PLAN §20 plans, with the handles and top features in section 5. New public apps define plans in this form, in the Partner Dashboard rather than the Dev Dashboard.
   - Protected customer data: opt out, since there are no customer scopes (PLAN §14). You can't apply while the app is under review.
   - Run the automated checks until they pass.
   - Add the testing instructions, test credentials and a screencast.
   - Then Submit.
4. Add noreply@shopify.com to your allowed senders, and answer reviewer emails. Repeatedly not responding can get you temporarily suspended.
5. The status moves Draft > Submitted > (Paused) > Reviewed > Published.

Docs: [review process](https://shopify.dev/docs/apps/launch/app-store-review/review-process) · [submit for review](https://shopify.dev/docs/apps/launch/app-store-review/submit-app-for-review) · [prepare for review](https://shopify.dev/docs/apps/launch/app-store-review/pass-app-review) · [App Store requirements](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements) · [best practices](https://shopify.dev/docs/apps/launch/shopify-app-store/best-practices) · [App Pricing](https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing) · [getting paid](https://help.shopify.com/partners/getting-started/getting-paid)

### 15. GitHub repository settings (input 14)

No outside wait and nothing needed first: do it early, and before R0 merges to `main`.

1. **Branch ruleset on `main`:** Settings > Rulesets > New ruleset > New branch ruleset; target the default branch; enforcement **Active** ([creating rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository)). Rules ([available rules](https://docs.github.com/en/enterprise-cloud@latest/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)):
   - Require a pull request before merging, with **Squash** as the only allowed merge method.
   - Require status checks to pass: `rust`, `node` and `contracts` (job names in `.github/workflows/ci.yml`, ADR-016).
   - Require linear history. Block force pushes. Restrict deletions.
2. **Keep the scheduled STATUS.md commits reaching `main`.** The scheduled sessions commit `docs/STATUS.md` straight to `main`. A pull-request rule blocks that unless the account those sessions push with is on the ruleset's **bypass list** with **Always allow** ("For pull requests only" would still block a direct push). The list accepts repository admins, maintain or write roles, teams and GitHub Apps. Add the role that account holds (for your own account on your own repository, "Repository admin") with **Always allow**. Anyone pushing with that account then bypasses every rule above, so keep it protected by a hardware key. After saving, the next scheduled STATUS.md commit should appear on `main`.
3. **Renovate:** install the Mend Renovate app from `https://github.com/apps/renovate` on this repository only ("selected repositories") ([installing and onboarding](https://docs.renovatebot.com/getting-started/installing-onboarding/)). `renovate.json` is committed, so once R0 merges, Renovate treats the repository as onboarded and opens its grouped pull requests on its Monday schedule.
4. **Push protection** for secrets: Settings > Advanced Security > enable Secret Protection, then Push protection ([push protection](https://docs.github.com/en/code-security/secret-scanning/enabling-secret-scanning-features/enabling-push-protection-for-your-repository)).
5. **Environments** `staging` and `production` (with you as required reviewer on `production`) and `backup-drill` (no reviewer): see section 0 and section 16. All three deploy from `main` only. Leave "Prevent self-review" off while you are the only reviewer, or you cannot approve your own deploys.
6. **No repository secrets.** Settings > Secrets and variables > Actions > Secrets tab must show nothing under Repository secrets for the founder secret names in this guide (and nothing at organization level). The `secrets-scope` job of `ci.yml` checks the names and fails the build if one exists.

Values: none.

Check: the settings are the check. A test pull request shows the three required checks; Renovate opens its first pull request; a scheduled STATUS.md commit lands on `main`.

### 16. Nightly backup and weekly restore drill (input 16)

No cost beyond the R2 storage of section 10. Do this after section 10 and once the deploy workflow has created the Railway services. Until the `backup` service has its variables, it logs a warning that names this section and exits 0, so it never looks like a crash; until `BACKUP_DRILL_READY` is `true`, the weekly drill shows a warning and skips.

You create: a database login, age keys, a signing key pair per environment, the Railway variables of the `backup` service (sealed), the GitHub environment `backup-drill`, and one repository variable. You also delete two GitHub environments that an earlier design created (step 6).

1. The database login, once per Railway environment. In a Railway shell on the PostgreSQL service, as the database owner, with a new password from `openssl rand -base64 24`:
   `BACKUP_DB_PASSWORD='<the password>' psql -X -v ON_ERROR_STOP=1 -d <database> -f infra/backup/backup-role.sql`
   It creates `rampsmith_backup`: read-only, `BYPASSRLS` (without it `pg_dump` fails loudly), owns nothing. Builders can send you the file.
2. Age keys, on your machine ([age](https://github.com/FiloSottile/age)). The backup is encrypted to public keys, so the service holds no key that can open it.
   - Staging: `age-keygen -o staging-drill.key` (note the `age1...` public key it prints) and `age-keygen -o staging-offline.key`. Staging data is test data, so the first key may sit in GitHub as the drill's key.
   - Production: `age-keygen -o production-primary.key` and `age-keygen -o production-offline.key`. Production's private keys never go to GitHub or Railway: the primary in your vault, the offline key on paper or a hardware token in a different place. A production backup is restored by you (`docs/runbooks/restore-from-logical-backup.md`), which is also the quarterly drill.
   - All keys classic (`age-keygen`) or all post-quantum (`age-keygen -pq`); age refuses a mix in one list (ADR-173).
3. Signing keys, on your machine, from a checkout, once per environment: `infra/backup/signing/generate.sh --environment staging --private-out ~/rampsmith-staging-signing.key` (then `production`). Each backup's metadata is signed, so a restore trusts the signature and a key committed in the repository, not whatever is in the bucket (ADR-256). The script writes the private key to the file you name (mode 600; it refuses a path inside the repository, and never prints it) and the public key to `infra/backup/signing/<environment>.pub.pem`. Commit the two `.pub.pem` files (public keys; builders will do it if you send them). The private key goes only into step 4's `BACKUP_SIGNING_KEY` of that environment, and into your vault.
4. Railway variables, in **each** environment (RW), and **sealed in every environment, production and staging alike** (Railway: *Variables* > the variable's menu > *Seal*; a sealed value cannot be read back, is not copied into pull-request environments and is not shown by `railway variables`):
   - `BACKUP_R2_ACCESS_KEY_ID` and `BACKUP_R2_SECRET_ACCESS_KEY`, the `rampsmith-backup-<environment>` token of section 10 → RW, sealed. Staging gets the staging token and production the production token, never the other way round.
   - `BACKUP_DB_PASSWORD`, the password from step 1 → RW, sealed
   - `BACKUP_SIGNING_KEY`, the contents of that environment's private key file from step 3 (one line) → RW, sealed
   - `BACKUP_AGE_RECIPIENTS`, the two public keys of that environment, one per line (*public*) → RW
   - `R2_ACCOUNT_ID` and `R2_BUCKET_BACKUPS` from section 10 are already there (the bucket of that environment).
   Then deploy. At 02:17 UTC the service dumps the database over Railway's private network, encrypts it, uploads it and prunes by the retention rules. The deploy workflow only warns if Railway does not report the cron service's first deployment as successful (ADR-251).
5. The GitHub environment `backup-drill` (section 0): deployments from `main` only, no required reviewer. Then:
   - secrets: `DRILL_R2_ACCESS_KEY_ID` and `DRILL_R2_SECRET_ACCESS_KEY`, the `rampsmith-drill` token of section 10 (Object Read only, staging bucket); `BACKUP_DRILL_AGE_KEY`, the line that starts with `AGE-SECRET-KEY-1` from `staging-drill.key` (not the comment lines). For example `gh secret set BACKUP_DRILL_AGE_KEY --env backup-drill` and paste the line.
   - environment variables (not secrets): `gh variable set R2_ACCOUNT_ID --env backup-drill --body <id>` and `gh variable set R2_BUCKET_BACKUPS --env backup-drill --body rampsmith-backups-staging`. The drill refuses any other bucket, and refuses to run if the staging public key is not committed.
6. Delete two GitHub environments. The first backup design ran as a workflow, and GitHub creates an environment, unprotected, the first time a workflow names one that does not exist. If Settings > Environments lists `backup-production` or `backup-staging`, delete both (`gh api -X DELETE repos/<owner>/<repo>/environments/backup-production`, and the same for `backup-staging`). The `drill-strays` job fails the weekly run while either exists, when the workflow token may list environments, and warns otherwise.
7. The repository variable, once steps 5 and 6 are complete: `gh variable set BACKUP_DRILL_READY --body true`. On the next Monday run, or `gh workflow run restore-drill.yml`, the job `live restore (staging)` restores the newest staging backup in a throwaway PostgreSQL 18. Before it starts, `drill-scope` fails if any backup or drill secret exists at repository level, and `drill-protection` fails unless `backup-drill` deploys from `main` only. The repository is public, so the job uploads one summary file with fixed fields, never the restored data (ADR-255).

Values:
- `BACKUP_R2_ACCESS_KEY_ID` → RW
- `BACKUP_R2_SECRET_ACCESS_KEY` → RW
- `BACKUP_DB_PASSWORD` → RW
- `BACKUP_SIGNING_KEY` → RW, sealed, one per environment
- `BACKUP_AGE_RECIPIENTS` (*public*) → RW
- `DRILL_R2_ACCESS_KEY_ID` → GH env `backup-drill` only
- `DRILL_R2_SECRET_ACCESS_KEY` → GH env `backup-drill` only
- `BACKUP_DRILL_AGE_KEY` → GH env `backup-drill` only, the staging key
- `BACKUP_DRILL_READY` (*public*) → a repository variable, not a secret

Check: `rsctl doctor --row 16 --environment staging`, with the staging values exported on your machine. It writes, reads back and deletes an object with the backup token, reads with the drill token and expects a write to be refused, and checks the shape of the password, the recipients, the signing key and the drill key. Then `rsctl doctor --row 6` for the engine's token. It cannot try the database password (the database is on Railway's private network) or that the drill key opens what the recipients encrypt: the first nightly run and the first green `live restore (staging)` job are those checks (LAUNCH.md section E).

Docs: [Railway cron jobs](https://docs.railway.com/reference/cron-jobs) (source: `railwayapp/docs`, `content/docs/cron-jobs.md`; the URL is not verified) · [age](https://github.com/FiloSottile/age) · [GitHub: deployment environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments) · [gh variable set](https://cli.github.com/manual/gh_variable_set)

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
- **SES permissions:** the sending user also needs `ses:GetAccount` and `ses:GetEmailIdentity`, or `rsctl doctor --row 7` fails with a 403.
- **R2 tokens:**
  - Make four (engine, backup for each environment, drill), each scoped to its own bucket and permission; one token for everything would let the engine delete backups.
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
- **GitHub secret names:** GitHub refuses names that start with `GITHUB_`. A secret of an environment is visible only to a job that names the environment, and a job that `needs` a failed check never starts, so its secrets are never handed out.
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
   - You do these from the builders' list. A workflow that does them with a workspace or account token (`RAILWAY_API_TOKEN`, then a secret of the `production` environment) does not exist yet.
   - PR preview environments (PLAN §22) need a workspace token too, or Railway's PR Environments switch (Project Settings > Environments) with the project connected to GitHub.
3. **DNS records.** Unless you give builders a Cloudflare API token, only you can add them:
   - for Railway domains, a CNAME and a TXT for each;
   - for SES, 3 CNAMEs, 1 MX and 2 TXT;
   - for Email Routing.
4. **An inbox on the domain** for support mail, DMARC reports and Shopify review mail.
   - Use Cloudflare Email Routing: Compute > Email Service > Email Routing > Onboard Domain.
   - Add and verify a destination address, then add a routing rule.
   - SES here only sends.
5. **App Store form items.** You enter the App Pricing plans and the emergency contact's phone number, and you prepare the privacy policy URL, support contact, icon, test credentials, demo store and screencast. Payout and tax details are needed to get paid.
6. **GitHub settings only the owner can change:** the `staging` and `production` environments with you as reviewer and the `backup-drill` environment (all deploying from `main` only; section 0), protection for `main`, Renovate and push protection. The steps are in section 15.
7. **A test GitHub organization and theme repository** (PLAN §22), with both GitHub apps installed on that repository only.
8. **The staging copies' variables** use the same names as production, set in the Railway `staging` environment, and the staging app's `SHOPIFY_APP_AUTOMATION_TOKEN` in the GitHub `staging` environment (LAUNCH.md section C, row 15).
9. **Optional:** separate staging R2 buckets and token, and a separate staging Anthropic key.
10. **A GitHub App registration helper.** GitHub's flow needs a form POST and a code exchange within the hour, so ask builders to provide one.
11. **Security:**
    - hardware security keys on GitHub, Railway, Shopify Partners, Cloudflare, Anthropic and Stripe (PLAN §18);
    - an offline encrypted vault for every secret (PLAN §22);
    - reminders before each token expires.
12. **Alerts to your phone** through Grafana Cloud (PLAN §21). Setup not verified.
13. **Insurance quotes** once revenue starts (PLAN §25).

Docs for this section: [Railway PR environments](https://docs.railway.com/guides/preview-deployments-with-pr-environments.md) · [Railway domains](https://docs.railway.com/networking/domains/working-with-domains) · [Railway PITR](https://docs.railway.com/volumes/point-in-time-recovery.md) · [Cloudflare Email Routing](https://developers.cloudflare.com/email-service/get-started/route-emails/) · [Email Routing overview](https://developers.cloudflare.com/email-routing/get-started/enable-email-routing/)

## Open questions for you and the builders

1. ADR-141: may the App Store build include the pull-request channel, and may it include the patched theme package, given requirements 5.1.1 and 1.1.3? ("A decision to make now.")
2. Which account the scheduled STATUS.md commits push with, so the right role goes on the ruleset's bypass list (section 15).
3. Whether the `images` CI jobs should also be required checks once they are stable.
4. Whether a Shopify plan handle can be edited after the plan is created (Shopify's pages do not say), and the exact wording of the dashboard buttons marked "not verified".
5. The exact form of `OTEL_EXPORTER_OTLP_HEADERS` the exporters accept: use the value Grafana's Configure flow generates, and `rsctl doctor --row 9` tells you if it is refused.
6. How Railway reports a cron service's deployment (SUCCESS, or a state of its own), and the Railway CLI command that runs the `backup` service once on demand: the deploy workflow only warns about the first, and LAUNCH.md section E records both once you have seen them.
