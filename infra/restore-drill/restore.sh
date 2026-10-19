#!/usr/bin/env bash
# Restores a logical backup into a fresh database (ADR-173, ADR-175). The runbook
# docs/runbooks/restore-from-logical-backup.md runs this; so does the restore drill.
#
#   restore.sh --target NAME (--file ARCHIVE.dump.age | --object KEY) --identity AGE_KEY_FILE
#              [--jobs N] [--manifest-out FILE] [--work DIR]
#
# Connection: the libpq environment (PGHOST, PGPORT, PGUSER, PGPASSWORD) of a role that can run
# `SET ROLE rampsmith_migrator` (the cluster superuser). Nothing is put on a command line. The
# target database must exist and have been prepared by infra/railway/bootstrap.sql (roles, grants,
# schema owner), because pg_dump does not dump roles; the script checks and stops when they are
# missing, and when the database already holds anything.
#
# Steps, each timed: fetch (with --object: download, size and sha256 against the metadata
# object), decrypt, list (the archive's table of contents is read and the expected objects are
# derived from it), restore (pg_restore --no-owner --role=rampsmith_migrator --exit-on-error,
# parallel), analyze. The target must be empty: the script never restores over data.
#
# Exit codes: 0 restored; 1 failed (the message says which step).
set -euo pipefail
umask 077

# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# shellcheck source=../backup/lib/common.sh
source "$RD_ROOT/../backup/lib/common.sh"
# shellcheck source=../backup/lib/s3.sh
source "$RD_ROOT/../backup/lib/s3.sh"

file=""
object=""
identity=""
target=""
jobs=4
manifest_out=""
work=""
owner_role="${RESTORE_OWNER_ROLE:-rampsmith_migrator}"

while [ "$#" -gt 0 ]; do
  case $1 in
    --file) file=$2; shift 2 ;;
    --object) object=$2; shift 2 ;;
    --identity) identity=$2; shift 2 ;;
    --target) target=$2; shift 2 ;;
    --jobs) jobs=$2; shift 2 ;;
    --manifest-out) manifest_out=$2; shift 2 ;;
    --work) work=$2; shift 2 ;;
    *) rd_die "unknown argument: $1" ;;
  esac
done

[ -n "$target" ] || rd_die "--target is required"
[[ $target =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]] || rd_die "--target must be a plain database name"
[ -n "$identity" ] && [ -f "$identity" ] || rd_die "--identity must be the age private key file"
if [ -n "$file" ] && [ -n "$object" ]; then rd_die "use --file or --object, not both"; fi
if [ -z "$file" ] && [ -z "$object" ]; then rd_die "one of --file or --object is required"; fi
[[ $jobs =~ ^[1-9][0-9]?$ ]] || rd_die "--jobs must be a number from 1 to 99"

own_work=0
if [ -z "$work" ]; then
  work=$(mktemp -d)
  own_work=1
fi
mkdir -p "$work"
finish() {
  rd_timings_report >&2
  if [ "$own_work" -eq 1 ]; then rm -rf "$work"; else rm -f "$work/restore.dump"; fi
}
trap finish EXIT

psql_admin() { "$PGBIN/psql" -X -q -At -v ON_ERROR_STOP=1 "$@"; }

# --- the target ---------------------------------------------------------------------------------------
check_target() {
  local role missing=""
  for role in rampsmith_app rampsmith_worker "$owner_role"; do
    if [ "$(psql_admin -d postgres -c "select count(*) from pg_roles where rolname = '${role}'")" != "1" ]; then
      missing="${missing} ${role}"
    fi
  done
  if [ -n "$missing" ]; then
    rd_die "the server lacks the role(s)${missing}: run infra/railway/bootstrap.sql first (pg_dump does not dump roles)"
  fi
  local tables
  tables=$(psql_admin -d "$target" -c "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','p','v','m','S')") ||
    rd_die "cannot connect to database ${target}"
  if [ "$tables" != "0" ]; then
    rd_die "database ${target} already holds ${tables} objects in schema public; restore into an empty database"
  fi
}

# --- fetch ----------------------------------------------------------------------------------------------
fetch() {
  local meta_key meta_sha meta_size actual_sha actual_size
  if [ -n "$object" ]; then
    [[ $object =~ \.dump\.age$ ]] || rd_die "--object must be a key ending in .dump.age"
    s3_init
    meta_key="${object%.dump.age}.meta.json"
    s3_get "$meta_key" "$work/meta.json" ||
      rd_die "no metadata object ${meta_key}: the upload never finished, pick another backup"
    s3_get "$object" "$work/archive.age" || rd_die "could not download ${object}"
    file="$work/archive.age"
    meta_sha=$(grep -o '"sha256": *"[0-9a-f]*"' "$work/meta.json" | grep -o '[0-9a-f]\{64\}' || true)
    meta_size=$(grep -o '"size_bytes": *[0-9]*' "$work/meta.json" | grep -o '[0-9]*$' || true)
    [ -n "$meta_sha" ] && [ -n "$meta_size" ] || rd_die "metadata ${meta_key} is unreadable"
    actual_sha=$(sha256sum "$file" | cut -d' ' -f1)
    actual_size=$(wc -c <"$file" | tr -d ' ')
    if [ "$actual_size" != "$meta_size" ]; then
      rd_die "archive size ${actual_size} differs from the ${meta_size} recorded at backup time"
    fi
    if [ "$actual_sha" != "$meta_sha" ]; then
      rd_die "archive sha256 differs from the one recorded at backup time: the object was altered or corrupted"
    fi
    rd_log "fetched ${object}: ${actual_size} bytes, sha256 matches the metadata"
  else
    [ -f "$file" ] || rd_die "no such file: ${file}"
    if [ -f "${file%.dump.age}.meta.json" ]; then
      cp "${file%.dump.age}.meta.json" "$work/meta.json"
      meta_sha=$(grep -o '"sha256": *"[0-9a-f]*"' "$work/meta.json" | grep -o '[0-9a-f]\{64\}' || true)
      actual_sha=$(sha256sum "$file" | cut -d' ' -f1)
      [ "$actual_sha" = "$meta_sha" ] || rd_die "archive sha256 differs from the one in ${file%.dump.age}.meta.json"
    fi
  fi
}

