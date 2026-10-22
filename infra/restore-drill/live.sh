#!/usr/bin/env bash
# The live restore drill (ADR-175, ADR-092): restores the newest real backup of an environment
# from the R2 backups bucket into a throwaway PostgreSQL 18 and verifies it.
#
#   RD_IMAGE=... RD_TOOLS=... live.sh [--environment staging] [--scratch DIR] [--max-age-hours 48]
#
# Needs LAUNCH.md section C row 16, set only as the secrets and variables of the GitHub
# environment `backup-drill`: R2_ACCOUNT_ID, R2_BUCKET_BACKUPS, DRILL_R2_ACCESS_KEY_ID and
# DRILL_R2_SECRET_ACCESS_KEY (an Object Read only token on the backups bucket, which cannot write
# or delete a backup), a backup that the nightly `backup` service wrote, and BACKUP_DRILL_AGE_KEY:
# the private half of the staging drill key. The production key is never here: staging backups
# are encrypted to a recipient the drill holds, production backups are not.
# Without the inputs the script says so in a warning annotation naming the row and exits 0: a
# skipped live check is announced, never passed silently, and the substitute test (the same
# restore path on the drill's own archive) runs in the same workflow.
#
# The restore runs in a container as the image's postgres user, which is not the user running
# this script, so what the container reads is world-readable (ciphertext and public metadata),
# what it writes goes to one world-writable directory, and the private key reaches it in an
# environment variable that becomes a private file inside the container (ADR-094).
set -euo pipefail
umask 077

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$DIR/lib.sh"
# shellcheck source=../backup/lib/common.sh
source "$DIR/../backup/lib/common.sh"
# shellcheck source=../backup/lib/s3.sh
source "$DIR/../backup/lib/s3.sh"

environment=staging
scratch=""
max_age_hours=48
while [ "$#" -gt 0 ]; do
  case $1 in
    --environment) environment=$2; shift 2 ;;
    --scratch) scratch=$2; shift 2 ;;
    --max-age-hours) max_age_hours=$2; shift 2 ;;
    *) rd_die "unknown argument: $1" ;;
  esac
done
bk_valid_environment "$environment" || rd_die "invalid --environment"
[[ $max_age_hours =~ ^[1-9][0-9]*$ ]] || rd_die "--max-age-hours must be a positive integer"

missing=$(bk_missing_r2 DRILL_R2 | tr '\n' ' ')
if bk_is_unset BACKUP_DRILL_AGE_KEY; then
  missing="${missing}BACKUP_DRILL_AGE_KEY "
fi
if [ -n "$missing" ]; then
  bk_warning "live restore drill skipped: needs ${missing}(${BK_LAUNCH_ROW}); the substitute test, the same restore path on the drill's own archive, ran in this workflow"
  bk_summary "### Live restore drill: SKIPPED"
  bk_summary ""
  bk_summary "Needs ${missing}(${BK_LAUNCH_ROW}). See docs/LAUNCH.md section E, 'Live restore drill'."
  exit 0
fi
# The drill's token reads the backups; the backup service's token writes and deletes them. Both in
# one environment would defeat the split (ADR-091), so refuse before touching the bucket.
for name in BACKUP_R2_ACCESS_KEY_ID BACKUP_R2_SECRET_ACCESS_KEY; do
  if [ -n "${!name:-}" ]; then
    rd_die "${name} is set: the backup service's write token must not exist in the drill's environment (ADR-091)"
  fi
done

[ -n "$scratch" ] || rd_die "--scratch is required"
in_container=${RD_IN_CONTAINER:-$DIR/in-container.sh}
# umask 077 would make these 0700 and their files 0600, which the container's user (uid 999 in the
# postgres image, not the runner's) can neither enter nor read: the live drill could never restore
# (finding M3). The restore reads ciphertext and public metadata from `work`, and writes
# everything it produces under `out`, so `work` is readable by all and `out` writable by all.
mkdir -p "$scratch/work" "$scratch/out"
chmod 755 "$scratch" "$scratch/work"
chmod 777 "$scratch/out"
s3_init DRILL_R2

# --- the newest backup -----------------------------------------------------------------------------------
fetch_started=$(rd_now_ms)
keys=$(s3_list "${environment}/daily/") || rd_die "could not list ${environment}/daily/"
newest_meta=$(printf '%s\n' "$keys" | grep -E '\.meta\.json$' | LC_ALL=C sort | tail -n 1 || true)
[ -n "$newest_meta" ] || rd_die "no completed backup under ${environment}/daily/: run the backup workflow first"
archive_key="${newest_meta%.meta.json}.dump.age"
stamp=${newest_meta##*-}
stamp=${stamp%.meta.json}
bk_valid_stamp "$stamp" || rd_die "unexpected key name: ${newest_meta}"
taken=$(date -u -d "${stamp:0:4}-${stamp:4:2}-${stamp:6:2} ${stamp:9:2}:${stamp:11:2}:${stamp:13:2} UTC" +%s)
age_hours=$((($(date -u +%s) - taken) / 3600))
if [ "$age_hours" -gt "$max_age_hours" ]; then
  rd_die "the newest backup is ${age_hours} hours old (limit ${max_age_hours}): the nightly backup is not running"
fi

s3_get "$newest_meta" "$scratch/work/backup.meta.json"
s3_get "$archive_key" "$scratch/work/backup.dump.age"
chmod 644 "$scratch/work/backup.meta.json" "$scratch/work/backup.dump.age"
expected_sha=$(grep -o '"sha256": *"[0-9a-f]*"' "$scratch/work/backup.meta.json" | grep -o '[0-9a-f]\{64\}' || true)
actual_sha=$(sha256sum "$scratch/work/backup.dump.age" | cut -d' ' -f1)
[ -n "$expected_sha" ] && [ "$expected_sha" = "$actual_sha" ] ||
  rd_die "the downloaded archive does not match the sha256 in its metadata object"
fetch_ms=$(($(rd_now_ms) - fetch_started))
rd_log "fetched ${archive_key} (${age_hours} hours old) in ${fetch_ms} ms"

# --- restore and verify in the pinned image ------------------------------------------------------------------
# The key never touches the runner's disk: in-container.sh writes it to a file only the container
# can read (/tmp/rd-identity.key, mode 0600) and removes it when the command ends.
status=0
RD_IDENTITY=$BACKUP_DRILL_AGE_KEY RD_SCRATCH=$scratch "$in_container" infra/restore-drill/restore-local.sh \
  --file /scratch/work/backup.dump.age --identity /tmp/rd-identity.key \
  --out /scratch/out --work /scratch/out/restore --min-tenants 1 ||
  status=1

window_ms=$(cat "$scratch/out/window_ms" 2>/dev/null || echo 0)
total_ms=$((fetch_ms + window_ms))
printf 'live\tfetch %s ms, restore and verification %s ms, total %s ms, target %s ms\n' \
  "$fetch_ms" "$window_ms" "$total_ms" "$((RTO_TARGET_SECONDS * 1000))"
if [ "$total_ms" -gt $((RTO_TARGET_SECONDS * 1000)) ]; then
  printf 'FAIL\trto\tfetch and restore took %s s, the target is %s s\n' "$((total_ms / 1000))" "$RTO_TARGET_SECONDS"
  status=1
fi
bk_summary "### Live restore drill: $([ "$status" -eq 0 ] && echo PASS || echo FAIL)"
bk_summary ""
bk_summary "- backup: \`${archive_key}\`, ${age_hours} hours old"
bk_summary "- fetch ${fetch_ms} ms, restore and verification ${window_ms} ms, target ${RTO_TARGET_SECONDS} s"
exit "$status"
