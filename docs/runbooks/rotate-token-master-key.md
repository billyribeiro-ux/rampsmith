# Rotate the token master key

| | |
| --- | --- |
| Answers | The SLO "Shops losing access because Rampsmith failed to refresh a token" (target 0) and the pages "Token refresh failures for any shop" and "Any dead job in … token-refresh queues" (PLAN §21), which a wrong key causes; PLAN §22 "Secrets" |
| Severity | Planned change: SEV4 (do it in a quiet period). A leaked or suspected ring: SEV1, then follow the leak section |
| Use it when | A person with access to the ring leaves; a ring may have leaked; on the schedule the founder sets (PLAN gives none; once a year is a sensible default). Losing the ring is survivable by design (PLAN §22: merchants re-authenticate), but a *wrong* rotation is not free, so this runbook goes slowly |
| Decisions behind it | ADR-021 (the ring format), ADR-153 (`rsctl keys`), ADR-177 (this procedure) |
| Verified | 2026-10-19. The `rsctl keys` commands and `doctor --row 12` come from ADR-153 and its evidence (`ws/rsctl`, 18 CLI tests); the SQL file was run on PostgreSQL 18.6 with the repository migrations (58 checks, `infra/restore-drill/tests/runbook-sql.sh`). **The Railway steps and the end-to-end refresh were not run on a live project**: Section E rows |

## What exists, and what does not

| Piece | State |
| --- | --- |
| `rsctl keys generate \| rotate \| drop \| ids`, `rsctl doctor --row 12` | Built on `ws/rsctl`. Until that branch is on `main`, build it from the production commit's tree plus that branch: `cargo build --release -p rampsmith-rsctl`, binary `target/release/rsctl` |
| `docs/runbooks/sql/master-key-usage.sql` | Built and tested |
| A job that re-wraps stored values with `KeyRing::rewrap` | Built in `crates/ctl/src/rewrap.rs` (`Rewrap::run`). It re-wraps `shopify_tokens` and, since the lane A audit (L4), `sites.storefront_password_ct`, each with a compare-and-swap. `Rewrap::remaining` counts both, so a key is removable only when neither table holds it. The operator command `rsctl keys rewrap` that calls it is not built: until it is, old keys stay in the ring until the report in step 8 says nothing uses them |
| A staging mode that adds the new key last | **Not built** in `rsctl keys rotate` (it always puts the new key first). Step 5 explains the short window this leaves |
| A job that forces every shop's tokens to refresh | **Not built**. The weekly keep-alive does it for every installed shop |

`api` and `ctl` read `RAMPSMITH_MASTER_KEYS`; `engine`, `egress` and `web` do not (ADR-182). The ring is a Railway shared variable per environment and is sealed: Railway never shows it again after it is set ("You cannot read the current value back"). **The vault is the only source of the current ring.**

## How the ring works (so the steps make sense)

`RAMPSMITH_MASTER_KEYS` is `id:key[,id:key…]`, newest first. The first key seals new values; every key opens. Each stored value records the id that wrapped it (`shopify_tokens.key_id`). Rotation puts a new key first and keeps the old ones, so everything stored still opens. A key can leave the ring only when no stored value names it. When a refresh runs, the new token pair is sealed under the *active* key, so every shop's row moves to the newest key within about a week through the weekly keep-alive (inferred from `crates/shopify-auth/src/lib.rs`; confirm on staging).

## Staging first, then production

Do steps 1 to 7 in `staging` with its own ring, look at the result for a day, then repeat in `production` with its ring. The two rings are different (LAUNCH.md C row 12).

### 1. Make the new ring

On a trusted machine, in a private directory (a memory file system such as `/dev/shm` on Linux), with the current ring from the vault:

```sh
umask 077
mkdir -p /dev/shm/rs-rotate-<ticket> && cd /dev/shm/rs-rotate-<ticket>
read -rsp 'current ring (from the vault): ' RING; echo
printf '%s\n' "$RING" | rsctl keys rotate --stdin --output new-ring.txt
unset RING
rsctl keys ids --stdin < new-ring.txt
```

`rsctl` reads the ring from standard input, never from an argument (arguments show in process lists and shell history). It writes the new ring to a new file with mode 0600 and refuses to overwrite one. The note on standard error reads like `new active key k20261019; older keys kept: k20260101`. `ids` lists the ids, newest first: the new id first, then every old id. Exit codes: 0 done, 1 refused (the ring did not parse, an id is bad, duplicate or unknown), 2 could not run (no ring supplied, the output file exists). A second rotation on the same day gets the id suffix `-2`, `-3`.

### 2. Put the new ring in the vault before it goes anywhere else

Store `new-ring.txt` as the current entry for the environment and relabel the old one "previous (until <date>)". PLAN §22 keeps current and previous. Read the vault entry back and check it:

```sh
rsctl keys ids --stdin < new-ring.txt
RAMPSMITH_MASTER_KEYS="$(cat new-ring.txt)" rsctl doctor --row 12
```

Expected: `PASS  C12  master-keys.round-trip  2 key(s) parse; the active key … seals and opens a probe value, and each of the 1 older key(s) does too`, `1 passed, 0 failed, 0 skipped`. `doctor` makes no network call for this row.

### 3. Set it

Railway dashboard, the environment, Project Settings > Shared Variables > `RAMPSMITH_MASTER_KEYS`: edit the value (for a sealed variable, from its menu), paste the contents of `new-ring.txt`. The edit is **staged**: "Nothing hits your running services until you click Deploy on the changeset". Open the changeset's Details, check that only `RAMPSMITH_MASTER_KEYS` changed, then Deploy. Do not hold Alt while clicking: that commits without redeploying.

