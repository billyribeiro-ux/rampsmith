# Shopify API version upgrade

| | |
| --- | --- |
| Answers | PLAN §24 "Quarterly: Shopify API version upgrade branch"; PLAN §21 "Synthetic run failed" (the check meant to catch a breaking Shopify change before a merchant does); Shopify's deprecation notices |
| Severity | Scheduled upgrade: SEV4. A deprecation with a deadline: SEV3 until two weeks before it, then SEV2. A request that Shopify served from a different version than the one asked for: SEV2 |
| Use it when | Each quarter (below); a deprecation or breaking-change notice arrives; the `X-Shopify-API-Version` response header ever differs from the version the code requested |
| Decisions behind it | ADR-178; the version lives in the places listed in step 2 |
| Verified | 2026-10-19 against Shopify's versioning page and the repository. The commands are `git`, `cargo` and `mise` and run as written; the staging steps need a development store (LAUNCH.md C rows 1 and 3) and the synthetic journey does not exist yet |

## What Shopify commits to (shopify.dev/docs/api/usage/versioning, read 19 Oct 2026)

- A new version every three months, at 5 pm UTC on the first day of the quarter: `2026-10` is "Latest stable", `2027-01` the release candidate; on 1 January 2027 at 17:00 UTC `2027-01` becomes stable and `2027-04` becomes the candidate. Release candidates "may include backwards-incompatible changes, so not recommended for production".
- Each stable version is supported for at least 12 months, with at least nine months of overlap between consecutive versions.
- A request to a version that is no longer accessible is **served by the oldest accessible stable version** ("falls forward"); the Admin API response header `X-Shopify-API-Version` shows the version actually used, and webhooks carry `X-Shopify-Api-Version`. Webhook payloads are versioned the same way.
- Deprecations arrive through Dev Dashboard alerts, warnings in GraphiQL, the developer changelog and the app's emergency developer contact (LAUNCH.md C row 13). A deprecated API still works until it does not ("it can stop working at any time"). An app that stays on an unsupported resource past a deadline can be delisted.

**The rule this runbook enforces:** adopt each stable version within one quarter of its release, so Rampsmith is never more than one version behind and never within nine months of losing support.

## What exists, and what does not

| Piece | State |
| --- | --- |
| The version constants and the tests that read them | Built (step 2) |
| `mise run verify` (the whole gate) | Built |
| Staging end-to-end run on the development store (install, scan, approve, verify, undo) | Specified in PLAN §23; needs LAUNCH.md C rows 1 and 3 |
| The synthetic install-scan-fix journey (PLAN §21, §24) | **Not built.** The staging end-to-end run is the gate until it is |
| Code that compares the response header `X-Shopify-API-Version` with the version it requested | **Not built.** Step 5 checks it by hand |
| The webhook intake and subscriptions | Built (ADR-080, ADR-088): the webhook half of the upgrade is the `api_version` line in `shopify.app.toml` (and in each `shopify.app.<environment>.toml`), plus the payload parsers in `crates/api/src/webhooks.rs` (`body_fits_topic`) |

## Quarterly steps

### 1. Read what changed (on the day the new version is released)

On the first day of the quarter, the new stable version and the next release candidate appear together. Open a ticket "Shopify API <version>" and read:

- `https://shopify.dev/changelog/release-notes/<version>` for the new stable version, and the same page for the candidate (a preview of the next upgrade);
- the developer changelog entries marked as deprecations;
- the Partner API page for the same version, **separately**: the Partner API is versioned on its own (`https://shopify.dev/docs/api/partner/<version>`), and Rampsmith's Admin API client, its billing client and `rsctl doctor` each carry their own constant.

List every item that touches a resource, field or webhook Rampsmith uses (PLAN §14 scopes and topics) in the ticket. An empty list is a valid answer.

### 2. Find every place the version is spelled

On a branch named `shopify-api-<version>`:

```sh
git switch -c shopify-api-<version>
git grep -n -F -e '"2026-10"' -e '/2026-10/' -- ':!docs' ':!*.lock'
```

Replace `2026-10` with the version you are leaving. Expected hits and what each is:

