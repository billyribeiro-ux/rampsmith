#!/usr/bin/env bash
# The live restore drill (ADR-175): restores the newest real backup of an environment from the
# R2 backups bucket into a throwaway PostgreSQL 18 and verifies it.
#
#   RD_IMAGE=... RD_TOOLS=... live.sh [--environment staging] [--scratch DIR] [--max-age-hours 48]
#
# Needs LAUNCH.md section C row 6 (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
# R2_BUCKET_BACKUPS), a backup that the nightly job wrote (it needs row 8, the Railway project), and
# BACKUP_DRILL_AGE_KEY: the private half of the staging drill key. The production key is never
# here: staging backups are encrypted to a recipient the drill holds, production backups are not.
# Without the inputs the script says so in a warning annotation naming the rows and exits 0: a
# skipped live check is announced, never passed silently, and the substitute test (the same
# restore path on the drill's own archive) runs in the same workflow.
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

missing=$(bk_missing_r2 | tr '\n' ' ')
if [ -z "${BACKUP_DRILL_AGE_KEY:-}" ]; then
  missing="${missing}BACKUP_DRILL_AGE_KEY "
fi
if [ -n "$missing" ]; then
  bk_warning "live restore drill skipped: needs ${missing}(LAUNCH.md section C rows 6 and 8); the substitute test, the same restore path on the drill's own archive, ran in this workflow"
  bk_summary "### Live restore drill: SKIPPED"
  bk_summary ""
  bk_summary "Needs ${missing}(LAUNCH.md section C rows 6 and 8). See docs/evidence/ws-8-ops.md, Section E."
  exit 0
fi

[ -n "$scratch" ] || rd_die "--scratch is required"
mkdir -p "$scratch/work" "$scratch/out"
s3_init

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
expected_sha=$(grep -o '"sha256": *"[0-9a-f]*"' "$scratch/work/backup.meta.json" | grep -o '[0-9a-f]\{64\}' || true)
actual_sha=$(sha256sum "$scratch/work/backup.dump.age" | cut -d' ' -f1)
[ -n "$expected_sha" ] && [ "$expected_sha" = "$actual_sha" ] ||
  rd_die "the downloaded archive does not match the sha256 in its metadata object"
printf '%s' "$BACKUP_DRILL_AGE_KEY" >"$scratch/work/identity.key"
chmod 600 "$scratch/work/identity.key"
fetch_ms=$(($(rd_now_ms) - fetch_started))
rd_log "fetched ${archive_key} (${age_hours} hours old) in ${fetch_ms} ms"

# --- restore and verify in the pinned image ------------------------------------------------------------------
status=0
RD_SCRATCH=$scratch "$DIR/in-container.sh" infra/restore-drill/restore-local.sh \
  --file /scratch/work/backup.dump.age --identity /scratch/work/identity.key \
  --out /scratch/out --work /scratch/work/restore --min-tenants 1 ||
  status=1
rm -f "$scratch/work/identity.key"

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
