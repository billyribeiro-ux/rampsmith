#!/usr/bin/env bash
# The live restore drill (ADR-175, ADR-253): restores the newest real backup of an environment
# from that environment's R2 backups bucket into a throwaway PostgreSQL 18 and verifies it.
#
#   RD_IMAGE=... RD_TOOLS=... live.sh [--environment staging] [--scratch DIR] [--max-age-hours 48]
#
# Needs LAUNCH.md section C row 16, set only as the secrets and variables of the GitHub
# environment `backup-drill`: R2_ACCOUNT_ID, R2_BUCKET_BACKUPS (the STAGING bucket,
# rampsmith-backups-staging), DRILL_R2_ACCESS_KEY_ID and DRILL_R2_SECRET_ACCESS_KEY (an Object Read
# only token on the staging bucket alone, which cannot write or delete a backup and cannot even
# read production's), a backup that the nightly `backup` service wrote, the committed public key
# that verifies it (infra/backup/signing/staging.pub.pem, ADR-256), and BACKUP_DRILL_AGE_KEY: the
# private half of the staging drill key. The production key is never here: staging backups are
# encrypted to a recipient the drill holds, production backups are not.
# Without the inputs the script says so in a warning annotation naming the row and exits 0: a
# skipped live check is announced, never passed silently, and the substitute test (the same
# restore path on the drill's own archive) runs in the same workflow.
#
# What is trusted: not the bucket. The newest backup is chosen by the timestamp in its name, a
# backup dated in the future is ignored, and the archive is restored only when the signature on its
# metadata verifies against the committed public key and the archive is the signed size and
# SHA-256 (ADR-256). This runs on the runner, before the container sees any byte.
#
# What is published: the repository is public, so is this job's log and anything it uploads. The
# restored cluster is customer data. It is made inside the container, outside the directories the
# runner collects, and deleted there when the restore ends (ADR-255). The log shows stage timings
# and check results with tenant identifiers removed and any database message withheld, and the only
# file for upload is $scratch/report/summary.txt: fixed fields, numbers and one date.
#
# The restore runs in a container as the image's postgres user, which is not the user running this
# script, so what the container reads is world-readable (ciphertext and public metadata), what it
# writes goes to one world-writable directory, and the private key reaches it in an environment
# variable that becomes a private file inside the container (ADR-255).
set -euo pipefail
umask 077

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$DIR/lib.sh"
# shellcheck source=../backup/lib/common.sh
source "$DIR/../backup/lib/common.sh"
# shellcheck source=../backup/lib/s3.sh
source "$DIR/../backup/lib/s3.sh"
# shellcheck source=../backup/lib/sign.sh
source "$DIR/../backup/lib/sign.sh"

environment=staging
scratch=""
max_age_hours=48
verify_key=""
while [ "$#" -gt 0 ]; do
  case $1 in
    --environment) environment=$2; shift 2 ;;
    --scratch) scratch=$2; shift 2 ;;
    --max-age-hours) max_age_hours=$2; shift 2 ;;
    --verify-key) verify_key=$2; shift 2 ;;
    *) rd_die "unknown argument: $1" ;;
  esac
done
bk_valid_environment "$environment" || rd_die "invalid --environment"
[[ $max_age_hours =~ ^[1-9][0-9]*$ ]] || rd_die "--max-age-hours must be a positive integer"
verify_key_label=$verify_key
if [ -z "$verify_key" ]; then
  verify_key="$DIR/../backup/signing/${environment}.pub.pem"
  verify_key_label="infra/backup/signing/${environment}.pub.pem"
fi

missing=$(bk_missing_r2 DRILL_R2 | tr '\n' ' ')
if bk_is_unset BACKUP_DRILL_AGE_KEY; then
  missing="${missing}BACKUP_DRILL_AGE_KEY "
fi
if [ ! -f "$verify_key" ]; then
  missing="${missing}${verify_key_label} (commit the public key) "
fi
if [ -n "$missing" ]; then
  bk_warning "live restore drill skipped: needs ${missing}(${BK_LAUNCH_ROW}); the substitute test, the same restore path on the drill's own archive, ran in this workflow"
  bk_summary "### Live restore drill: SKIPPED"
  bk_summary ""
  bk_summary "Needs ${missing}(${BK_LAUNCH_ROW}). See docs/LAUNCH.md section E, 'Live restore drill'."
  exit 0
fi
# The drill's token reads the backups; the backup service's token writes and deletes them. Both in
# one environment would defeat the split (ADR-252), so refuse before touching the bucket.
for name in BACKUP_R2_ACCESS_KEY_ID BACKUP_R2_SECRET_ACCESS_KEY; do
  if [ -n "${!name:-}" ]; then
    rd_die "${name} is set: the backup service's write token must not exist in the drill's environment (ADR-252)"
  fi
done
# The drill restores staging only, from staging's own bucket: its token must not reach production's.
[ "$environment" = staging ] || rd_die "the live drill restores staging backups only (ADR-253), not ${environment}"
bk_bucket_matches_environment "$R2_BUCKET_BACKUPS" "$environment" ||
  rd_die "R2_BUCKET_BACKUPS is not the ${environment} bucket (rampsmith-backups-${environment}): the drill reads the staging bucket only (ADR-252)"