| Place | What it is | Change? |
| --- | --- | --- |
| `crates/shopify/src/lib.rs` `API_VERSION` | The Admin API version every call uses and `shopify_shops.api_version` is stamped with at install | Yes |
| `shopify.app.toml` `[webhooks] api_version` | The version webhook payloads are delivered in; `shopify app deploy` pushes it | Yes |
| `crates/billing/src/partner_api.rs` `PARTNER_API_VERSION` (`ws/billing`) | Partner API version for the plan sweep | Only after reading the Partner API page; it may stay |
| `crates/rsctl/src/doctor/partner_api.rs` `PARTNER_API_VERSION` and the Admin API path in `doctor`'s Shopify probe (`ws/rsctl`) | `rsctl doctor`'s probes | Follow the two above |
| Test fixtures that assert `"2026-10"` | Recorded request shapes | Update those that assert the constant |

`shopify_shops.api_version` is written at install and reinstall and read by nothing else; **do not backfill existing rows** (a data change for no effect). New and reinstalled shops carry the new value.

### 3. Run the gate

```sh
mise run verify
```

It must pass with zero warnings. The Rust tests for the Shopify clients run against recorded responses, so they prove the code compiles and parses what was recorded, **not** that the new version behaves the same: that is step 4's job.

### 4. Prove it on staging

Merge to `main` through the normal pull request; `release.yml` deploys staging (`deploy.yml` also runs `shopify app deploy` there, which pushes the new webhook `api_version`). On the staging development store:

1. The end-to-end run: install, scan, approve an alt-text fix, verify, undo (PLAN §23). It must be green.
2. `rsctl doctor --environment staging` (rows 1 and 2 are the Admin and Partner API probes). Every row `PASS` or a `SKIP` that names an input still missing.
3. Watch `railway logs --service ctl --environment staging --since 1h --filter "@level:error"` and the dead-job summary (`docs/runbooks/sql/jobs-dead.sql`, [dead-letter triage](dead-letter-triage.md)): no new dead `shopify.*` jobs.

### 5. Check that Shopify served the version you asked for

Fall-forward is silent: the call succeeds against an older version. With any valid Admin API token for the development store, one call shows the header:

```sh
umask 077
read -rsp 'Admin API access token: ' TOKEN; echo
printf 'X-Shopify-Access-Token: %s\n' "$TOKEN" > ./shopify-header.txt; unset TOKEN
curl -sS -D - -o /dev/null -X POST "https://<store>.myshopify.com/admin/api/<version>/graphql.json" \
  -H @./shopify-header.txt -H "Content-Type: application/json" \
  -d '{"query":"{ shop { id } }"}' | grep -i '^x-shopify-api-version'
rm -f ./shopify-header.txt
```

The token is read without echo and handed to `curl` from a private file, so it is on no command line. The header must equal `<version>`. A different value means the version you target is not accessible: stop and find out why before production.

### 6. Production

Same release, the production approvals (one for Railway, one for the Shopify app deploy). Afterwards, for 24 hours: PLAN §21's API 5xx page, any dead `shopify.*` job (page), `rsctl doctor --environment production`, and the support view. Keep the previous release's image digests (the release run summary lists them) until the day is over.

### 7. Close

Record in the ticket: versions before and after, the items from step 1 and what was done, the header check, and the time. If a recipe, query or behaviour changed in a way someone will want to find later, write an ADR.

## Unscheduled triggers

- **A deprecation or breaking-change notice** (changelog, Dev Dashboard alert, an email to the emergency contact): put the deadline in the ticket, open the same branch, and do steps 1 to 6 for the version that fixes it, even mid-quarter. It is SEV3 until two weeks before the deadline.
- **Fall-forward observed** (step 5, or a surprising payload): SEV2. The fastest fix is the bump (steps 2 to 6 on an accelerated path, with the end-to-end run as the gate).
- **A webhook payload changed shape**: the subscription's `api_version` in `shopify.app.toml` decides which shape arrives; the parsers must accept both during the overlap.

## Rollback

Shopify keeps an earlier version available for at least 12 months. Roll the code back by running `deploy.yml` by hand from `main` with the previous release's commit and digests (ADR-185, on `ws/deploy`); roll the webhook version back by deploying the earlier `shopify.app.toml` (revert the commit, then the normal release, which runs `shopify app deploy`). Migrations are never rolled back; this upgrade has none. Existing `shopify_shops.api_version` values were not changed, so there is nothing to restore.

## Escalation

Shopify's status (<https://shopifystatus.com>), the developer community forum and Partner support for an unannounced change; the emergency developer contact receives imminent breaking changes (LAUNCH.md C row 13, set in the Partner Dashboard). A merchant-visible failure during the upgrade is an incident: [incident response](incident-response-and-postmortem.md).
