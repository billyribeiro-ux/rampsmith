# ADR-177: Key rotation runbooks: the token master key, the GitHub App private key and the webhook secret

- Status: Accepted
- Date: 2026-10-19
- Stream: WS-8 (`docs/runbooks/rotate-token-master-key.md`, `docs/runbooks/rotate-github-app-key.md`)
- Refines: PLAN §22 ("Secrets: exported to an offline encrypted vault after every rotation") and
  the "Runbooks" list; ADR-021, ADR-122, ADR-126, ADR-153 (the last three are on `ws/github-app`
  and `ws/rsctl` until those branches merge)

## Context

Two secrets need a rehearsed rotation: the master key ring that wraps every stored Shopify token
(`RAMPSMITH_MASTER_KEYS`, services `api` and `ctl`) and the GitHub App private key
(`GITHUB_APP_PRIVATE_KEY`, service `ctl`). The webhook secret (`GITHUB_APP_WEBHOOK_SECRET`,
service `api`) rotates with the second. Facts checked on 19 Oct 2026:

- **ADR-153** (branch `ws/rsctl`) defines the tool and the order: `rsctl keys rotate` prints the
  current ring with a fresh key first and every old entry unchanged; `rsctl keys drop --id ID`
  removes an old key and refuses the active one; `rsctl keys ids` lists ids; the ring comes from
  `--stdin` or `RAMPSMITH_MASTER_KEYS`, never from an argument; output goes to standard output or to
  a new 0600 file (`--output`); exit codes 0, 1 (refused), 2 (could not run). `rsctl doctor
  --row 12` parses the ring and round-trips every key without any network call. The ADR says no
  job in the repository calls `KeyRing::rewrap`, so old keys must stay in the ring.
