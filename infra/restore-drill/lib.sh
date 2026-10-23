#!/usr/bin/env bash
# Shared helpers for the restore drill and the restore tool. Sourced, never executed.
# shellcheck shell=bash

# Where this file lives and the repository root (migrations are read from there).
RD_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RD_REPO="${RD_REPO:-$(cd "$RD_ROOT/../.." && pwd)}"

# PostgreSQL 18 client and server programs: the pinned image's directory in CI
# (/usr/lib/postgresql/18/bin), a locally built or unpacked PostgreSQL 18 elsewhere.
PGBIN="${PGBIN:-/usr/lib/postgresql/18/bin}"
AGE="${AGE:-age}"
AGE_KEYGEN="${AGE_KEYGEN:-age-keygen}"

# The recovery time objective of PLAN §22: 4 hours to restore.
RTO_TARGET_SECONDS="${RTO_TARGET_SECONDS:-14400}"

rd_log() { printf '%s\n' "$*" >&2; }
rd_die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

# Milliseconds since the epoch.
rd_now_ms() { date +%s%3N; }

# --- stage timing ----------------------------------------------------------------------
# rd_stage NAME COMMAND [ARGS...]: runs the command and records its duration in RD_TIMINGS.
# The command runs plainly, not inside `||` or `if`, so `set -e` still stops it at the first
# failing command; a failed stage ends the script, whose EXIT trap prints the timings so far.
declare -a RD_TIMINGS=()
rd_stage() {
  local name=$1 started finished
  shift
  rd_log "stage ${name}: start"
  started=$(rd_now_ms)
  "$@"
  finished=$(rd_now_ms)
  RD_TIMINGS+=("$name:$((finished - started))")
  rd_log "stage ${name}: $((finished - started)) ms"
}

rd_timings_report() {
  local entry
  for entry in "${RD_TIMINGS[@]}"; do
    printf 'timing\t%s\t%s ms\n' "${entry%%:*}" "${entry#*:}"
  done
}

# --- throwaway clusters -----------------------------------------------------------------
# A cluster is a name (src, dst, ...) with a directory and a port. Servers listen on a Unix
# socket only, trust local connections, and run without fsync: they are fixtures that exist
# for a few minutes, never data anyone keeps.
declare -A CL_DIR=()
declare -A CL_PORT=()

cl_start() {
  local name=$1 dir=$2 port=$3
  CL_DIR[$name]=$dir
  CL_PORT[$name]=$port
  mkdir -p "$dir/sock"
  "$PGBIN/initdb" -D "$dir/data" -U postgres --auth=trust -E UTF8 --locale=C.UTF-8 \
    >"$dir/initdb.log" 2>&1 || {
    cat "$dir/initdb.log" >&2
    rd_die "initdb failed for cluster ${name}"
  }
  "$PGBIN/pg_ctl" -D "$dir/data" -l "$dir/server.log" -w \
    -o "-c listen_addresses='' -c unix_socket_directories='$dir/sock' -c port=$port -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c max_connections=50" \
    start >/dev/null || {
    cat "$dir/server.log" >&2
    rd_die "could not start cluster ${name}"
  }
}

cl_stop() {
  local name=$1
  [ -n "${CL_DIR[$name]:-}" ] || return 0
  "$PGBIN/pg_ctl" -D "${CL_DIR[$name]}/data" -m immediate stop >/dev/null 2>&1 || true
}

# Stops every cluster started so far.
cl_stop_all() {
  local name
  for name in "${!CL_DIR[@]}"; do cl_stop "$name"; done
}

# cl_psql CLUSTER DATABASE USER [PSQL ARGS...]
cl_psql() {
  local name=$1 db=$2 user=$3
  shift 3
  "$PGBIN/psql" -X -q -v ON_ERROR_STOP=1 \
    -h "${CL_DIR[$name]}/sock" -p "${CL_PORT[$name]}" -U "$user" -d "$db" "$@"
}

# The libpq environment that points every PostgreSQL client at a cluster.
cl_env() {
  local name=$1 user=$2 db=$3
  printf 'PGHOST=%s PGPORT=%s PGUSER=%s PGDATABASE=%s' \
    "${CL_DIR[$name]}/sock" "${CL_PORT[$name]}" "$user" "$db"
}

# --- roles and migrations ---------------------------------------------------------------

# rd_bootstrap CLUSTER DATABASE: what infra/railway/bootstrap.sql does in production
# (ADR-183): the group and login roles, and the migration role owning schema public.
rd_bootstrap() {
  cl_psql "$1" "$2" postgres -f "$RD_ROOT/sql/roles.sql" >/dev/null
}

