#!/usr/bin/env bash
# Lists the backups of one environment in the R2 backups bucket, newest first (ADR-176). The
# restore runbook uses it to pick the object to restore; it reads the bucket and nothing else.
#
#   R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_BUCKET_BACKUPS=... \
#     list-backups.sh --environment production [--kind daily|monthly]
#
# One line per archive, tab separated: kind, object key, status. The status is `complete` when the
# metadata object next to the archive exists (it is written last, so an archive without it is an
# unfinished upload that restore.sh refuses) and `incomplete` otherwise. Choose the newest complete
# one unless the incident says to go further back.
#
# Exit codes: 0 listed (possibly nothing); 1 failed or a required variable is missing.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../backup/lib/common.sh
source "$DIR/../backup/lib/common.sh"
# shellcheck source=../backup/lib/s3.sh
source "$DIR/../backup/lib/s3.sh"

environment=""
kind=all
while [ "$#" -gt 0 ]; do
  case $1 in
    --environment) environment=${2:-}; shift 2 ;;
    --kind) kind=${2:-}; shift 2 ;;
    *) bk_die "unknown argument: $1" ;;
  esac
done
bk_valid_environment "$environment" || bk_die "--environment must be an environment name such as production"
case $kind in
  all | daily | monthly) ;;
  *) bk_die "--kind must be daily, monthly or omitted" ;;
esac

missing=$(bk_missing_r2 | tr '\n' ' ')
if [ -n "$missing" ]; then
  bk_die "needs ${missing}(LAUNCH.md section C row 6): the R2 token scoped to the backups bucket"
fi
s3_init

found=0
for each in daily monthly; do
  if [ "$kind" != all ] && [ "$kind" != "$each" ]; then continue; fi
  keys=$(s3_list "${environment}/${each}/") || bk_die "could not list ${environment}/${each}/"
  lines=$(printf '%s\n' "$keys" | awk -v kind="$each" '
    /\.meta\.json$/ { sub(/\.meta\.json$/, ""); meta[$0] = 1; next }
    /\.dump\.age$/  { sub(/\.dump\.age$/, ""); archive[$0] = 1 }
    END {
      for (base in archive) {
        printf "%s\t%s.dump.age\t%s\n", kind, base, (base in meta ? "complete" : "incomplete")
      }
    }' | LC_ALL=C sort -t "$(printf '\t')" -k2,2r)
  if [ -n "$lines" ]; then
    printf '%s\n' "$lines"
    found=1
  fi
done
if [ "$found" -eq 0 ]; then
  bk_log "no backups under ${environment}/ in the bucket"
fi
