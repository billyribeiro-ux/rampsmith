#!/usr/bin/env bash
# Runs the SQL files the runbooks tell an operator to run (docs/runbooks/sql, ADR-178) against a
# migrated, seeded throwaway PostgreSQL 18, and checks what each one prints and changes. A runbook
# command nobody has run is a guess; this runs them on every pull request that touches them.
#
#   runbook-sql.sh [--out DIR]
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib.sh
source "$DIR/../lib.sh"
SQL="$RD_REPO/docs/runbooks/sql"

out=""
while [ "$#" -gt 0 ]; do
  case $1 in
    --out) out=$2; shift 2 ;;
    *) rd_die "unknown argument: $1" ;;
  esac
done
work=$(mktemp -d)
[ -n "$out" ] || out="$work/out"
mkdir -p "$out"
trap 'cl_stop_all; rm -rf "$work"' EXIT

[ -x "$PGBIN/postgres" ] || rd_die "no PostgreSQL programs in PGBIN=${PGBIN}"

failed=0
total=0
pass() { total=$((total + 1)); printf 'PASS\t%s\n' "$1"; }
fail() {
  total=$((total + 1)); failed=$((failed + 1))
  printf 'FAIL\t%s\t%s\n' "$1" "$2"
}

# run NAME USER FILE [PSQL ARGS...]: runs a runbook file and keeps the output in $RUN_OUT and
# the exit status in $RUN_RC. Output is unaligned and tab separated so patterns stay simple.
RUN_OUT=""
RUN_RC=0
run() {
  local name=$1 user=$2 file=$3
  shift 3
  RUN_RC=0
  RUN_OUT=$(cl_psql db rampsmith "$user" -At -F $'\t' "$@" -f "$SQL/$file" 2>&1) || RUN_RC=$?
  printf '%s\n' "$RUN_OUT" >"$out/$name.txt"
}

# expect NAME REGEX: the last run's output must contain a line matching the pattern.
expect() {
  if printf '%s\n' "$RUN_OUT" | grep -Eq -- "$2"; then pass "$1"; else fail "$1" "no line matches /$2/ (see $out)"; fi
}
refuse() {
  if printf '%s\n' "$RUN_OUT" | grep -Eq -- "$2"; then fail "$1" "unexpected /$2/"; else pass "$1"; fi
}
ok() { if [ "$RUN_RC" -eq 0 ]; then pass "$1"; else fail "$1" "exit $RUN_RC"; fi; }
bad() { if [ "$RUN_RC" -ne 0 ]; then pass "$1"; else fail "$1" "exit 0, expected a refusal"; fi; }
sql() { cl_psql db rampsmith postgres -At -F $'\t' -c "$1"; }

# --- the database ------------------------------------------------------------------------------
cl_start db "$work/db" "${RUNBOOK_SQL_PORT:-54990}"
cl_psql db postgres postgres -c "create database rampsmith"
rd_bootstrap db rampsmith
rd_migrate db rampsmith rampsmith_migrator
tenant_a=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa
tenant_b=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb
cl_psql db rampsmith rampsmith_api -v tenant="$tenant_a" -v label=alpha -v findings=40 \
  -v occurrences=10 -f "$RD_ROOT/sql/seed.sql"
cl_psql db rampsmith rampsmith_api -v tenant="$tenant_b" -v label=beta -v findings=40 \
  -v occurrences=10 -f "$RD_ROOT/sql/seed.sql"
# The second tenant's tokens are wrapped by an older key, so the key report shows two.
sql "update shopify_tokens set key_id = 'k20260101' where tenant_id = '$tenant_b'" >/dev/null

# Jobs, written as a worker does: one ready for ten minutes, two dead token refreshes (a
# permanent crypto failure and a permanent Shopify rejection), a dead webhook job, a succeeded one,
# and a dead system job that belongs to no tenant.
job_ready=11111111-1111-4111-8111-111111111111
job_crypto=22222222-2222-4222-8222-222222222222
job_rejected=33333333-3333-4333-8333-333333333333
job_webhook=44444444-4444-4444-8444-444444444444
job_done=55555555-5555-4555-8555-555555555555
job_system=66666666-6666-4666-8666-666666666666
cl_psql db rampsmith rampsmith_ctl -c "
insert into jobs (id, queue, payload_schema, payload, tenant_id, state, run_at) values
  ('$job_ready', 'shopify.token_refresh', 'shopify.token_refresh@1', '{}', '$tenant_a', 'ready', now() - interval '10 minutes');