### 4. The rollout

One deploy moves every consumer of a shared variable together; each service becomes active only after its health check answers 200, and the old deployment keeps serving if the new one fails. `api` and `ctl` are the consumers. A malformed ring stops a process at boot (`RAMPSMITH_MASTER_KEYS is invalid` in its log) so its health check never passes and the old deployment keeps serving: nothing changed, go to Rollback.

### 5. Look for the one known window

A new `api` may seal a value under the new key a little before the old `ctl` restarts. If `ctl` ran a token-refresh job for that very shop in that interval, it would fail with `crypto` (permanent) and go dead. After both services show the new deployment:

```sh
railway logs --service ctl --environment <env> --since 30m --filter "job is dead"
```

and, as `rampsmith_worker` inside a break-glass session (`railway connect postgres --environment <env> --ssh`, then at the psql prompt):

```text
\set code crypto
\i docs/runbooks/sql/jobs-dead.sql
```

(Start `railway connect` from the root of a checkout so the relative path resolves. `jobs-dead.sql` and the other job files `set role rampsmith_worker`, so they see every job and nothing tenant-owned.) Expect no rows. If there are some, both services now hold the new ring, so retrying is safe; follow [dead-letter triage](dead-letter-triage.md), "retry", for each id.

### 6. Verify

- `curl -fsS https://<host>/readyz` answers 200 for `api`; `railway logs --service ctl --environment <env> --since 10m --filter "@level:error"` shows nothing new.
- **A real refresh opens an old value and seals a new one.** In staging with a development store installed (LAUNCH.md C rows 1 and 3): note the time, wait for or provoke a token refresh for the store (opening the app after the access token's hour is up refreshes it inline), then in a break-glass session:

```text
\i docs/runbooks/sql/master-key-usage.sql
select at, action from audit_log where action = 'shopify.token_refreshed' order by at desc limit 3;
```

The report must show that shop's row under the new id, and `audit_log` a `shopify.token_refreshed` row after the rotation. `master-key-usage.sql` refuses to run unless the role bypasses row-level security (the superuser does), so a zero can never be a silent artefact of RLS.

Without a development store this check cannot be made; say so in the ticket and treat the rotation as unverified until it is (Section E).

### 7. Record it

Ticket: environment, ids before and after, time, who. The vault entries are the record of the keys. Delete `new-ring.txt` and the directory; clear the terminal.

### 8. Dropping an old key (later; never the same day)

An old key can go when the report shows no row uses it. Run `master-key-usage.sql` (break-glass) a week or more after the rotation. If every `key_id` is the newest id, the old keys are unused by *current* data. Before dropping, also decide about backups: stored backups (30 daily, 12 monthly) hold values sealed under old keys. A restore of one needs the ring that sealed it, so keep the vault's "previous" ring until the oldest backup sealed with it has aged out, or accept that a restore of such a backup means merchants re-authenticate (refresh tokens last 90 days, so tokens in a backup older than that are dead anyway).

```sh
read -rsp 'current ring (from the vault): ' RING; echo
printf '%s\n' "$RING" | rsctl keys drop --stdin --id <old id> --output next-ring.txt
unset RING
```

`rsctl keys drop` refuses the active key and any id not in the ring, and it cannot see the database: confirming nothing uses the key is your step. Then repeat steps 2 to 6 with `next-ring.txt`. **A key dropped while a row still names it makes that shop's next refresh fail with `crypto` (permanent), pages, and costs the merchant a re-authentication.** If that happens, put the previous ring back from the vault (Rollback) and retry the dead jobs.

## If a ring may have leaked (SEV1)

1. Open the incident ([incident response](incident-response-and-postmortem.md)). A ring alone opens nothing: it needs the ciphertext, which is in the database and in every backup. Find out whether either was reachable.
2. Rotate now (steps 1 to 6; skip the day of staging). Make a second rotation if the first ring was ever typed somewhere untrusted.
3. The leaked key keeps opening values sealed under it, including those in backups, for whoever holds both. What retires the *tokens* is Shopify: refreshing a token retires the old refresh token (ADR-022), and the weekly keep-alive refreshes every installed shop within about seven days. A job that forces every shop at once is not built; until the report shows no row under the leaked id, the exposure window is open.
4. Drop the leaked key as soon as step 8 allows, and say in the postmortem that backups taken while it was active stay readable by whoever has it (ADR-153).

## Rollback

- **The new deployment never became healthy:** Railway kept the old one. Discard the staged change or put the previous ring (vault, "previous") back as the value and Deploy. Nothing was sealed under the new key.
- **The new ring has served traffic:** do not remove the new key. Values sealed under it open only with it. Fix forward: correct whatever else is wrong and keep a ring that contains the new key. Redeploying the previous ring is for the case where you can show no value was sealed under the new one (it never went live, or no shop's tokens were written).
- **A wrong drop:** put the vault's previous ring back (it still holds the dropped key), Deploy, then retry the dead `crypto` jobs one by one after both services run it.

## Escalation

The founder owns the ring and the vault. If `rsctl doctor --row 12` fails on a ring from the vault, the vault copy is damaged: stop, and use the previous entry. If neither entry opens the stored values, the ring is lost: PLAN §22 treats this as survivable (merchants re-authenticate through token exchange); set a new ring, expect every shop to re-authenticate, and run it as SEV2 with a merchant notice ([incident response](incident-response-and-postmortem.md)).