- **Where the ring lives.** Founder inputs are Railway shared variables that `api` and `ctl`
  reference (`infra/railway/railway.py`, ADR-182 on `ws/deploy`), sealed. Railway's guide
  [Rotate API keys and database credentials without downtime](https://docs.railway.com/guides/rotate-credentials-zero-downtime)
  says: sealed variables are "hidden from the UI and API after being set", "You cannot read the
  current value back"; edits are staged and "Nothing hits your running services until you click
  Deploy on the changeset"; "Containers read variables at startup"; a new deployment becomes
  active only after its health check returns 200 and the old one keeps serving if it fails;
  "One deploy moves every consumer to the new key together" for a shared variable. The same guide
  lays out the order for a third-party key: issue the new key while the old one stays valid,
  update the variable, deploy and let the health check gate the cutover, verify, revoke the old
  key. [Staged changes](https://docs.railway.com/deployments/staged-changes): Deploy applies all
  staged changes; holding Alt while clicking Deploy commits them without a redeploy.
  `railway redeploy --service S --yes` redeploys a service's latest deployment
  ([CLI reference](https://docs.railway.com/cli/redeploy)).
- **What is sealed under the ring today.** The only sealed columns in the migrations are
  `shopify_tokens.access_ct` and `refresh_ct`, with `key_id` naming the wrapping key
  (`crates/db/migrations/20261017000002_core_tables.sql`). Every tenant table has the
  `tenant_isolation` policy, so counting rows per `key_id` across tenants needs a role that
  bypasses row-level security: the Railway PostgreSQL superuser (break-glass, PLAN §18). `rsctl`
  has no command that does it (`rsctl` has `doctor` and `keys` only).
- **What a wrong drop costs.** `ctl`'s `shopify.token_refresh` maps a `crypto` error to a permanent
  failure (`crates/ctl/src/token_refresh.rs`), so a token whose wrapping key was dropped goes to
  `dead` on its next refresh, which pages (PLAN §21), and the shop must re-authenticate; the SLO
  "Shops losing access because Rampsmith failed to refresh a token" is 0. PLAN §22 treats losing
  the whole ring as survivable; a deliberate drop is meant to cost nothing.
- **GitHub** ([Managing private keys for GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps),
  read from the `github/docs` repository): up to 25 keys per app, "so you can rotate keys without
  downtime"; keys never expire and "need to be manually revoked"; the download is PEM in PKCS#1
  format and GitHub keeps only the public half; a fingerprint is shown next to each key and can be
  recomputed with `openssl rsa -in PATH_TO_PEM_FILE -pubout -outform DER | openssl sha256 -binary |
  openssl base64`; the last key cannot be deleted before another exists. ADR-122: a JWT lives at
  most 10 minutes, installation tokens one hour and only in memory, the client signs with the
  current key on every App call, so no overlap logic exists or is needed in the client.
- **Webhook secret.** ADR-126: `WebhookVerifier::with_previous` accepts the old secret during an
  overlap, and every configured secret is checked on every delivery. No environment variable feeds
  `with_previous` and the `api` route is not built (no `/webhooks/github` route and no
  `webhook_events` table exist on `main`, `r0-foundations` or any stream branch, checked
  19 Oct 2026), so the overlap is a library property today and not an operational one. GitHub
  ([Handling failed webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries),
  [Redelivering webhooks](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks)):
  no automatic redelivery; redeliver failed deliveries within three days, in bulk through
  `GET /app/hook/deliveries` and `POST /app/hook/deliveries/{delivery_id}/attempts`.

## Decision

1. **The current ring comes from the vault, never from Railway.** Because the shared variable is
   sealed and cannot be read back, the runbook's first step is "fetch the current ring from the
   offline vault" and its last is "store the new ring there, then deploy". ADR-153's example
   `printf '%s' "$RAMPSMITH_MASTER_KEYS" | rsctl keys rotate --stdin` assumes the variable is in
   the operator's shell; here it is not, so the runbook reads the ring with a silent prompt and
   pipes it (`printf` is a shell built-in, so the ring is not in any process list).
2. **Order: staging, then production, each with its own ring.** LAUNCH.md C row 12 has one ring per
   environment. Staging is rotated first and a real token refresh is observed there before
   production.
3. **The new ring is in the vault before it is deployed.** A deployed ring that exists nowhere else
   cannot be recovered, and the old ring is no longer needed by that point only if the new one is
   safe. PLAN §22's "after every rotation" is therefore corrected to "before the rotation is
   deployed" (Plan correction).
4. **One staged change, one deploy.** The ring is edited in the shared variable (Project Settings >
   Shared Variables) and deployed with the changeset, so `api` and `ctl` move together; health
   checks gate each. A short window remains in which a new `api` has sealed a value under the new
   key and an old `ctl` has not yet restarted. A token refresh job for that very shop inside the
   window would hit `crypto` and go dead. The runbook closes the window by checking for dead
   `crypto` jobs after the rollout and making them ready again with the statement `queue::retry_dead`
   runs (ADR-178 records that statement and why it is run by hand). The better tool would let the
   new key be added last first (a "stage" mode in `rsctl keys rotate`); that is an integration
   note for the `rsctl` owner, not a workaround written here, because editing a ring by hand puts
   key bytes in an editor.
5. **Done means verified, not deployed.** The checks are: `rsctl doctor --row 12` on the new ring
   (parse and round trip); `/readyz` 200 on both services; and, in staging, a real
   `shopify.token_refresh` job that succeeded after the rollout (its `audit_log` row
   `shopify.token_refreshed`). The last check is the only one that proves `ctl` opens a value
   sealed under the old key with the new ring, and it is a Section E row until a development
   store exists (LAUNCH.md C rows 1 and 3).
6. **Old keys stay.** Until a job re-wraps stored values, dropping a key is forbidden by the
   runbook; the runbook gives the SQL that says which keys still wrap data
   (`select key_id, count(*) from shopify_tokens group by key_id`, run as the superuser,
   break-glass, recorded in the incident or change ticket) and says to extend the query to any
   table a later migration adds with a `key_id`. `rsctl keys drop` is shown with its safeguard
   (it refuses the active key) and with the condition that it is the operator's job to prove
   nothing is sealed under the dropped key.
7. **Rollback is "fix forward" once the new key has served traffic.** If the new deployment never
   became healthy, Railway kept the old one and nothing changed: discard the staged change. If it
   has served traffic, removing the new key makes everything sealed under it unreadable, so the
   rollback keeps the new key and corrects whatever else was wrong. Only an operator who can
   prove no value was sealed under the new key (it never became active, or nothing was written)
   may redeploy the previous ring.
8. **GitHub App key: dual-key overlap, then delete.** Generate the new key (the old one stays
   valid), store the PEM and compare fingerprints, check it with `rsctl doctor --row 4` (JWT to
   `GET /app`) from the operator's machine, set `GITHUB_APP_PRIVATE_KEY` in the shared variable,
   deploy `ctl`, confirm the next installation token mint succeeded, only then delete the old key
   at GitHub. The code accepts the PEM with real newlines, CRLF or literal `\n` (ADR-122), so
   whichever form the dashboard keeps works. A compromised key is deleted at once after the new
   one is live (still dual-key, but no waiting), and the incident runbook applies. Whether
   deleting a key invalidates installation tokens it already minted is not documented; the
   runbook assumes they live for up to an hour (ADR-122).
9. **Webhook secret.** Because the overlap code is not wired, the runbook says what to do today:
   change the secret at GitHub and in Railway in a quiet period, then redeliver what failed in the
   gap through the documented API, within the three days. The wired overlap (a
   `GITHUB_APP_WEBHOOK_SECRET_PREVIOUS` variable is the obvious shape, but no such name exists
   and this ADR does not invent it) is an integration note for the `api` owner.
10. **Out of scope here:** the Shopify client secret, the database passwords (re-running
    `infra/railway/bootstrap.sql` rotates them, its own header says so), R2 and SES credentials.
    PLAN §22 lists two key rotations; the others have no runbook in the nine.

## Consequences

- A rotation is about ten commands and two deploys, and stopping after the verify step is safe
  indefinitely; the cost is that old keys stay valid, which the vault note records.
- The runbook depends on `rsctl` (branch `ws/rsctl`, package `rampsmith-rsctl`). It says to build it
  from the same commit as production until `rsctl` is on `main`.
- The master-key runbook cannot be rehearsed end to end until the services run on Railway with a
  development store; the dry run of `rsctl` and the checks that need no store are available now
  (Section E row in `docs/evidence/ws-8-ops.md`).
- Backups hold sealed ciphertext, so a restore needs the ring that wrapped it; ADR-171 keeps the ring
  out of the backup, and the vault's "current and previous" (PLAN §22) is what makes a restored
  database readable. The restore runbooks say so.

## Rejected alternatives

- Reading the ring from Railway at rotation time: impossible for a sealed variable, and unsealing
  it to make it readable would put the ring in the dashboard history.
- Setting a literal `RAMPSMITH_MASTER_KEYS` on `api` and `ctl` separately to control the order of
  the rollout: the IaC test fails any secret that becomes a literal (ADR-182) and the next deploy
  would revert it.
- Dropping old keys after a fixed number of days: only the database knows what is still wrapped.
- Rotating the GitHub App key by replacing it at GitHub first: the last key cannot be deleted and a
  deleted key stops signing at once, so `ctl` would fail every installation-token mint until the
  deploy finished.

## Plan correction

PLAN §22, "Backups and recovery" table, row "Secrets". Replace the row with:

> | Secrets | Exported to an offline encrypted vault before each rotation is deployed, because Railway's sealed variables cannot be read back (ADR-177) | Current and previous |
