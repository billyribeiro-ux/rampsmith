#!/usr/bin/env bash
# Lists the backups of one environment in that environment's R2 backups bucket, newest first
# (ADR-176, ADR-256). The restore runbook uses it to pick the object to restore; it reads the bucket
# and nothing else.
#
#   R2_ACCOUNT_ID=... R2_BUCKET_BACKUPS=rampsmith-backups-production \
#     DRILL_R2_ACCESS_KEY_ID=... DRILL_R2_SECRET_ACCESS_KEY=... \
#     list-backups.sh --environment production [--kind daily|monthly] [--verify-key PUBKEY.pem]
#
# The credentials are the read-only token on that environment's backups bucket (LAUNCH.md section C
# row 16): it lists and reads the backups and cannot write or delete one.
#
# One line per archive, tab separated: kind, object key, status. Ordered by the timestamp in the file
# name, newest first (never by the key's text). Choose the newest `complete` one unless the incident
# says to go further back. The status is:
#   complete    archive, metadata object and signature exist, the signature verifies against the
#               committed public key (infra/backup/signing/<environment>.pub.pem), the signed time is
#               the time in the key and is not in the future
#   incomplete  no metadata object or no signature: an unfinished upload, or not made by the backup
#               service; restore.sh refuses it
#   future      dated after now (plus ten minutes of clock skew): not believed, restore.sh refuses it
#   misfiled    the directory does not agree with the time in the file name: not believed
#   invalid     the signature or the signed metadata does not verify: somebody else wrote this object
#
# Exit codes: 0 listed (possibly nothing); 1 failed or a required variable is missing.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../backup/lib/common.sh
source "$DIR/../backup/lib/common.sh"
# shellcheck source=../backup/lib/s3.sh
source "$DIR/../backup/lib/s3.sh"
# shellcheck source=../backup/lib/sign.sh
source "$DIR/../backup/lib/sign.sh"

environment=""
kind=all
verify_key=""
while [ "$#" -gt 0 ]; do
  case $1 in
    --environment) environment=${2:-}; shift 2 ;;
    --kind) kind=${2:-}; shift 2 ;;
    --verify-key) verify_key=${2:-}; shift 2 ;;
    *) bk_die "unknown argument: $1" ;;
  esac
done
bk_valid_environment "$environment" || bk_die "--environment must be an environment name such as production"
case $kind in
  all | daily | monthly) ;;
  *) bk_die "--kind must be daily, monthly or omitted" ;;
esac
[ -n "$verify_key" ] || verify_key="$DIR/../backup/signing/${environment}.pub.pem"
[ -f "$verify_key" ] || bk_die "no public key at ${verify_key}: backups are only listed as complete when their signature verifies (ADR-256); the key is committed with the backup setup (LAUNCH.md section C row 16)"

missing=$(bk_missing_r2 DRILL_R2 | tr '\n' ' ')
if [ -n "$missing" ]; then
  bk_die "needs ${missing}(${BK_LAUNCH_ROW}): the read-only R2 token scoped to the ${environment} backups bucket"
fi
bk_bucket_matches_environment "$R2_BUCKET_BACKUPS" "$environment" ||
  bk_die "R2_BUCKET_BACKUPS is not the ${environment} bucket (rampsmith-backups-${environment}): each environment has its own (ADR-252)"
s3_init DRILL_R2

now=$(date -u +%s)
limit=$(bk_future_limit "$now")
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

found=0
for each in daily monthly; do
  if [ "$kind" != all ] && [ "$kind" != "$each" ]; then continue; fi
  keys=$(s3_list "${environment}/${each}/") || bk_die "could not list ${environment}/${each}/"
  while IFS=$'\t' read -r _ archive status; do
    [ -n "$archive" ] || continue
    if [ "$status" = complete ]; then
      if s3_get "${archive%.dump.age}.meta.json" "$work/meta.json" 2>/dev/null &&
        s3_get "${archive%.dump.age}.meta.json.sig" "$work/meta.sig" 2>/dev/null &&
        bk_verify_backup "$environment" "$archive" "$work/meta.json" "$work/meta.sig" "$verify_key" "$now" >/dev/null; then
        status=complete
      else
        status=invalid
      fi
    fi
    printf '%s\t%s\t%s\n' "$each" "$archive" "$status"
    found=1
  done < <(printf '%s\n' "$keys" | bk_backups "$environment" "$each" "$limit")
done
if [ "$found" -eq 0 ]; then
  bk_log "no backups under ${environment}/ in the bucket"
fi
