#!/usr/bin/env bash
# Verifies a restored database against a manifest (ADR-175).
#
#   PGHOST=... PGPORT=... PGUSER=rampsmith_migrator PGDATABASE=... \
#     verify.sh --expected manifest.tsv [--partial] [--out DIR] [--min-tenants N] \
#                [--expect-schema-version V] [--app-user rampsmith_api]
#
# Checks, each printing PASS or FAIL lines, and exits 1 when anything failed:
#   1. the manifest taken now equals the expected one: tables, row counts, content checksums,
#      owners, row-level security flags, privileges, policies, constraints, indexes, triggers,
#      functions, partitions, roles and the migration version (--partial: only the keys the
#      expected manifest lists, which is what a manifest derived from the archive can offer);
#   2. row-level security still isolates tenants through the application login: for every tenant,
#      every tenant table shows the tenant's own rows and none of any other tenant's;
#   3. an application session without a tenant is refused, and one cannot write another
#      tenant's row;
#   4. optionally the migration version equals the repository's newest migration.
#
# The queries run as the schema owner, never as a superuser: a restored database is not yet trusted,
# and its functions, policies and triggers must not run with superuser power (ADR-257).
# VERIFY_ALLOW_SUPERUSER=1 overrides the refusal (the drill's fault injection does not need it).
# Passwords come from PGPASSWORD (the owner) and VERIFY_APP_PASSWORD (the application login);
# neither is printed.
set -euo pipefail

# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

expected=""
partial=0
out=""
min_tenants=0
expect_schema=""
app_user="rampsmith_api"

while [ "$#" -gt 0 ]; do
  case $1 in
    --expected) expected=$2; shift 2 ;;
    --partial) partial=1; shift ;;
    --out) out=$2; shift 2 ;;
    --min-tenants) min_tenants=$2; shift 2 ;;
    --expect-schema-version) expect_schema=$2; shift 2 ;;
    --app-user) app_user=$2; shift 2 ;;
    *) rd_die "unknown argument: $1" ;;
  esac
done
[ -n "$expected" ] && [ -f "$expected" ] || rd_die "--expected needs a manifest file"
[ -n "${PGDATABASE:-}" ] || rd_die "PGDATABASE is not set"
if [ "${VERIFY_ALLOW_SUPERUSER:-0}" != "1" ] && rd_current_role_is_superuser "$PGDATABASE"; then
  rd_die "connected as a superuser: verify as rampsmith_migrator, which owns the schema and needs no more (ADR-257)"
fi
[ -n "$out" ] || out=$(mktemp -d)
mkdir -p "$out"

failed=0
checks=0
pass() { checks=$((checks + 1)); printf 'PASS\t%s\n' "$*"; }
fail() { checks=$((checks + 1)); failed=$((failed + 1)); printf 'FAIL\t%s\n' "$*"; }

owner_psql() { "$PGBIN/psql" -X -q -v ON_ERROR_STOP=1 "$@"; }
app_psql() {
  PGUSER=$app_user PGPASSWORD="${VERIFY_APP_PASSWORD:-}" "$PGBIN/psql" -X -q -v ON_ERROR_STOP=1 "$@"
}

# --- 1. the manifest ------------------------------------------------------------------
if ! owner_psql -At -F $'\t' -f "$RD_ROOT/sql/manifest.sql" 2>"$out/manifest.err" |
  LC_ALL=C sort >"$out/actual.manifest"; then
  fail "manifest	could not be taken from the restored database: $(head -c 300 "$out/manifest.err")"
fi
if [ ! -s "$out/actual.manifest" ]; then
  fail "manifest	the restored database produced an empty manifest: $(head -c 300 "$out/manifest.err")"
fi

