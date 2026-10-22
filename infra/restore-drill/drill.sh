#!/usr/bin/env bash
# The scripted restore drill (ADR-175, PLAN §22).
#
#   drill.sh [--work DIR] [--out DIR] [--keep]
#
# On two fresh PostgreSQL 18 clusters it:
#   1. bootstraps the roles and applies every migration of crates/db/migrations to the first;
#   2. seeds two tenants through the application login (so row-level security applies), plus
#      identity rows and a system job, and writes a manifest of the result;
#   3. runs the real backup (infra/backup/backup.sh: pg_dump -Fc, age to a throwaway key,
#      upload to a bucket served from a directory), as the least-privilege backup role;
#   4. bootstraps the second cluster and restores the archive with infra/restore-drill/restore.sh;
#   5. verifies the restored database against the manifest, checks that row-level security still
#      isolates the two tenants through the application login, and compares the elapsed restore
#      time with the recovery target of 4 hours (RTO_TARGET_SECONDS).
# It exits 0 when everything held and 1 otherwise. DRILL_FAULT injects one failure so the tests
# can prove the drill notices it (tests/negative.sh); with no fault the run is the control.
#
# PostgreSQL 18 programs come from PGBIN, age from AGE and AGE_KEYGEN (see lib.sh).

# The stage functions below are called through rd_stage, which ShellCheck cannot see.
# shellcheck disable=SC2329
set -euo pipefail
umask 077

# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

work=""
out=""
keep=0
while [ "$#" -gt 0 ]; do
  case $1 in
    --work) work=$2; shift 2 ;;
    --out) out=$2; shift 2 ;;
    --keep) keep=1; shift ;;
    *) rd_die "unknown argument: $1" ;;
  esac
done

fault="${DRILL_FAULT:-}"
case $fault in
  '' | tamper-manifest-checksum | tamper-data | drop-policy | disable-rls | drop-table | \
    truncate-table | drop-grant | corrupt-ciphertext | wrong-key | skip-bootstrap | \
    nonempty-target | stale-backup | no-bypassrls) ;;
  *) rd_die "unknown DRILL_FAULT: ${fault}" ;;
esac

own_work=0
if [ -z "$work" ]; then
  work=$(mktemp -d)
  own_work=1
fi
mkdir -p "$work"
[ -n "$out" ] || out="$work/out"
mkdir -p "$out"

finish() {
  local rc=$?
  rd_timings_report >"$out/timings.tsv" 2>/dev/null || true
  cat "$out/timings.tsv" 2>/dev/null || true
  cl_stop_all
  if [ "$own_work" -eq 1 ] && [ "$keep" -eq 0 ]; then rm -rf "$work"; fi
  exit "$rc"
}
trap finish EXIT

# --- preconditions -------------------------------------------------------------------------------
[ -x "$PGBIN/postgres" ] || rd_die "no PostgreSQL programs in PGBIN=${PGBIN}"
pg_version=$("$PGBIN/postgres" --version)
case $pg_version in
  *"(PostgreSQL) 18."*) ;;
  *) rd_die "the drill needs PostgreSQL 18, found: ${pg_version}" ;;
esac
command -v "$AGE" >/dev/null || rd_die "age is not installed (AGE=${AGE})"
command -v "$AGE_KEYGEN" >/dev/null || rd_die "age-keygen is not installed (AGE_KEYGEN=${AGE_KEYGEN})"

port_base="${DRILL_PORT_BASE:-54700}"
db=rampsmith
tenant_a=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa
tenant_b=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb
s3_root="$work/s3"
bucket=rampsmith-backups-drill
newest_migration=$(rd_repo_newest_migration)
rd_log "drill: ${pg_version}, age $("$AGE" --version 2>&1 | head -n 1), repository migration ${newest_migration}, fault '${fault:-none}'"

# --- 1. the source database ------------------------------------------------------------------------
provision_source() {
  cl_start src "$work/src" "$port_base"
  cl_psql src postgres postgres -c "create database ${db}"
}

migrate_source() {
  rd_bootstrap src "$db"
  rd_migrate src "$db" rampsmith_migrator
}

# --- 2. seed and manifest ----------------------------------------------------------------------------
seed_source() {
  cl_psql src "$db" rampsmith_api -v tenant="$tenant_a" -v label=alpha -v findings=600 \
    -v occurrences=3000 -f "$RD_ROOT/sql/seed.sql"
  cl_psql src "$db" rampsmith_api -v tenant="$tenant_b" -v label=beta -v findings=400 \
    -v occurrences=2000 -f "$RD_ROOT/sql/seed.sql"
  cl_psql src "$db" rampsmith_api -v part=identity -f "$RD_ROOT/sql/seed-shared.sql"
  cl_psql src "$db" rampsmith_ctl -v part=system -f "$RD_ROOT/sql/seed-shared.sql"
}

