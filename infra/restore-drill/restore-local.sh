#!/usr/bin/env bash
# Restores one backup archive into a fresh PostgreSQL 18 cluster and verifies it (ADR-175).
# This is the second half of the live restore drill (live.sh fetches the newest real backup
# from the bucket, this restores it), and the restore drill runs it on its own archive too, so
# the code path that handles a real backup is exercised on every pull request.
#
#   restore-local.sh (--file ARCHIVE.dump.age | --object KEY --verify-key PUBKEY.pem)
#                    --identity AGE_KEY_FILE --out DIR [--work DIR [--discard-work]] [--min-tenants N]
#
# With --object the archive is fetched from the environment's R2 bucket by restore.sh, which verifies
# the signature first (the runbook's rehearsal uses this, with the DRILL_R2_* variables); with --file
# the caller has done that already (live.sh does it on the runner).
#
# --out receives reports only (timings, verification output) and may be collected or uploaded by the
# caller. --work holds the restored cluster, the decrypted archive and its table of contents, which
# are the production data: it must not be inside --out (the script refuses), and --discard-work
# deletes it when the script ends, with the permissions of the user that made it. Without --work a
# private temporary directory is used and always deleted (ADR-255).
#
# The restore and the verification run as rampsmith_migrator, not as the superuser (ADR-257); the
# superuser only provisions the throwaway server.
#
# What a real backup can be checked against is what the archive itself says: the tables,
# policies, constraints, indexes and triggers in its table of contents, and the migration version
# in its metadata object (the .meta.json next to the archive). verify.sh --partial reads those
# expectations; the isolation check then runs through the application login as in the drill.
# Writes DIR/window_ms (the time from provisioning the server to the end of verification).

# The stage functions below are called through rd_stage and the trap, which ShellCheck cannot see.
# shellcheck disable=SC2329
set -euo pipefail
umask 077

# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

file=""
object=""
verify_key=""
identity=""
out=""
work=""
discard=0
min_tenants=1
while [ "$#" -gt 0 ]; do
  case $1 in
    --file) file=$2; shift 2 ;;
    --object) object=$2; shift 2 ;;
    --verify-key) verify_key=$2; shift 2 ;;
    --identity) identity=$2; shift 2 ;;
    --out) out=$2; shift 2 ;;
    --work) work=$2; shift 2 ;;
    --discard-work) discard=1; shift ;;
    --min-tenants) min_tenants=$2; shift 2 ;;
    *) rd_die "unknown argument: $1" ;;
  esac
done
if [ -n "$object" ]; then
  [ -z "$file" ] || rd_die "use --file or --object, not both"
  [ -f "$verify_key" ] || rd_die "--object needs --verify-key, the public key committed under infra/backup/signing/"
else
  [ -f "$file" ] || rd_die "--file must be the encrypted archive"
fi
[ -f "$identity" ] || rd_die "--identity must be the age private key file"
[ -n "$out" ] || rd_die "--out is required"
mkdir -p "$out"
own_work=0
if [ -z "$work" ]; then
  work=$(mktemp -d)
  own_work=1
else
  # The restored cluster must never sit where a report is collected or uploaded from.
  real_out=$(realpath -m "$out")
  real_work=$(realpath -m "$work")
  case "$real_work/" in
    "$real_out"/*) rd_die "--work (${work}) is inside --out (${out}): the restored data would be collected with the reports" ;;
  esac
  case "$real_out/" in
    "$real_work"/*) rd_die "--out (${out}) is inside --work (${work}): the reports would be mixed with the restored data" ;;
  esac
  [ "$real_work" != "$real_out" ] || rd_die "--work and --out are the same directory"
  if [ "$discard" -eq 1 ]; then own_work=1; fi
fi
mkdir -p "$work"

finish() {
  local rc=$?
  rd_timings_report >"$out/timings.tsv" 2>/dev/null || true
  cat "$out/timings.tsv" 2>/dev/null || true
  cl_stop_all
  if [ "$own_work" -eq 1 ]; then rm -rf "$work"; fi
  exit "$rc"
}
trap finish EXIT

db=rampsmith
if [ -n "$object" ]; then
  source_args=(--object "$object" --verify-key "$verify_key")
else
  source_args=(--file "$file")
fi
started=$(rd_now_ms)

provision() {
  cl_start dst "$work/dst" "${DRILL_PORT_BASE:-54900}"
  cl_psql dst postgres postgres -c "create database ${db}"
  rd_bootstrap dst "$db"
}

restore() {
  PGHOST="${CL_DIR[dst]}/sock" PGPORT="${CL_PORT[dst]}" PGUSER=rampsmith_migrator \
    "$RD_ROOT/restore.sh" --target "$db" "${source_args[@]}" --identity "$identity" --jobs 4 \
    --manifest-out "$out/derived.tsv" --work "$work/restore"
}

verify() {
  local status=0
  PGHOST="${CL_DIR[dst]}/sock" PGPORT="${CL_PORT[dst]}" PGUSER=rampsmith_migrator PGDATABASE="$db" \
    "$RD_ROOT/verify.sh" --partial --expected "$out/derived.tsv" --min-tenants "$min_tenants" \
    --out "$out/verify" >"$out/verify.txt" 2>&1 || status=1
  cat "$out/verify.txt"
  return "$status"
}

rd_stage provision provision
rd_stage restore restore
status=0
verify || status=1
window_ms=$(($(rd_now_ms) - started))
printf '%s\n' "$window_ms" >"$out/window_ms"
if [ "$window_ms" -gt $((RTO_TARGET_SECONDS * 1000)) ]; then
  printf 'FAIL\trto\tthe restore took %s s, the target is %s s\n' "$((window_ms / 1000))" "$RTO_TARGET_SECONDS"
  status=1
else
  printf 'PASS\trto\trestore window %s ms is inside the %s s target\n' "$window_ms" "$RTO_TARGET_SECONDS"
fi
if [ "$status" -eq 0 ]; then printf 'restore-local\tPASS\n'; else printf 'restore-local\tFAIL\n'; fi
exit "$status"