compare=$(awk -F'\t' -v partial="$partial" '
  function keyof(line,   k) { k = line; sub(/\t[^\t]*$/, "", k); return k }
  FNR == NR { if ($1 == "info") next; want[keyof($0)] = $NF; next }
  { if ($1 == "info") next; have[keyof($0)] = $NF }
  END {
    for (k in want) {
      checks++
      if (!(k in have)) { printf "FAIL\tmissing\t%s\n", k; bad++ }
      else if (want[k] != "-" && want[k] != have[k]) {
        printf "FAIL\tchanged\t%s\texpected=%s\tactual=%s\n", k, want[k], have[k]; bad++
      }
    }
    if (!partial) for (k in have) if (!(k in want)) {
      checks++; printf "FAIL\tunexpected\t%s\n", k; bad++
    }
    printf "SUMMARY\t%d\t%d\n", checks, bad
  }' "$expected" "$out/actual.manifest")
compared=$(printf '%s\n' "$compare" | awk -F'\t' '$1 == "SUMMARY" { print $2 }')
differences=$(printf '%s\n' "$compare" | awk -F'\t' '$1 == "SUMMARY" { print $3 }')
printf '%s\n' "$compare" | awk -F'\t' '$1 == "FAIL"'
if [ "${differences:-1}" = "0" ]; then
  if [ "$partial" -eq 1 ]; then
    pass "manifest	all ${compared} entries derived from the archive exist in the restored database"
  else
    pass "manifest	${compared} entries match the manifest written at dump time"
  fi
else
  failed=$((failed + differences))
  checks=$((checks + differences))
fi

# --- migration version ------------------------------------------------------------------
if [ -n "$expect_schema" ]; then
  actual_schema=$(awk -F'\t' '$1 == "meta" && $2 == "schema_version" { print $3 }' "$out/actual.manifest")
  if [ "$actual_schema" = "$expect_schema" ]; then
    pass "schema-version	${actual_schema} is the repository's newest migration"
  else
    fail "schema-version	restored ${actual_schema:-none}, repository ${expect_schema}"
  fi
fi

# --- 2. isolation through the application login -----------------------------------------------
tenants=$(owner_psql -At -c "select id from public.tenants order by id" 2>/dev/null || true)
tenant_count=$(printf '%s\n' "$tenants" | grep -c . || true)
if [ "$tenant_count" -lt "$min_tenants" ]; then
  fail "rls	the restored database holds ${tenant_count} tenants, the drill needs ${min_tenants} to prove isolation"
fi
# Tables the application login holds no SELECT on (migration 20261109000010).
APP_UNREADABLE_TABLES="public.shop_contacts"
foreign_seen=0
rls_lines=0
for tenant in $tenants; do
  owner_psql -At -F $'\t' -v tenant="$tenant" -f "$RD_ROOT/sql/rls-count.sql" \
    >"$out/rls-owner-$tenant.tsv" 2>"$out/rls-owner.err" ||
    fail "rls	owner view for tenant ${tenant} failed: $(head -c 300 "$out/rls-owner.err")"
  app_psql -At -F $'\t' -v tenant="$tenant" -f "$RD_ROOT/sql/rls-count.sql" \
    >"$out/rls-app-$tenant.tsv" 2>"$out/rls-app.err" ||
    fail "rls	application login ${app_user} could not read for tenant ${tenant}: $(head -c 300 "$out/rls-app.err")"
  while IFS=$'\t' read -r _ table own other; do
    rls_lines=$((rls_lines + 1))
    app_row=$(awk -F'\t' -v t="$table" '$2 == t { print $3 "\t" $4 }' "$out/rls-app-$tenant.tsv")
    app_own=${app_row%%$'\t'*}
    app_other=${app_row#*$'\t'}
    if [ -z "$app_row" ]; then
      fail "rls	${table}: the application login saw nothing for tenant ${tenant}"
    elif [ "$app_own" = "denied" ]; then
      # Only the tables the application login is meant not to read; anywhere else a lost grant
      # would hide a table from this check. The owner's count above stands for the rows.
      case " ${APP_UNREADABLE_TABLES} " in
        *" ${table} "*) ;;
        *) fail "rls	${table}: the application login cannot read it, and it is not on the list of tables it may not" ;;
      esac
    elif [ "$app_own" != "$own" ]; then
      fail "rls	${table}: tenant ${tenant} owns ${own} rows but the application login sees ${app_own}"
    elif [ "$app_other" != "0" ]; then
      fail "rls	${table}: the application login scoped to tenant ${tenant} sees ${app_other} rows of other tenants"
    elif [ "$other" != "0" ]; then
      foreign_seen=$((foreign_seen + 1))
    fi
  done <"$out/rls-owner-$tenant.tsv"
done
if [ "$rls_lines" -gt 0 ]; then
  pass "rls	${rls_lines} table views across ${tenant_count} tenants isolate through ${app_user}; ${foreign_seen} had other tenants' rows to hide"
fi
if [ "$min_tenants" -gt 1 ] && [ "$foreign_seen" -eq 0 ]; then
  fail "rls	no table held another tenant's rows, so isolation was not exercised"
fi

# A session without a tenant must be refused, not served everything.
if app_psql -At -c "select count(*) from public.sites" >/dev/null 2>"$out/notenant.err"; then
  fail "rls	${app_user} read public.sites without a tenant"
else
  pass "rls	${app_user} without a tenant is refused"
fi

# One tenant cannot write another's row.
first=$(printf '%s\n' "$tenants" | sed -n '1p')
second=$(printf '%s\n' "$tenants" | sed -n '2p')
if [ -n "$first" ] && [ -n "$second" ]; then
  if app_psql -At -v ON_ERROR_STOP=1 -c "
      begin;
      select set_config('app.tenant_id', '${first}', true);
      insert into public.sites (id, tenant_id, platform, base_url)
      values ('00000000-0000-4000-8000-0000000000ff', '${second}', 'generic', 'https://x.example');
      rollback;" >/dev/null 2>"$out/crosswrite.err"; then
    fail "rls	${app_user} scoped to ${first} wrote a row for ${second}"
  elif grep -q 'row-level security' "$out/crosswrite.err"; then
    pass "rls	a cross-tenant write is rejected by row-level security"
  else
    fail "rls	a cross-tenant write failed for another reason: $(head -c 300 "$out/crosswrite.err")"
  fi
fi

printf 'verify\t%s checks, %s failed\n' "$checks" "$failed"
[ "$failed" -eq 0 ]