insert into jobs (id, queue, payload_schema, payload, tenant_id, state, attempts, finished_at, last_error) values
  ('$job_crypto', 'shopify.token_refresh', 'shopify.token_refresh@1', '{\"marker\":\"payload-marker-xyz\"}', '$tenant_a', 'dead', 1, now(),
     '{\"code\":\"crypto\",\"message\":\"unknown key id\",\"retryable\":false}'),
  ('$job_rejected', 'shopify.token_refresh', 'shopify.token_refresh@1', '{}', '$tenant_b', 'dead', 1, now() - interval '1 hour',
     '{\"code\":\"shopify_rejected\",\"message\":\"the token endpoint refused\",\"retryable\":false}'),
  ('$job_webhook', 'webhook.process', 'webhook.process@1', '{}', '$tenant_b', 'dead', 8, now() - interval '2 hours',
     '{\"code\":\"payload_invalid\",\"message\":\"missing field\",\"retryable\":false}');
insert into jobs (id, queue, payload_schema, payload, tenant_id, state, attempts, finished_at) values
  ('$job_done', 'shopify.token_refresh', 'shopify.token_refresh@1', '{}', '$tenant_a', 'succeeded', 1, now());
insert into jobs (id, queue, payload_schema, payload, tenant_id, state, attempts, finished_at, last_error) values
  ('$job_system', 'retention.sweep', 'retention.sweep@1', '{}', null, 'dead', 3, now() - interval '3 hours',
     '{\"code\":\"database\",\"message\":\"connection closed\",\"retryable\":true}');"

# --- jobs-depth.sql ----------------------------------------------------------------------------
run depth postgres jobs-depth.sql
ok "jobs-depth runs as the superuser"
expect "jobs-depth counts the ready token refresh and its age" $'^shopify\\.token_refresh\tready\t1\t(5[89][0-9]|6[0-9][0-9])\\.[0-9]$'
expect "jobs-depth counts the dead token refreshes" $'^shopify\\.token_refresh\tdead\t2\t'
expect "jobs-depth counts the dead webhook job" $'^webhook\\.process\tdead\t1\t'
refuse "jobs-depth leaves finished jobs out" $'succeeded'
run depth-ctl rampsmith_ctl jobs-depth.sql
ok "jobs-depth runs as the ctl login"

# --- jobs-dead.sql -----------------------------------------------------------------------------
run dead postgres jobs-dead.sql
ok "jobs-dead runs"
expect "jobs-dead summarises crypto failures" $'^shopify\\.token_refresh\tcrypto\t1\t'
expect "jobs-dead lists the newest first" "^${job_crypto}"$'\tshopify\\.token_refresh\t'
run dead-code postgres jobs-dead.sql -v code=crypto
expect "jobs-dead filters by code: the crypto job is listed" "^${job_crypto}"
refuse "jobs-dead filters by code: the others are not" "^(${job_rejected}|${job_webhook})"
run dead-queue postgres jobs-dead.sql -v 'queue=webhook.%' -v limit=1
expect "jobs-dead filters by queue" "^${job_webhook}"
refuse "jobs-dead filters by queue: token refreshes are not listed" "^(${job_crypto}|${job_rejected})"
refuse "jobs-dead never prints a payload" 'payload-marker-xyz'