# --- decrypt --------------------------------------------------------------------------------------------
decrypt() {
  "$AGE" -d -i "$identity" -o "$work/restore.dump" "$file" 2>"$work/age.err" ||
    rd_die "age could not decrypt the archive (wrong key, or the file is damaged): $(tr '\n' ' ' <"$work/age.err" | head -c 300)"
  [ -s "$work/restore.dump" ] || rd_die "decryption produced an empty file"
}

# --- list and derive ----------------------------------------------------------------------------------------
list_archive() {
  "$PGBIN/pg_restore" --list "$work/restore.dump" >"$work/toc.txt" 2>"$work/toc.err" ||
    rd_die "pg_restore cannot read the archive: $(tr '\n' ' ' <"$work/toc.err" | head -c 300)"
  grep -Eq '^[0-9]+; [0-9]+ [0-9]+ TABLE DATA public _sqlx_migrations ' "$work/toc.txt" ||
    rd_die "the archive does not hold public._sqlx_migrations"
  if [ -n "$manifest_out" ]; then
    derive_manifest "$work/toc.txt" >"$manifest_out"
    rd_log "derived $(wc -l <"$manifest_out" | tr -d ' ') expectations from the archive's table of contents"
  fi
}

# derive_manifest TOC: the keys a restored database must hold, taken from the archive alone and
# valued `-` (verify.sh --partial reads that as "must exist"). The schema version is exact, from
# the backup's metadata object when there is one.
derive_manifest() {
  # Two passes over the listing: partitions (TABLE ATTACH) are not tables of their own in the
  # manifest, so the first pass collects them.
  awk '
    # Lines read "N; catalog object TYPE schema name... owner".
    function body(l) { sub(/^[0-9]+; [0-9]+ [0-9]+ /, "", l); return l }
    FNR == NR {
      if ($0 ~ /^[0-9]+; [0-9]+ [0-9]+ TABLE ATTACH public /) { split(body($0), a, " "); attached[a[4]] = 1 }
      next
    }
    /^[0-9]+; [0-9]+ [0-9]+ / {
      line = body($0)
      split(line, f, " ")
      if (line ~ /^TABLE public /)         { if (!(f[3] in attached)) print "table\tpublic." f[3] "\trows\t-"; next }
      if (line ~ /^POLICY public /)        { print "object\tpolicy\tpublic." f[3] "." f[4] "\t-"; next }
      if (line ~ /^CONSTRAINT public /)    { print "object\tconstraint\tpublic." f[3] "." f[4] "\t-"; next }
      if (line ~ /^FK CONSTRAINT public /) { print "object\tconstraint\tpublic." f[4] "." f[5] "\t-"; next }
      if (line ~ /^INDEX public /)         { print "object\tindex\tpublic." f[3] "\t-"; next }
      if (line ~ /^TRIGGER public /)       { print "object\ttrigger\tpublic." f[3] "." f[4] "\t-"; next }
    }' "$1" "$1" | LC_ALL=C sort -u
  if [ -s "$work/meta.json" ]; then
    local version
    version=$(grep -o '"schema_version": *"[0-9a-z]*"' "$work/meta.json" | grep -o '"[0-9a-z]*"$' | tr -d '"' || true)
    if [ -n "$version" ]; then
      printf 'meta\tschema_version\t%s\n' "$version"
    fi
  fi
}

# --- restore ----------------------------------------------------------------------------------------------------
restore() {
  "$PGBIN/pg_restore" --dbname "$target" --no-owner --role "$owner_role" --exit-on-error \
    --jobs "$jobs" "$work/restore.dump" 2>"$work/restore.err" ||
    rd_die "pg_restore failed: $(tr '\n' ' ' <"$work/restore.err" | head -c 600)"
  if [ -s "$work/restore.err" ]; then
    rd_log "pg_restore messages: $(tr '\n' ' ' <"$work/restore.err" | head -c 300)"
  fi
}

analyze() {
  psql_admin -d "$target" -c "analyze"
}

rd_stage fetch fetch
rd_stage decrypt decrypt
rd_stage list list_archive
rd_stage target check_target
rd_stage restore restore
rd_stage analyze analyze
rd_log "restored into database ${target}"