# rd_migrate CLUSTER DATABASE USER: applies crates/db/migrations the way `sqlx migrate run`
# does (ADR-175): in file order, each file and its row in _sqlx_migrations in one
# transaction, with sqlx's table definition and SHA-384 checksums.
rd_migrate() {
  local name=$1 db=$2 user=$3 file base version description checksum
  cl_psql "$name" "$db" "$user" -c "
    create table if not exists _sqlx_migrations (
      version bigint primary key,
      description text not null,
      installed_on timestamptz not null default now(),
      success boolean not null,
      checksum bytea not null,
      execution_time bigint not null
    )" >/dev/null
  for file in "$RD_REPO"/crates/db/migrations/*.sql; do
    base=$(basename "$file" .sql)
    version=${base%%_*}
    description=${base#*_}
    description=${description//_/ }
    checksum=$(sha384sum "$file" | cut -d' ' -f1)
    cl_psql "$name" "$db" "$user" --single-transaction -f "$file" -c "
      insert into _sqlx_migrations (version, description, success, checksum, execution_time)
      values (${version}, '${description}', true, decode('${checksum}', 'hex'), 1)" >/dev/null
  done
}

# The newest migration file in the repository, which a restored database must carry.
rd_repo_newest_migration() {
  local file base
  file=$(find "$RD_REPO/crates/db/migrations" -maxdepth 1 -name '*.sql' | sort | tail -n 1)
  base=$(basename "$file" .sql)
  printf '%s' "${base%%_*}"
}

# --- what an archive may contain (ADR-257) ------------------------------------------------------
# rd_toc_violations TOC: reads the output of `pg_restore --list` and prints every entry that is not
# an object of the Rampsmith application schema, one line each, nothing when the archive is clean.
# A dump is code that the restore runs: besides data it carries SQL for every object, and the
# bucket's writer is not trusted. So only the object types the migrations create are accepted, and
# only in schema public: no extension, event trigger, rule, language, cast, operator, aggregate,
# publication, subscription, foreign server, text-search object or default privilege, and nothing
# in another schema. (A schema-changing migration that adds a new kind of object must add it
# here, with a test, in the same change.)
rd_toc_violations() {
  LC_ALL=C awk '
    /^;/ || /^[[:space:]]*$/ { next }
    {
      line = $0
      if (line !~ /^[0-9]+; [0-9]+ [0-9]+ /) { print line; next }
      sub(/^[0-9]+; [0-9]+ [0-9]+ /, "", line)
      if (line ~ /^SCHEMA - public /) next
      if (line ~ /^TABLE (DATA |ATTACH )?public [A-Za-z0-9_]+ /) next
      if (line ~ /^(FK |CHECK )?CONSTRAINT public [A-Za-z0-9_]+ [A-Za-z0-9_]+ /) next
      if (line ~ /^INDEX (ATTACH )?public [A-Za-z0-9_]+ /) next
      if (line ~ /^(TRIGGER|POLICY) public [A-Za-z0-9_]+ [^ ]+ /) next
      if (line ~ /^ROW SECURITY public [A-Za-z0-9_]+ /) next
      if (line ~ /^FUNCTION public [A-Za-z0-9_]+\(/) next
      if (line ~ /^(SEQUENCE|VIEW|TYPE|DOMAIN) public [A-Za-z0-9_]+ /) next
      if (line ~ /^SEQUENCE (OWNED BY|SET) public [A-Za-z0-9_]+ /) next
      if (line ~ /^DEFAULT public [A-Za-z0-9_]+ [A-Za-z0-9_]+ /) next
      if (line ~ /^ACL - SCHEMA public /) next
      if (line ~ /^ACL public (TABLE|FUNCTION|SEQUENCE|TYPE|DOMAIN) /) next
      if (line ~ /^COMMENT public /) next
      print $0
    }' "$1"
}

# rd_current_role_is_superuser: succeeds when the libpq environment connects as a superuser.
rd_current_role_is_superuser() {
  [ "$("$PGBIN/psql" -X -q -At -d "${1:-postgres}" -c "select rolsuper from pg_roles where rolname = current_user")" = "t" ]
}

# rd_scrub: stdin to stdout with what a public log must not hold removed (ADR-255). The repository is
# public, so the job log is too, and a restore touches customer data:
#   - tenant and other identifiers in UUID form become <id>;
#   - any line that can carry a database message (pg_restore, psql, a failing row, a statement) is
#     replaced by a notice: those messages quote data;
#   - only the lines the drill itself writes are kept.
rd_scrub() {
  LC_ALL=C sed -E 's/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/<id>/g' |
    LC_ALL=C awk '
      /pg_restore|psql:|DETAIL|Failing row|CONTEXT|STATEMENT|COPY |violates|duplicate key/ {
        print "(a database message was withheld: it may quote customer data; it is on the runner only)"; next
      }
      { print substr($0, 1, 300) }'
}