[ -n "$scratch" ] || rd_die "--scratch is required"
in_container=${RD_IN_CONTAINER:-$DIR/in-container.sh}
# umask 077 would make these 0700 and their files 0600, which the container's user (uid 999 in the
# postgres image, not the runner's) can neither enter nor read: the live drill could never restore
# (finding M3). The restore reads ciphertext and public metadata from `work`, and writes its reports
# under `out`, so `work` is readable by all and `out` writable by all. Nothing that is customer data
# is ever written to either: the restored cluster lives in the container's own /tmp (HIGH-1).
mkdir -p "$scratch/work" "$scratch/out" "$scratch/report" "$scratch/log"
chmod 755 "$scratch" "$scratch/work"
chmod 777 "$scratch/out"
container_work=/tmp/rd-restore
s3_init DRILL_R2

# --- the newest backup -----------------------------------------------------------------------------------
fetch_started=$(rd_now_ms)
now=$(date -u +%s)
keys=$(s3_list "${environment}/daily/") || rd_die "could not list ${environment}/daily/"
archive_key=$(printf '%s\n' "$keys" | bk_newest_complete "$environment" daily "$(bk_future_limit "$now")")
[ -n "$archive_key" ] || rd_die "no complete backup under ${environment}/daily/ (archive, metadata and signature, not dated in the future): run the backup service first"
meta_key="${archive_key%.dump.age}.meta.json"

s3_get "$meta_key" "$scratch/work/backup.meta.json"
s3_get "${meta_key}.sig" "$scratch/work/backup.meta.json.sig"
s3_get "$archive_key" "$scratch/work/backup.dump.age"
chmod 644 "$scratch/work/backup.meta.json" "$scratch/work/backup.meta.json.sig" "$scratch/work/backup.dump.age"
reason=$(bk_verify_backup "$environment" "$archive_key" "$scratch/work/backup.meta.json" \
  "$scratch/work/backup.meta.json.sig" "$verify_key" "$now" "$scratch/work/backup.dump.age") ||
  rd_die "${archive_key} is not trusted: ${reason}"
stamp=${reason%% *}
taken=$(bk_stamp_epoch "$stamp")
age_hours=$(((now - taken) / 3600))
if [ "$age_hours" -gt "$max_age_hours" ]; then
  rd_die "the newest backup is ${age_hours} hours old (limit ${max_age_hours}): the nightly backup is not running"
fi
fetch_ms=$(($(rd_now_ms) - fetch_started))
rd_log "fetched ${archive_key} (${age_hours} hours old, signature verified) in ${fetch_ms} ms"

# --- restore and verify in the pinned image ------------------------------------------------------------------
# The key never touches the runner's disk: container-run.sh writes it to a file only the container
# can read (/tmp/rd-identity.key, mode 0600) and removes it when the command ends. The container's
# own output goes to a file first and is shown only after rd_scrub.
status=0
RD_IDENTITY=$BACKUP_DRILL_AGE_KEY RD_SCRATCH=$scratch RD_DISCARD_DIRS=$container_work \
  "$in_container" infra/restore-drill/restore-local.sh \
  --file /scratch/work/backup.dump.age --identity /tmp/rd-identity.key \
  --out /scratch/out --work "$container_work" --discard-work --min-tenants 1 \
  >"$scratch/log/container.log" 2>&1 || status=1
rd_scrub <"$scratch/log/container.log" || true

window_ms=$(cat "$scratch/out/window_ms" 2>/dev/null || echo 0)
[[ $window_ms =~ ^[0-9]+$ ]] || window_ms=0
total_ms=$((fetch_ms + window_ms))
printf 'live\tfetch %s ms, restore and verification %s ms, total %s ms, target %s ms\n' \
  "$fetch_ms" "$window_ms" "$total_ms" "$((RTO_TARGET_SECONDS * 1000))"
if [ "$total_ms" -gt $((RTO_TARGET_SECONDS * 1000)) ]; then
  printf 'FAIL\trto\tfetch and restore took %s s, the target is %s s\n' "$((total_ms / 1000))" "$RTO_TARGET_SECONDS"
  status=1
fi
checks_passed=$(grep -c '^PASS	' "$scratch/log/container.log" || true)
checks_failed=$(grep -c '^FAIL	' "$scratch/log/container.log" || true)
result=$([ "$status" -eq 0 ] && echo PASS || echo FAIL)

# The only file meant to leave the runner (restore-drill.yml uploads this and nothing else).
{
  printf 'result: %s\n' "$result"
  printf 'environment: %s\n' "$environment"
  printf 'backup_date_utc: %s-%s-%s\n' "${stamp:0:4}" "${stamp:4:2}" "${stamp:6:2}"
  printf 'backup_age_hours: %s\n' "$age_hours"
  printf 'fetch_ms: %s\n' "$fetch_ms"
  printf 'restore_and_verification_ms: %s\n' "$window_ms"
  printf 'total_ms: %s\n' "$total_ms"
  printf 'rto_target_ms: %s\n' "$((RTO_TARGET_SECONDS * 1000))"
  printf 'checks_passed: %s\n' "$checks_passed"
  printf 'checks_failed: %s\n' "$checks_failed"
} >"$scratch/report/summary.txt"
chmod 644 "$scratch/report/summary.txt"

bk_summary "### Live restore drill: ${result}"
bk_summary ""
bk_summary "- backup: ${environment}, taken ${stamp:0:4}-${stamp:4:2}-${stamp:6:2}, ${age_hours} hours old, signature verified"
bk_summary "- fetch ${fetch_ms} ms, restore and verification ${window_ms} ms, target ${RTO_TARGET_SECONDS} s; ${checks_passed} checks passed, ${checks_failed} failed"
exit "$status"