write_manifest() {
  cl_psql src "$db" postgres -At -F $'\t' -f "$RD_ROOT/sql/manifest.sql" |
    LC_ALL=C sort >"$out/manifest.tsv"
  [ -s "$out/manifest.tsv" ] || rd_die "the manifest is empty"
  rd_log "manifest: $(grep -c . "$out/manifest.tsv") entries, $(grep -c $'^table\t.*\trows\t' "$out/manifest.tsv") tables"
  if [ "$fault" = "tamper-manifest-checksum" ]; then
    # A manifest that disagrees with the data, as if the dump had been taken from other rows.
    awk -F'\t' -v OFS='\t' '$1 == "table" && $2 == "public.findings" && $3 == "checksum" { $4 = "1" } { print }' \
      "$out/manifest.tsv" >"$out/manifest.tampered"
    mv "$out/manifest.tampered" "$out/manifest.tsv"
    rd_log "fault: findings checksum in the manifest replaced"
  fi
}

# --- 3. the real backup -------------------------------------------------------------------------------
BACKUP_DIR="$RD_ROOT/../backup"
backup_env() {
  # The environment backup.sh and restore.sh read; secrets here are fixtures of this run.
  export PGBIN AGE_BIN="$AGE"
  export AWS_BIN="$BACKUP_DIR/tests/fake-aws.sh" FAKE_S3_ROOT="$s3_root"
  export R2_ACCOUNT_ID=00000000000000000000000000000000 R2_ENDPOINT_URL=http://r2.invalid
  export BACKUP_R2_ACCESS_KEY_ID=drill-backup BACKUP_R2_SECRET_ACCESS_KEY=drill-backup
  export DRILL_R2_ACCESS_KEY_ID=drill-read DRILL_R2_SECRET_ACCESS_KEY=drill-read
  export R2_BUCKET_BACKUPS="$bucket"
}

backup_source() {
  backup_env
  mkdir -p "$s3_root/$bucket"
  "$AGE_KEYGEN" -o "$work/drill.key" 2>/dev/null
  "$AGE_KEYGEN" -o "$work/other.key" 2>/dev/null
  local recipient
  recipient=$("$AGE_KEYGEN" -y "$work/drill.key")
  # The least-privilege login. The fixture password is a throwaway: the cluster trusts local
  # connections, the script exercises the same \getenv path production uses.
  BACKUP_DB_PASSWORD=drill-fixture "$PGBIN/psql" -X -q -v ON_ERROR_STOP=1 \
    -h "${CL_DIR[src]}/sock" -p "${CL_PORT[src]}" -U postgres -d "$db" -f "$BACKUP_DIR/backup-role.sql"
  if [ "$fault" = "no-bypassrls" ]; then
    cl_psql src "$db" postgres -c "alter role rampsmith_backup nobypassrls"
    rd_log "fault: the backup role lost BYPASSRLS"
  fi
  BACKUP_ENVIRONMENT=drill BACKUP_DB_HOST="${CL_DIR[src]}/sock" \
    BACKUP_DB_PORT="${CL_PORT[src]}" BACKUP_DB_USER=rampsmith_backup BACKUP_DB_NAME="$db" \
    BACKUP_DB_PASSWORD=drill-fixture BACKUP_AGE_RECIPIENTS="$recipient" \
    BACKUP_NOW="${DRILL_BACKUP_NOW:-20261019T010203Z}" \
    "$BACKUP_DIR/backup.sh" 2>&1 | tee "$out/backup.log" >&2
  archive_key=$(cd "$s3_root/$bucket" && find drill/daily -name '*.dump.age' | LC_ALL=C sort | tail -n 1)
  [ -n "$archive_key" ] || rd_die "the backup stored no archive"
  archive_bytes=$(wc -c <"$s3_root/$bucket/$archive_key" | tr -d ' ')
  rd_log "backup: ${archive_key} (${archive_bytes} bytes)"
  if [ "$fault" = "corrupt-ciphertext" ]; then
    printf 'X' | dd of="$s3_root/$bucket/$archive_key" bs=1 seek=200 conv=notrunc 2>/dev/null
    rd_log "fault: one byte of the stored archive replaced"
  fi
}