# --- jobs-retry-dead.sql -----------------------------------------------------------------------
op=(-v operator=tester -v 'reason=key restored')
run retry-missing postgres jobs-retry-dead.sql
bad "jobs-retry-dead refuses to run without a job id"
expect "jobs-retry-dead says what is missing" 'needs -v job=<uuid>'
run retry-no-operator postgres jobs-retry-dead.sql -v "job=$job_crypto"
bad "jobs-retry-dead refuses to run without an operator name"
expect "jobs-retry-dead asks for the operator" 'needs -v operator=<name>'
state=$(sql "select state from jobs where id = '$job_crypto'")
if [ "$state" = "dead" ]; then pass "a refused retry changes nothing"; else fail "a refused retry changes nothing" "state is ${state}"; fi
run retry postgres jobs-retry-dead.sql -v "job=$job_crypto" "${op[@]}"
ok "jobs-retry-dead runs on a dead job"
expect "jobs-retry-dead reports one job retried and one audit row" $'^1\t1$'
state=$(sql "select state || '/' || attempts || '/' || (finished_at is null) from jobs where id = '$job_crypto'")
if [ "$state" = "ready/0/true" ]; then pass "the dead job is ready again with a fresh budget"; else fail "the dead job is ready again with a fresh budget" "state is ${state}"; fi
audit=$(sql "select actor_kind || '/' || actor_id || '/' || action || '/' || subject_type || '/' || (subject_id = '$job_crypto') || '/' || (tenant_id = '$tenant_a') || '/' || (data ->> 'queue') || '/' || (data ->> 'reason') from audit_log where action = 'job.retried'")
if [ "$audit" = "operator/tester/job.retried/job/true/true/shopify.token_refresh/key restored" ]; then pass "the audit row names the operator, the job, the tenant and the reason"; else fail "the audit row names the operator, the job, the tenant and the reason" "row is ${audit}"; fi
run retry-again postgres jobs-retry-dead.sql -v "job=$job_crypto" "${op[@]}"
expect "a second retry changes and logs nothing" $'^0\t0$'
run retry-done postgres jobs-retry-dead.sql -v "job=$job_done" "${op[@]}"
expect "a succeeded job is not touched" $'^0\t0$'
state=$(sql "select state from jobs where id = '$job_done'")
if [ "$state" = "succeeded" ]; then pass "the succeeded job is still succeeded"; else fail "the succeeded job is still succeeded" "state is ${state}"; fi
count=$(sql "select count(*) from audit_log where action = 'job.retried'")
if [ "$count" = "1" ]; then pass "only the real retry was logged"; else fail "only the real retry was logged" "audit rows: ${count}"; fi
run retry-ctl rampsmith_ctl jobs-retry-dead.sql -v "job=$job_rejected" "${op[@]}"
ok "jobs-retry-dead runs as the ctl login"
expect "the ctl login's retry is logged too" $'^1\t1$'
run retry-system postgres jobs-retry-dead.sql -v "job=$job_system" "${op[@]}"
expect "a system job is retried but cannot be audited, and the output says so" $'^1\t0$'
others=$(sql "select count(*) from jobs where state = 'dead'")
if [ "$others" = "1" ]; then pass "only the named jobs changed (one dead job is left)"; else fail "only the named jobs changed" "dead jobs: ${others}"; fi

# --- master-key-usage.sql ----------------------------------------------------------------------
run keys postgres master-key-usage.sql
ok "master-key-usage runs as the superuser"
expect "master-key-usage counts the current key" $'^k20261019\t1$'
expect "master-key-usage counts the older key" $'^k20260101\t1$'
run keys-ctl rampsmith_ctl master-key-usage.sql
bad "master-key-usage refuses a role that row-level security applies to"
expect "master-key-usage says why" 'bypasses row-level security'
refuse "master-key-usage prints no count to a refused role" $'^k2026'
run keys-api rampsmith_api master-key-usage.sql
bad "master-key-usage refuses the api login too"

# --- jobs-token-state.sql ----------------------------------------------------------------------
shop_a=$(sql "select id from shopify_shops where tenant_id = '$tenant_a'")
shop_b=$(sql "select id from shopify_shops where tenant_id = '$tenant_b'")
job_refresh_a=77777777-7777-4777-8777-777777777777
job_refresh_b=88888888-8888-4888-8888-888888888888
cl_psql db rampsmith rampsmith_ctl -c "
insert into jobs (id, queue, payload_schema, payload, tenant_id, state, attempts, finished_at, last_error) values
  ('$job_refresh_a', 'shopify.token_refresh', 'shopify.token_refresh@1', '{\"shop_id\":\"$shop_a\"}', '$tenant_a', 'dead', 8, now(),
     '{\"code\":\"shopify_unavailable\",\"message\":\"Shopify answered 503\",\"retryable\":true}'),
  ('$job_refresh_b', 'shopify.token_refresh', 'shopify.token_refresh@1', '{\"shop_id\":\"$shop_b\"}', '$tenant_b', 'dead', 1, now(),
     '{\"code\":\"crypto\",\"message\":\"unknown key id\",\"retryable\":false}');"
run token postgres jobs-token-state.sql -v "job=$job_refresh_a"
ok "jobs-token-state runs as the superuser"
expect "jobs-token-state shows the shop, its key and the days the refresh token has left" "^${shop_a}"$'\tinstalled\tk20261019\t.*\t[0-9]+\.[0-9]\tdead\tshopify_unavailable$'
refuse "jobs-token-state names the shop by id, not by domain" 'myshopify'
sql "delete from shopify_tokens where shop_id = '$shop_b'" >/dev/null
run token-gone postgres jobs-token-state.sql -v "job=$job_refresh_b"
expect "jobs-token-state shows a shop whose tokens are gone with empty token columns" "^${shop_b}"$'\tinstalled\t\t\t\t\tdead\tcrypto$'
run token-ctl rampsmith_ctl jobs-token-state.sql -v "job=$job_refresh_a"
bad "jobs-token-state refuses a role that row-level security applies to"
expect "jobs-token-state says why" 'bypasses row-level security'
run token-missing postgres jobs-token-state.sql
bad "jobs-token-state refuses to run without a job id"

printf 'runbook-sql\t%s checks, %s failed\n' "$total" "$failed"
[ "$failed" -eq 0 ]
