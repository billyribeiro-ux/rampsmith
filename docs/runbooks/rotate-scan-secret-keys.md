# Rotate the scan secret keys

| | |
| --- | --- |
| Answers | A protected store's scan that starts without its storefront password, or fails to open it (`scan.plan` logs "the saved storefront password cannot be opened" in `ctl`, or the engine reports an unknown scan secret key); PLAN §22 "Secrets" |
| Severity | Planned change: SEV4. A leaked or suspected ring: SEV2, then the leak section |
| Use it when | A person with access to `RAMPSMITH_SCAN_SECRET_KEYS` leaves; the ring may have leaked; on the schedule the founder sets (once a year is a sensible default) |
| Decisions behind it | ADR-266 (the hand-off and the ring), ADR-021 (the ring format), ADR-283 (copies are cleared when the scan ends and by a sweep after an hour), ADR-289 (this order) |
| Verified | 2026-10-22. The ordering rule below is pinned by tests: `crates/crypto/tests/vector.rs` (`a_rotated_scan_ring_seals_under_the_new_key_and_opens_both`, with a copy sealed by the old and the new key) and `packages/engine/test/scan-secret.test.ts` ("a rotated scan ring"). **The Railway steps were not run on a live project**: LAUNCH.md section E |

## What the ring is, and why the order matters

`RAMPSMITH_SCAN_SECRET_KEYS` is a ring `id:base64key[,id:base64key...]`, newest first (ADR-021), generated separately from the master ring and never equal to any key in it (`rsctl doctor --row 12` checks that). Two services hold it: `ctl` seals a protected store's password under the **first** key for one scan, and the engine opens that copy with the key whose id is stored next to it (`scans.storefront_password_key_id`). It is a Railway shared variable, so one deploy changes both services, but they do not restart at the same instant.

- If `ctl` seals with a key the engine does not have, the engine cannot open the copy: that scan runs without the password and reports the store as blocked. So **the engine gets the new key before `ctl` seals with it.**
- If the old key leaves the engine's ring while a copy sealed under it exists, the same happens. A copy lives until its scan ends, and the sweep clears any older than an hour (ADR-283), so **the old key stays for at least an hour after the new one is the first** and then may go.

That gives three deploys: add the new key last, make it first, drop the old one.

## Staging first, then production

Do it in `staging` with its own ring, look at the result for a day, then repeat in `production` (the rings differ, LAUNCH.md C row 12).

### 1. Make the new entry and the two rings

On a trusted machine, in a private directory (a memory file system such as `/dev/shm` on Linux), with the current scan ring from the vault:

```sh
umask 077
mkdir -p /dev/shm/rs-scan-rotate-<ticket> && cd /dev/shm/rs-scan-rotate-<ticket>
read -rsp 'current scan ring (from the vault): ' RING; echo
printf '%s\n' "$RING" | rsctl keys rotate --stdin --output ring-new-first.txt
unset RING
rsctl keys ids --stdin < ring-new-first.txt
```

`ring-new-first.txt` is `newid:key,oldid:key` (the final state). Make the first deploy's ring by swapping the two entries so the old key is still first:

```sh
tr ',' '\n' < ring-new-first.txt | tac | paste -sd, - > ring-new-last.txt
rsctl keys ids --stdin < ring-new-last.txt
```

With more than one old key, move only the new entry (the first of `ring-new-first.txt`) to the end; the order of the old keys is unchanged. `ids` must now print the old id first and the new id last.

### 2. Put both rings in the vault, then check them

Store `ring-new-last.txt` as the current entry for the environment and relabel the old one "previous (until <date>)". Check the ring that will be live first and the final one:

```sh
RAMPSMITH_SCAN_SECRET_KEYS="$(cat ring-new-last.txt)" RAMPSMITH_MASTER_KEYS="$(vault-read master-ring)" rsctl doctor --row 12
RAMPSMITH_SCAN_SECRET_KEYS="$(cat ring-new-first.txt)" RAMPSMITH_MASTER_KEYS="$(vault-read master-ring)" rsctl doctor --row 12
```

Expected: both `PASS`, with the scan ring's keys parsing and distinct from the master ring's.

### 3. Deploy the new key last

Railway dashboard, the environment, Project Settings > Shared Variables > `RAMPSMITH_SCAN_SECRET_KEYS`: set `ring-new-last.txt`'s contents. The edit is staged until Deploy; check that only this variable changed, then deploy. Wait until `ctl` **and** `engine` both run the new deployment and answer their health checks. `ctl` still seals with the old key; the engine can now open both.

### 4. Make the new key first

Set `ring-new-first.txt` and deploy the same way. From the moment `ctl` restarts, new scans are sealed under the new id. Engine replicas still on the previous deployment hold the new key from step 3, so none can be caught without it.

### 5. Verify

On staging with a development store whose storefront password is saved (LAUNCH.md C rows 1 and 3): start a scan from the app, and while it runs, in a break-glass session as `rampsmith_worker`:

```sql
select storefront_password_key_id, count(*) from scans
 where storefront_password_ct is not null group by 1;
```

Expect the new id, and after the scan ends no row (the copy is cleared). The scan must report the store as scanned, not blocked. Also run `packages/engine/test/storefront-password.live.test.ts` as LAUNCH.md section E describes.

### 6. Drop the old key (at least an hour later)

When the query in step 5 shows no copy under the old id (it shows none an hour after step 4, because the sweep clears copies older than an hour), and no scan started before step 4 is still running:

```sh
read -rsp 'current scan ring (from the vault): ' RING; echo
printf '%s\n' "$RING" | rsctl keys drop --stdin --id <old id> --output ring-final.txt
unset RING
```

Store it in the vault, deploy it as in step 3, and check that `ctl` and the engine become healthy. `sites.storefront_password_ct` is sealed under the **master** ring, not this one, so dropping a scan key never makes a saved password unreadable.

### 7. Record it

Ticket: environment, ids before and after, the time of each deploy, who. Delete the working directory and clear the terminal.

## If a scan ring may have leaked

A ring alone opens nothing: a sealed copy exists only on a running scan's row, for minutes. Rotate at once (steps 1 to 4, skipping the day of staging), then drop the leaked key after an hour (step 6). A leaked ring cannot read the saved passwords, which are under the master ring. Say in the postmortem whether the database was reachable while the leaked ring was live. Merchants whose store password may have been exposed should change it; Rampsmith reads the new value at their next save.

## Rollback

- **A deploy never became healthy:** Railway kept the old deployment; discard the change.
- **After step 4 scans start without the password:** put `ring-new-last.txt` back (vault) and deploy. `ctl` seals under the old key again and the engine still opens both. Find why the engine lacked the new key (a replica that did not restart) before trying again.
- **A wrong drop in step 6:** put the previous ring back from the vault and deploy; a scan that started in between ends blocked and the next one works.

## Escalation

The founder owns the ring and the vault. If the vault's current ring is damaged, use the previous entry; if neither entry parses, generate a new ring with `rsctl keys generate` and deploy it. Nothing durable is lost: a running scan ends blocked, and the next one is sealed afresh.