# --- 4. restore into a second fresh cluster -------------------------------------------------------------
restore_window_started=0
restore_target() {
  restore_window_started=$(rd_now_ms)
  cl_start dst "$work/dst" $((port_base + 1))
  cl_psql dst postgres postgres -c "create database ${db}"
  if [ "$fault" != "skip-bootstrap" ]; then
    rd_bootstrap dst "$db"
  else
    rd_log "fault: the roles were not created on the new server"
  fi
  if [ "$fault" = "nonempty-target" ]; then
    cl_psql dst "$db" postgres -c "create table public.leftover (x int)"
    rd_log "fault: the target database already holds a table"
  fi
  local identity="$work/drill.key"
  if [ "$fault" = "wrong-key" ]; then
    identity="$work/other.key"
    rd_log "fault: restoring with a different age key"
  fi
  backup_env
  PGHOST="${CL_DIR[dst]}/sock" PGPORT="${CL_PORT[dst]}" PGUSER=postgres \
    "$RD_ROOT/restore.sh" --target "$db" --object "$archive_key" --identity "$identity" \
    --jobs 4 --manifest-out "$out/derived.tsv" --work "$work/restore" 2>&1 | tee "$out/restore.log" >&2
}

# --- 5. faults that damage the restored database, then verification ----------------------------------------
damage_target() {
  case $fault in
    tamper-data)
      cl_psql dst "$db" postgres -c "set session_replication_role = replica; update public.findings set rule_id = 'tampered' where ctid = (select ctid from public.findings limit 1)"
      ;;
    drop-policy)
      cl_psql dst "$db" postgres -c "do \$\$ declare p name; begin select polname into p from pg_policy where polrelid = 'public.findings'::regclass limit 1; execute format('drop policy %I on public.findings', p); end \$\$"
      ;;
    disable-rls)
      cl_psql dst "$db" postgres -c "alter table public.sites disable row level security"
      ;;
    drop-table)
      cl_psql dst "$db" postgres -c "drop table public.audit_log cascade"
      ;;
    truncate-table)
      # audit_log rejects TRUNCATE through a trigger; a superuser can switch triggers off.
      cl_psql dst "$db" postgres -c "set session_replication_role = replica; truncate public.audit_log cascade"
      ;;
    drop-grant)
      cl_psql dst "$db" postgres -c "revoke all on public.sites from rampsmith_app"
      ;;
    *) return 0 ;;
  esac
  rd_log "fault: ${fault} applied to the restored database"
}

verify_target() {
  local expect_version=$newest_migration
  if [ "$fault" = "stale-backup" ]; then
    expect_version=$((newest_migration + 1))
    rd_log "fault: the repository is expected to be one migration ahead of the backup"
  fi
  export PGBIN
  {
    PGHOST="${CL_DIR[dst]}/sock" PGPORT="${CL_PORT[dst]}" PGUSER=postgres PGDATABASE="$db" \
      "$RD_ROOT/verify.sh" --expected "$out/manifest.tsv" --min-tenants 2 \
      --expect-schema-version "$expect_version" --out "$out/verify-full"
  } >"$out/verify-full.txt" 2>&1 || drill_status=1
  cat "$out/verify-full.txt"
  # What a restore of a real backup can check: only the keys the archive itself lists.
  {
    PGHOST="${CL_DIR[dst]}/sock" PGPORT="${CL_PORT[dst]}" PGUSER=postgres PGDATABASE="$db" \
      "$RD_ROOT/verify.sh" --partial --expected "$out/derived.tsv" --min-tenants 2 \
      --out "$out/verify-derived"
  } >"$out/verify-derived.txt" 2>&1 || drill_status=1
  cat "$out/verify-derived.txt"
}

drill_status=0
rd_stage provision-source provision_source
rd_stage migrate-source migrate_source
rd_stage seed seed_source
rd_stage manifest write_manifest
rd_stage backup backup_source
rd_stage restore-window restore_target
rd_stage damage damage_target
rd_stage verify verify_target

restore_window_ms=$(($(rd_now_ms) - restore_window_started))
target_ms=$((RTO_TARGET_SECONDS * 1000))
printf 'rto\trestore window %s ms, target %s ms\n' "$restore_window_ms" "$target_ms" | tee -a "$out/verify-full.txt"
if [ "$restore_window_ms" -gt "$target_ms" ]; then
  printf 'FAIL\trto\tthe restore took %s s, the target is %s s\n' "$((restore_window_ms / 1000))" "$RTO_TARGET_SECONDS" | tee -a "$out/verify-full.txt"
  drill_status=1
else
  printf 'PASS\trto\trestore window %s s is inside the %s s target\n' "$((restore_window_ms / 1000))" "$RTO_TARGET_SECONDS" | tee -a "$out/verify-full.txt"
fi

if [ "$drill_status" -eq 0 ]; then
  printf 'drill\tPASS\n' | tee "$out/result.txt"
else
  printf 'drill\tFAIL\n' | tee "$out/result.txt"
fi
exit "$drill_status"
