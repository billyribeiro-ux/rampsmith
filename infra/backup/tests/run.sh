#!/usr/bin/env bash
# Tests for the logical backup scripts (ADR-171 to ADR-174, ADR-090, ADR-091, ADR-094).
#
#   PGBIN=/usr/lib/postgresql/18/bin AGE=age AGE_KEYGEN=age-keygen tests/run.sh [--out DIR]
#
# Pure functions (names, retention, recipients) are tested directly. The backup itself runs end to
# end against a throwaway PostgreSQL 18 cluster with the real repository migrations and a
# directory standing in for the R2 bucket (tests/fake-aws.sh), which also models the three R2
# tokens: the backup service's (write), the drill's (read only) and the engine's (not this
# bucket). Every failure path leaves an assertion that it left no archive without its metadata and
# no plaintext behind.
# The bash -c scripts below are single-quoted on purpose: they expand in the child shell.
# shellcheck disable=SC2016
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BK="$DIR/.."
RD="$BK/../restore-drill"
# shellcheck source=../lib/common.sh
source "$BK/lib/common.sh"
# shellcheck source=../../restore-drill/lib.sh
source "$RD/lib.sh"

out=""
while [ "$#" -gt 0 ]; do
  case $1 in
    --out) out=$2; shift 2 ;;
    *) printf 'ERROR: unknown argument: %s\n' "$1" >&2; exit 1 ;;
  esac
done
work=$(mktemp -d)
[ -n "$out" ] || out="$work/out"
mkdir -p "$out"
cleanup() { cl_stop_all; rm -rf "$work"; }
trap cleanup EXIT

passed=0
failed=0
ok() {
  passed=$((passed + 1))
  printf 'PASS\t%s\n' "$1"
}
bad() {
  failed=$((failed + 1))
  printf 'FAIL\t%s\t%s\n' "$1" "${2:-}"
}
assert_eq() { # name expected actual
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected [$2] got [$3]"; fi
}
assert_contains() { # name needle haystack
  if [[ $3 == *"$2"* ]]; then ok "$1"; else bad "$1" "missing [$2] in [${3:0:400}]"; fi
}
assert_not_contains() { # name needle haystack
  if [[ $3 != *"$2"* ]]; then ok "$1"; else bad "$1" "unexpected [$2] in [${3:0:400}]"; fi
}
assert_rc() { # name expected actual
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "exit $3, expected $2"; fi
}

# --- names ---------------------------------------------------------------------------------------------------
assert_eq "daily key" \
  "production/daily/2026-10-19/rampsmith-production-20261019T010203Z" \
  "$(bk_object_base production daily 20261019T010203Z)"
assert_eq "monthly key" \
  "staging/monthly/2026-10/rampsmith-staging-20261019T010203Z" \
  "$(bk_object_base staging monthly 20261019T010203Z)"
for bad_input in "Production daily 20261019T010203Z" "production weekly 20261019T010203Z" \
  "production daily 2026-10-19" "../x daily 20261019T010203Z"; do
  # shellcheck disable=SC2086  # three words on purpose
  (bk_object_base $bad_input) >/dev/null 2>&1
  assert_rc "key rejects: ${bad_input}" 1 $?
done

# --- retention -------------------------------------------------------------------------------------------------
pair() { # period stamp -> the two keys of a complete backup, for env "e" kind "$1"
  local kind=$1 period=$2 stamp=$3
  printf 'tst/%s/%s/rampsmith-tst-%s.dump.age\ntst/%s/%s/rampsmith-tst-%s.meta.json\n' \
    "$kind" "$period" "$stamp" "$kind" "$period" "$stamp"
}
daily_keys() { # first last (day numbers of October 2026)
  local d
  for d in $(seq "$1" "$2"); do
    printf -v day '%02d' "$d"
    pair daily "2026-10-$day" "202610${day}T010000Z"
  done
}

victims=$(daily_keys 1 30 | bk_retention_victims tst daily 30)
assert_eq "retention: exactly 30 periods keeps everything" "" "$victims"
victims=$(daily_keys 1 31 | bk_retention_victims tst daily 30)
assert_eq "retention: the 31st period prunes the oldest one's two objects" \
  "tst/daily/2026-10-01/rampsmith-tst-20261001T010000Z.dump.age
tst/daily/2026-10-01/rampsmith-tst-20261001T010000Z.meta.json" "$victims"
victims=$(daily_keys 1 31 | bk_retention_victims tst daily 10 | wc -l | tr -d ' ')
assert_eq "retention: keep 10 of 31 prunes 21 periods (42 objects)" "42" "$victims"

# An unfinished upload (an archive with no metadata) never counts and, newer than the cutoff, stays.
victims=$({
  daily_keys 1 30
  printf 'tst/daily/2026-10-31/rampsmith-tst-20261031T010000Z.dump.age\n'
} | bk_retention_victims tst daily 30)
assert_eq "retention: an unfinished upload does not push a good backup out" "" "$victims"
victims=$({
  daily_keys 2 31
  printf 'tst/daily/2026-10-01/rampsmith-tst-20261001T010000Z.dump.age\n'
} | bk_retention_victims tst daily 30)
assert_eq "retention: an unfinished upload older than the cutoff is swept" \
  "tst/daily/2026-10-01/rampsmith-tst-20261001T010000Z.dump.age" "$victims"
# Something we did not write is never touched.
victims=$({
  daily_keys 1 35
  printf 'tst/daily/notes.txt\nother/daily/2026-01-01/rampsmith-other-20260101T000000Z.dump.age\n'
  printf 'tst/daily/2026-01-01/rampsmith-tst-20260102T000000Z.dump.age\n'
  printf 'tst/monthly/2026-01/rampsmith-tst-20260101T000000Z.dump.age\n'
} | bk_retention_victims tst daily 30 | grep -c -E 'notes|other/|20260102|monthly' || true)
assert_eq "retention: foreign, mismatched and other-kind keys are never victims" "0" "$victims"
victims=$({ daily_keys 1 31; daily_keys 1 31 | sed 's/tst/staging/g'; } |
  bk_retention_victims tst daily 30 | grep -c 'staging' || true)
assert_eq "retention: only this environment's keys" "0" "$victims"
victims=$(printf '' | bk_retention_victims tst daily 30)
assert_eq "retention: an empty listing deletes nothing" "" "$victims"
(printf '' | bk_retention_victims tst daily 0) >/dev/null 2>&1
assert_rc "retention: a zero count is refused" 1 $?
months=$(for m in 01 02 03 04 05 06 07 08 09 10 11 12 13; do
  if [ "$m" = 13 ]; then pair monthly 2027-01 20270101T000000Z; else pair monthly "2026-$m" "2026${m}01T000000Z"; fi
done | bk_retention_victims tst monthly 12)
assert_eq "retention: 13 monthly periods prune the oldest" \
  "tst/monthly/2026-01/rampsmith-tst-20260101T000000Z.dump.age
tst/monthly/2026-01/rampsmith-tst-20260101T000000Z.meta.json" "$months"
if pair monthly 2026-10 20261001T000000Z | bk_period_complete tst monthly 20261019T010203Z; then
  ok "period check: a complete monthly backup is found"
else bad "period check: a complete monthly backup is found"; fi
if printf 'tst/monthly/2026-10/rampsmith-tst-20261001T000000Z.dump.age\n' | bk_period_complete tst monthly 20261019T010203Z; then
  bad "period check: an archive without metadata is not a monthly backup"
else ok "period check: an archive without metadata is not a monthly backup"; fi

# --- recipients -------------------------------------------------------------------------------------------------------
"$AGE_KEYGEN" -o "$work/primary.key" 2>/dev/null
"$AGE_KEYGEN" -o "$work/offline.key" 2>/dev/null
primary=$("$AGE_KEYGEN" -y "$work/primary.key")
offline=$("$AGE_KEYGEN" -y "$work/offline.key")
both=$(printf '%s\n# the offline recipient\n%s\n' "$primary" "$offline")

res=$(bk_write_recipients "$both" "$work/r1.txt" 2>&1)
assert_rc "recipients: two public keys are accepted" 0 $?
assert_eq "recipients: comments are dropped" "2" "$(wc -l <"$work/r1.txt" | tr -d ' ')"
res=$(bk_write_recipients "$primary" "$work/r2.txt" 2>&1)
assert_contains "recipients: a single recipient warns" "::warning::" "$res"
secret_line=$(grep '^AGE-SECRET-KEY-' "$work/primary.key")
res=$( (bk_write_recipients "$secret_line" "$work/r3.txt") 2>&1)
assert_rc "recipients: a private key is refused" 1 $?
assert_contains "recipients: the refusal says why" "holds a private key" "$res"
assert_not_contains "recipients: the refusal does not echo the key" "${secret_line:0:20}" "$res"
(bk_write_recipients "not-a-key" "$work/r4.txt") >/dev/null 2>&1
assert_rc "recipients: junk is refused" 1 $?
(bk_write_recipients "" "$work/r5.txt") >/dev/null 2>&1
assert_rc "recipients: an empty list is refused" 1 $?

# Hybrid post-quantum recipients (age v1.3.0 and later, `age-keygen -pq`) are valid recipients.
# age refuses a file for post-quantum and classic recipients together, so a list must hold one
# kind, and a mixed list is refused before any dump runs.
"$AGE_KEYGEN" -pq -o "$work/pq1.key" >/dev/null 2>&1
"$AGE_KEYGEN" -pq -o "$work/pq2.key" >/dev/null 2>&1
pq1=$("$AGE_KEYGEN" -y "$work/pq1.key")
pq2=$("$AGE_KEYGEN" -y "$work/pq2.key")
res=$(bk_write_recipients "$(printf '%s\n%s\n' "$pq1" "$pq2")" "$work/r6.txt" 2>&1)
assert_rc "recipients: two post-quantum recipients are accepted" 0 $?
printf 'round trip' | "$AGE" -R "$work/r6.txt" -o "$work/pq.age"
assert_eq "recipients: the first post-quantum key opens the file" "round trip" "$("$AGE" -d -i "$work/pq1.key" "$work/pq.age")"
assert_eq "recipients: the second post-quantum key opens the file" "round trip" "$("$AGE" -d -i "$work/pq2.key" "$work/pq.age")"
res=$( (bk_write_recipients "$(printf '%s\n%s\n' "$pq1" "$offline")" "$work/r7.txt") 2>&1)
assert_rc "recipients: a mixed list is refused" 1 $?
assert_contains "recipients: the refusal names the cause" "mixes post-quantum" "$res"

# --- a database to back up ---------------------------------------------------------------------------------------------------
port=$((${DRILL_PORT_BASE:-54600}))
cl_start t "$work/t" "$port"
cl_psql t postgres postgres -c "create database rampsmith"
rd_bootstrap t rampsmith
rd_migrate t rampsmith rampsmith_migrator
cl_psql t rampsmith rampsmith_api -v tenant=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa -v label=alpha \
  -v findings=40 -v occurrences=50 -f "$RD/sql/seed.sql"
cl_psql t rampsmith rampsmith_api -v tenant=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb -v label=beta \
  -v findings=40 -v occurrences=50 -f "$RD/sql/seed.sql"
BACKUP_DB_PASSWORD=pw "$PGBIN/psql" -X -q -v ON_ERROR_STOP=1 -h "${CL_DIR[t]}/sock" -p "$port" \
  -U postgres -d rampsmith -f "$BK/backup-role.sql"
sock="${CL_DIR[t]}/sock"

s3="$work/s3"
bucket=bk-tests
store="$s3/$bucket"
mkdir -p "$store"

STD=(
  "PATH=$PGBIN:$PATH" "LD_LIBRARY_PATH=${LD_LIBRARY_PATH:-}" "HOME=$work"
  "PGBIN=$PGBIN" "AGE_BIN=$AGE" "AWS_BIN=$DIR/fake-aws.sh" "FAKE_S3_ROOT=$s3"
  "R2_ACCOUNT_ID=00000000000000000000000000000000" "R2_ENDPOINT_URL=http://r2.invalid"
  "BACKUP_R2_ACCESS_KEY_ID=test-key" "BACKUP_R2_SECRET_ACCESS_KEY=test-secret" "R2_BUCKET_BACKUPS=$bucket"
  "BACKUP_ENVIRONMENT=staging" "BACKUP_DB_HOST=$sock" "BACKUP_DB_PORT=$port"
  "BACKUP_DB_USER=rampsmith_backup" "BACKUP_DB_NAME=rampsmith" "BACKUP_DB_PASSWORD=pw"
  "BACKUP_AGE_RECIPIENTS=$both" "BACKUP_NOW=20261019T010203Z"
)
run_backup() { # [--without NAME]... [NAME=value]...
  local args=() extra=() drop=() item name skip d
  while [ "$#" -gt 0 ]; do
    case $1 in
      --without) drop+=("$2"); shift 2 ;;
      *) extra+=("$1"); shift ;;
    esac
  done
  for item in "${STD[@]}" "${extra[@]}"; do
    name=${item%%=*}
    skip=0
    for d in "${drop[@]}"; do [ "$d" = "$name" ] && skip=1; done
    [ "$skip" -eq 1 ] || args+=("$item")
  done
  result=$(env -i "${args[@]}" "${BK_COMMAND:-$BK/backup.sh}" 2>&1)
  rc=$?
  printf '%s\n' "$result" >>"$out/backup-runs.log"
}
files() { (cd "$store" && find . -type f | sed 's|^\./||' | LC_ALL=C sort); }
reset_store() { rm -rf "$store"; mkdir -p "$store"; }

# --- not configured: skip loudly, never silently -----------------------------------------------------------------------------
reset_store
run_backup --without BACKUP_R2_SECRET_ACCESS_KEY --without R2_BUCKET_BACKUPS
assert_rc "unconfigured: exit 3" 3 "$rc"
assert_contains "unconfigured: names the missing variables" "BACKUP_R2_SECRET_ACCESS_KEY R2_BUCKET_BACKUPS" "$result"
assert_contains "unconfigured: names LAUNCH.md section C row 16" "LAUNCH.md section C row 16" "$result"
assert_contains "unconfigured: is a warning annotation" "::warning::" "$result"
assert_contains "unconfigured: names the environment" "backup of staging not configured" "$result"
assert_not_contains "unconfigured: does not name what is present" "BACKUP_R2_ACCESS_KEY_ID" "$result"
assert_eq "unconfigured: nothing was stored" "" "$(files)"
run_backup --without BACKUP_AGE_RECIPIENTS
assert_rc "unconfigured: no recipients is exit 3 too" 3 "$rc"
assert_contains "unconfigured: names BACKUP_AGE_RECIPIENTS" "BACKUP_AGE_RECIPIENTS" "$result"
run_backup --without BACKUP_DB_PASSWORD
assert_rc "unconfigured: no database password is exit 3 too" 3 "$rc"
assert_contains "unconfigured: names BACKUP_DB_PASSWORD" "BACKUP_DB_PASSWORD" "$result"
# shellcheck disable=SC2016  # the text is Railway's own reference syntax, not a shell expansion
run_backup 'BACKUP_R2_SECRET_ACCESS_KEY=${{shared.BACKUP_R2_SECRET_ACCESS_KEY}}'
assert_rc "unconfigured: a Railway reference nobody resolved counts as unset" 3 "$rc"
assert_contains "unconfigured: names the unresolved variable" "needs BACKUP_R2_SECRET_ACCESS_KEY (" "$result"
# The engine's token is not the backup's (ADR-091): with only the engine's names set, the service
# is unconfigured, and the engine's secret is neither used nor printed.
run_backup --without BACKUP_R2_ACCESS_KEY_ID --without BACKUP_R2_SECRET_ACCESS_KEY \
  R2_ACCESS_KEY_ID=engine-key R2_SECRET_ACCESS_KEY=engine-secret-marker
assert_rc "unconfigured: the engine's R2 token is not a backup token" 3 "$rc"
assert_contains "unconfigured: names the backup token variables" \
  "BACKUP_R2_ACCESS_KEY_ID BACKUP_R2_SECRET_ACCESS_KEY" "$result"
assert_not_contains "unconfigured: prints no secret" "engine-secret-marker" "$result"
# The helpers behind those messages.
assert_eq "helpers: missing names for the backup token set, in order" \
  "R2_ACCOUNT_ID BACKUP_R2_SECRET_ACCESS_KEY" \
  "$(env -i PATH="$PATH" BACKUP_R2_ACCESS_KEY_ID=x R2_BUCKET_BACKUPS=b bash -c \
    'source "$1"; bk_missing_r2 BACKUP_R2 | tr "\n" " " | sed "s/ $//"' _ "$BK/lib/common.sh")"
assert_eq "helpers: missing names for the drill token set" \
  "DRILL_R2_ACCESS_KEY_ID DRILL_R2_SECRET_ACCESS_KEY" \
  "$(env -i PATH="$PATH" R2_ACCOUNT_ID=a R2_BUCKET_BACKUPS=b BACKUP_R2_ACCESS_KEY_ID=x BACKUP_R2_SECRET_ACCESS_KEY=y bash -c \
    'source "$1"; bk_missing_r2 DRILL_R2 | tr "\n" " " | sed "s/ $//"' _ "$BK/lib/common.sh")"
env -i PATH="$PATH" bash -c 'source "$1"; bk_missing_r2 R2 2>/dev/null' _ "$BK/lib/common.sh"
assert_rc "helpers: an unknown credential set is refused" 2 $?
env -i PATH="$PATH" R2_ACCOUNT_ID=a R2_BUCKET_BACKUPS=b ACCESS_KEY=k bash -c \
  'source "$1"; source "$2"; s3_init R2' _ "$BK/lib/common.sh" "$BK/lib/s3.sh" >/dev/null 2>&1
assert_rc "helpers: s3_init refuses a credential set that is not BACKUP_R2 or DRILL_R2" 1 $?

# --- the entrypoint: the one command Railway runs --------------------------------------------------------------------------------------
entry_out=$(env -i PATH="$PATH" BACKUP_ENVIRONMENT=production "$BK/entrypoint.sh" 2>&1)
assert_rc "entrypoint: an unconfigured service exits 0" 0 $?
assert_contains "entrypoint: ... with a warning annotation" "::warning::backup of production not configured" "$entry_out"
assert_contains "entrypoint: ... naming the row" "LAUNCH.md section C row 16" "$entry_out"
assert_contains "entrypoint: ... and saying it skipped" "backup skipped" "$entry_out"
entry_out=$(env -i PATH="$PATH" "$BK/entrypoint.sh" 2>&1)
assert_rc "entrypoint: with nothing set at all it still exits 0" 0 $?
assert_contains "entrypoint: ... and names every input" \
  "R2_ACCOUNT_ID BACKUP_R2_ACCESS_KEY_ID BACKUP_R2_SECRET_ACCESS_KEY R2_BUCKET_BACKUPS BACKUP_AGE_RECIPIENTS BACKUP_DB_PASSWORD" "$entry_out"

# --- the live restore drill: skip with a notice, never silently ------------------------------------------------------------------------
live_out=$(env -i PATH="$PATH" "$RD/live.sh" --environment staging --scratch "$work/live-scratch" 2>&1)
assert_rc "live drill: nothing configured is not an error" 0 $?
assert_contains "live drill: nothing configured is a warning" "::warning::live restore drill skipped" "$live_out"
assert_contains "live drill: names LAUNCH.md section C row 16" "LAUNCH.md section C row 16" "$live_out"
assert_contains "live drill: names the drill's R2 variables" "DRILL_R2_ACCESS_KEY_ID DRILL_R2_SECRET_ACCESS_KEY" "$live_out"
assert_contains "live drill: names the drill key" "BACKUP_DRILL_AGE_KEY" "$live_out"
assert_not_contains "live drill: does not ask for the backup service's token" "BACKUP_R2_" "$live_out"
live_out=$(env -i PATH="$PATH" R2_ACCOUNT_ID=0123456789abcdef0123456789abcdef DRILL_R2_ACCESS_KEY_ID=x \
  DRILL_R2_SECRET_ACCESS_KEY=y R2_BUCKET_BACKUPS=some-bucket "$RD/live.sh" --environment staging --scratch "$work/live-scratch" 2>&1)
assert_rc "live drill: only the drill key missing is still a skip" 0 $?
assert_contains "live drill: names only what is missing" "needs BACKUP_DRILL_AGE_KEY (LAUNCH" "$live_out"
assert_not_contains "live drill: does not name what is present" "DRILL_R2_ACCESS_KEY_ID" "$live_out"
# The backup service's token is no substitute for the drill's (ADR-091).
live_out=$(env -i PATH="$PATH" R2_ACCOUNT_ID=0123456789abcdef0123456789abcdef BACKUP_R2_ACCESS_KEY_ID=x \
  BACKUP_R2_SECRET_ACCESS_KEY=y R2_BUCKET_BACKUPS=some-bucket BACKUP_DRILL_AGE_KEY=k "$RD/live.sh" \
  --environment staging --scratch "$work/live-scratch" 2>&1)
assert_rc "live drill: the backup service's token alone is a skip" 0 $?
assert_contains "live drill: ... that names the drill's token" "DRILL_R2_ACCESS_KEY_ID" "$live_out"
# Both tokens in one environment is a configuration error, not a skip.
live_out=$(env -i PATH="$PATH" R2_ACCOUNT_ID=0123456789abcdef0123456789abcdef DRILL_R2_ACCESS_KEY_ID=x \
  DRILL_R2_SECRET_ACCESS_KEY=y R2_BUCKET_BACKUPS=some-bucket BACKUP_DRILL_AGE_KEY=k BACKUP_R2_SECRET_ACCESS_KEY=write-marker \
  "$RD/live.sh" --environment staging --scratch "$work/live-scratch" 2>&1)
assert_rc "live drill: the write token in the drill's environment is refused" 1 $?
assert_contains "live drill: ... naming the variable" "BACKUP_R2_SECRET_ACCESS_KEY is set" "$live_out"
assert_not_contains "live drill: ... without printing it" "write-marker" "$live_out"
live_out=$(env -i PATH="$PATH" "$RD/live.sh" --environment 'Bad Env' 2>&1)
assert_rc "live drill: a bad environment name is an error" 1 $?

# --- the happy path --------------------------------------------------------------------------------------------------------------------
reset_store
run_backup
assert_rc "backup: succeeds" 0 "$rc"
assert_eq "backup: stores a daily and a monthly pair" \
  "staging/daily/2026-10-19/rampsmith-staging-20261019T010203Z.dump.age
staging/daily/2026-10-19/rampsmith-staging-20261019T010203Z.meta.json
staging/monthly/2026-10/rampsmith-staging-20261019T010203Z.dump.age
staging/monthly/2026-10/rampsmith-staging-20261019T010203Z.meta.json" "$(files)"

# list-backups.sh, which the restore runbook uses to pick the object: complete and unfinished
# archives, newest first, and a loud failure when the token variables are missing.
mkdir -p "$store/staging/daily/2026-10-18"
: >"$store/staging/daily/2026-10-18/rampsmith-staging-20261018T010203Z.dump.age"
list_env=(
  "PATH=$PATH" "AWS_BIN=$DIR/fake-aws.sh" "FAKE_S3_ROOT=$s3" "R2_ENDPOINT_URL=http://r2.invalid"
  "R2_ACCOUNT_ID=00000000000000000000000000000000" "DRILL_R2_ACCESS_KEY_ID=drill-read-key"
  "DRILL_R2_SECRET_ACCESS_KEY=drill-read-secret" "R2_BUCKET_BACKUPS=$bucket"
)
list_out=$(env -i "${list_env[@]}" "$RD/list-backups.sh" --environment staging 2>&1)
assert_rc "list-backups: lists a configured bucket" 0 $?
assert_eq "list-backups: newest first, unfinished uploads marked, monthly after daily" \
  "daily	staging/daily/2026-10-19/rampsmith-staging-20261019T010203Z.dump.age	complete
daily	staging/daily/2026-10-18/rampsmith-staging-20261018T010203Z.dump.age	incomplete
monthly	staging/monthly/2026-10/rampsmith-staging-20261019T010203Z.dump.age	complete" "$list_out"
list_out=$(env -i "${list_env[@]}" "$RD/list-backups.sh" --environment staging --kind monthly 2>&1)
assert_eq "list-backups: --kind monthly lists only the monthly archive" \
  "monthly	staging/monthly/2026-10/rampsmith-staging-20261019T010203Z.dump.age	complete" "$list_out"
list_out=$(env -i "${list_env[@]}" "$RD/list-backups.sh" --environment production 2>&1)
assert_rc "list-backups: an environment with no backups is not an error" 0 $?
assert_contains "list-backups: says there is nothing" "no backups under production/" "$list_out"
assert_not_contains "list-backups: never lists another environment's keys" "staging/" "$list_out"
list_out=$(env -i PATH="$PATH" "$RD/list-backups.sh" --environment staging 2>&1)
assert_rc "list-backups: missing variables fail" 1 $?
assert_contains "list-backups: names the variables and the row" "DRILL_R2_ACCESS_KEY_ID" "$list_out"
assert_contains "list-backups: names LAUNCH.md section C row 16" "LAUNCH.md section C row 16" "$list_out"
list_out=$(env -i PATH="$PATH" AWS_BIN="$DIR/fake-aws.sh" FAKE_S3_ROOT="$s3" R2_ENDPOINT_URL=http://r2.invalid \
  R2_ACCOUNT_ID=00000000000000000000000000000000 R2_BUCKET_BACKUPS="$bucket" \
  BACKUP_R2_ACCESS_KEY_ID=test-key BACKUP_R2_SECRET_ACCESS_KEY=test-secret "$RD/list-backups.sh" --environment staging 2>&1)
assert_rc "list-backups: the backup service's write token is not accepted in its place" 1 $?
assert_contains "list-backups: ... and the drill's variables are named" "DRILL_R2_SECRET_ACCESS_KEY" "$list_out"
list_out=$(env -i "${list_env[@]}" "$RD/list-backups.sh" --environment '../x' 2>&1)
assert_rc "list-backups: a bad environment name fails" 1 $?
list_out=$(env -i "${list_env[@]}" "$RD/list-backups.sh" --environment staging --kind weekly 2>&1)
assert_rc "list-backups: a bad kind fails" 1 $?
rm -rf "$store/staging/daily/2026-10-18"
archive="$store/staging/daily/2026-10-19/rampsmith-staging-20261019T010203Z.dump.age"
meta="$store/staging/daily/2026-10-19/rampsmith-staging-20261019T010203Z.meta.json"
assert_eq "backup: the archive is an age file" "age-encryption.org/v1" "$(head -c 21 "$archive")"
assert_eq "backup: no PostgreSQL archive magic in the stored bytes" "0" "$(grep -c PGDMP "$archive" || true)"
assert_eq "backup: no row text in the stored bytes" "0" "$(grep -c 'sections/header.liquid' "$archive" || true)"
for who in primary offline; do
  "$AGE" -d -i "$work/$who.key" -o "$work/plain-$who.dump" "$archive" 2>/dev/null
  assert_eq "backup: the ${who} key decrypts it to a PostgreSQL archive" "PGDMP" "$(head -c 5 "$work/plain-$who.dump")"
done
meta_json=$(cat "$meta")
json_field() { # path expression, e.g. "->> 'format'" or "-> 'database' ->> 'schema_version'"
  printf "select (:'meta'::jsonb) %s;\n" "$1" |
    "$PGBIN/psql" -X -q -At -h "$sock" -p "$port" -U postgres -d postgres -v meta="$meta_json"
}
check_json() { # name field expected
  assert_eq "$1" "$3" "$(json_field "->> '$2'")"
}
check_json "meta: is valid JSON with its format" format "rampsmith-backup-meta/1"
check_json "meta: environment" environment staging
check_json "meta: kind" kind daily
check_json "meta: size matches the file" size_bytes "$(wc -c <"$archive" | tr -d ' ')"
check_json "meta: sha256 matches the file" sha256 "$(sha256sum "$archive" | cut -d' ' -f1)"
assert_eq "meta: schema version is the newest migration" "$(rd_repo_newest_migration)" \
  "$(json_field "-> 'database' ->> 'schema_version'")"
assert_contains "meta: records the recipients fingerprint, not the keys" "recipients_fingerprint" "$meta_json"
assert_not_contains "meta: holds no recipient key" "age1" "$meta_json"
assert_not_contains "output: holds no secret" "test-secret" "$result"
assert_not_contains "output: holds no database password" "BACKUP_DB_PASSWORD" "$result"

# --- a second run the same day, the next day, the next month --------------------------------------------------------------------------
run_backup BACKUP_NOW=20261019T020304Z
assert_rc "second run the same day: succeeds" 0 "$rc"
assert_eq "same day: two daily pairs in one period, one monthly pair" "6" "$(files | wc -l | tr -d ' ')"
run_backup BACKUP_NOW=20261020T010203Z
assert_contains "next day: the monthly copy already exists" "monthly backup for 2026-10 already exists" "$result"
assert_eq "next day: a new daily period only" "8" "$(files | wc -l | tr -d ' ')"
run_backup BACKUP_NOW=20261101T010203Z
assert_eq "next month: a new monthly period" "1" "$(files | grep -c 'monthly/2026-11/.*meta.json' || true)"

# --- retention while backing up -----------------------------------------------------------------------------------------------------------
reset_store
for d in $(seq 1 30); do
  printf -v day '%02d' "$d"
  mkdir -p "$store/staging/daily/2026-09-$day" "$store/staging/monthly/2026-09"
  : >"$store/staging/daily/2026-09-$day/rampsmith-staging-202609${day}T010000Z.dump.age"
  : >"$store/staging/daily/2026-09-$day/rampsmith-staging-202609${day}T010000Z.meta.json"
done
: >"$store/staging/monthly/2026-09/rampsmith-staging-20260901T010000Z.dump.age"
: >"$store/staging/monthly/2026-09/rampsmith-staging-20260901T010000Z.meta.json"
run_backup BACKUP_NOW=20261001T010203Z
assert_rc "retention: backup with pruning succeeds" 0 "$rc"
assert_contains "retention: prunes the oldest daily" "pruned staging/daily/2026-09-01/" "$result"
assert_eq "retention: 30 daily periods remain" "30" "$(files | grep -c 'daily/.*meta.json' || true)"
assert_eq "retention: the new backup is among them" "1" "$(files | grep -c 'daily/2026-10-01/.*meta.json' || true)"

reset_store
for d in $(seq 1 30); do
  printf -v day '%02d' "$d"
  mkdir -p "$store/staging/daily/2026-08-$day"
  : >"$store/staging/daily/2026-08-$day/rampsmith-staging-202608${day}T010000Z.dump.age"
  : >"$store/staging/daily/2026-08-$day/rampsmith-staging-202608${day}T010000Z.meta.json"
done
run_backup BACKUP_NOW=20261201T010203Z BACKUP_KEEP_DAILY=2 BACKUP_PRUNE_MAX=5
assert_rc "retention: refuses to delete more than the limit" 1 "$rc"
assert_contains "retention: says it refused" "refusing to delete" "$result"
assert_eq "retention: the new backup is stored anyway" "1" "$(files | grep -c 'daily/2026-12-01/.*meta.json' || true)"
assert_eq "retention: nothing was deleted" "31" "$(files | grep -c 'daily/.*meta.json' || true)"

# --- failures leave no archive without its metadata ---------------------------------------------------------------------------------------
expect_failure() { # name expected-message
  assert_rc "$1: exit 1" 1 "$rc"
  assert_contains "$1: says why" "$2" "$result"
  assert_eq "$1: stores no metadata object" "0" "$(files | grep -c 'meta.json' || true)"
}
reset_store
cl_psql t rampsmith postgres -c "alter role rampsmith_backup nobypassrls"
run_backup
expect_failure "backup role without BYPASSRLS" "row-level security"
cl_psql t rampsmith postgres -c "alter role rampsmith_backup bypassrls"
assert_eq "backup role without BYPASSRLS: stores no archive either" "" "$(files)"

reset_store
run_backup BACKUP_DB_USER=rampsmith_api
expect_failure "application login as the backup login" "could not read the migration version"
assert_eq "application login: stores nothing" "" "$(files)"

reset_store
run_backup BACKUP_DB_NAME=does_not_exist
expect_failure "unknown database" "could not read the migration version"

# A pg_dump that is killed after it has written the start of a valid archive: age still finishes
# a file from the truncated stream, so only the exit status of pg_dump stands between that file
# and the bucket.
shim="$work/shim"
mkdir -p "$shim"
for tool in pg_restore psql; do ln -sf "$PGBIN/$tool" "$shim/$tool"; done
cat >"$shim/pg_dump" <<EOF
#!/usr/bin/env bash
"$PGBIN/pg_dump" "\$@" | head -c 4000
exit 1
EOF
chmod +x "$shim/pg_dump"
reset_store
run_backup PGBIN="$shim"
expect_failure "pg_dump killed mid-stream" "pg_dump failed"
assert_eq "pg_dump killed mid-stream: stores no archive" "" "$(files)"

reset_store
run_backup FAKE_AWS_FAULT=put-fail
expect_failure "upload refused" "upload of"
reset_store
run_backup FAKE_AWS_FAULT=put-truncate FAKE_AWS_FAULT_KEY='*.dump.age'
expect_failure "truncated upload" "stored size"
reset_store
run_backup FAKE_AWS_FAULT=put-corrupt FAKE_AWS_FAULT_KEY='*.dump.age'
expect_failure "corrupted upload" "sha256 mismatch"
reset_store
run_backup FAKE_AWS_FAULT=get-corrupt FAKE_AWS_FAULT_KEY='*.dump.age'
expect_failure "corrupted read-back" "sha256 mismatch"
reset_store
run_backup FAKE_AWS_FAULT=head-fail
expect_failure "size check unavailable" "could not read the size"
reset_store
run_backup FAKE_AWS_FAULT=list-fail
assert_rc "listing unavailable: exit 1" 1 "$rc"
assert_contains "listing unavailable: says why" "could not list" "$result"
reset_store
run_backup BACKUP_AGE_RECIPIENTS="age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq"
assert_rc "bad recipient checksum: exit 1" 1 "$rc"
assert_eq "bad recipient checksum: stores nothing" "" "$(files)"
run_backup BACKUP_AGE_RECIPIENTS="$secret_line"
assert_rc "private key as recipient: exit 1" 1 "$rc"
assert_not_contains "private key as recipient: not echoed" "${secret_line:0:24}" "$result"

# --- retention stage failures happen after the backup is safe --------------------------------------------------------------------------------
reset_store
for d in $(seq 1 3); do
  printf -v day '%02d' "$d"
  mkdir -p "$store/staging/daily/2026-09-$day"
  : >"$store/staging/daily/2026-09-$day/rampsmith-staging-202609${day}T010000Z.dump.age"
  : >"$store/staging/daily/2026-09-$day/rampsmith-staging-202609${day}T010000Z.meta.json"
done
run_backup BACKUP_KEEP_DAILY=2 FAKE_AWS_FAULT=rm-fail
assert_rc "prune failure: exit 1" 1 "$rc"
assert_eq "prune failure: the new backup is stored" "1" "$(files | grep -c 'daily/2026-10-19/.*meta.json' || true)"

# --- a failed backup is a failed run, and a success stays a success, through the entrypoint ----------------------------------------------
BK_COMMAND="$BK/entrypoint.sh"
reset_store
run_backup
assert_rc "entrypoint: a configured backup exits 0" 0 "$rc"
assert_eq "entrypoint: ... and stores the four objects" "4" "$(files | wc -l | tr -d ' ')"
reset_store
run_backup BACKUP_DB_USER=rampsmith_api
assert_rc "entrypoint: a failed backup exits 1, so Railway shows a failed run" 1 "$rc"
assert_contains "entrypoint: ... and says why" "could not read the migration version" "$result"
reset_store
run_backup --without BACKUP_AGE_RECIPIENTS
assert_rc "entrypoint: an unconfigured backup exits 0" 0 "$rc"
assert_eq "entrypoint: ... and stores nothing" "" "$(files)"
unset BK_COMMAND

# --- the three R2 tokens each reach only what they are for (ADR-091, finding M1) -------------------------------------------------------
# The fake bucket answers 403 AccessDenied to a token that does not cover the bucket and to a read
# only token that writes, as R2 documents (error code 10003).
reset_store
SCOPE=(FAKE_AWS_WRITE_KEY=backup-write-key FAKE_AWS_READ_KEY=drill-read-key)
run_backup "${SCOPE[@]}" BACKUP_R2_ACCESS_KEY_ID=backup-write-key R2_ACCESS_KEY_ID=engine-evidence-key \
  R2_SECRET_ACCESS_KEY=engine-secret-marker
assert_rc "tokens: the backup uses its own token, with the engine's names set beside it" 0 "$rc"
assert_eq "tokens: ... and stores its four objects" "4" "$(files | wc -l | tr -d ' ')"
assert_not_contains "tokens: ... without printing the engine's secret" "engine-secret-marker" "$result"
reset_store
run_backup "${SCOPE[@]}" BACKUP_R2_ACCESS_KEY_ID=engine-evidence-key
assert_rc "tokens: the evidence token is refused on the backups bucket" 1 "$rc"
assert_contains "tokens: ... as an upload that failed" "upload of" "$result"
assert_contains "tokens: ... with the bucket's AccessDenied" "AccessDenied (403)" "$result"
assert_eq "tokens: ... and nothing is stored" "" "$(files)"
reset_store
run_backup "${SCOPE[@]}" BACKUP_R2_ACCESS_KEY_ID=drill-read-key
assert_rc "tokens: the drill's read-only token cannot write a backup" 1 "$rc"
assert_contains "tokens: ... it is refused as read only" "this token is read only" "$result"
assert_eq "tokens: ... and nothing is stored" "" "$(files)"
reset_store
run_backup "${SCOPE[@]}" BACKUP_R2_ACCESS_KEY_ID=backup-write-key
drill_env=(
  "PATH=$PATH" "AWS_BIN=$DIR/fake-aws.sh" "FAKE_S3_ROOT=$s3" "R2_ENDPOINT_URL=http://r2.invalid"
  "R2_ACCOUNT_ID=00000000000000000000000000000000" "R2_BUCKET_BACKUPS=$bucket"
  "DRILL_R2_ACCESS_KEY_ID=drill-read-key" "DRILL_R2_SECRET_ACCESS_KEY=drill-read-secret" "${SCOPE[@]}"
)
list_out=$(env -i "${drill_env[@]}" "$RD/list-backups.sh" --environment staging --kind daily 2>&1)
assert_rc "tokens: the drill's read-only token lists the backups" 0 $?
assert_contains "tokens: ... and sees the archive" "staging/daily/2026-10-19/rampsmith-staging-20261019T010203Z.dump.age" "$list_out"
env -i "${drill_env[@]}" bash -c 'source "$1"; source "$2"; s3_init DRILL_R2; s3_delete "$3"' _ \
  "$BK/lib/common.sh" "$BK/lib/s3.sh" "staging/daily/2026-10-19/rampsmith-staging-20261019T010203Z.meta.json" >/dev/null 2>&1
assert_rc "tokens: the drill's read-only token cannot delete a backup" 1 $?
assert_eq "tokens: ... and the metadata object is still there" "1" \
  "$(files | grep -c 'daily/.*meta.json' || true)"
env -i "${drill_env[@]}" DRILL_R2_ACCESS_KEY_ID=engine-evidence-key bash -c \
  'source "$1"; source "$2"; s3_init DRILL_R2; s3_size "$3"' _ "$BK/lib/common.sh" "$BK/lib/s3.sh" \
  "staging/daily/2026-10-19/rampsmith-staging-20261019T010203Z.dump.age" >/dev/null 2>&1
assert_rc "tokens: the evidence token cannot read the backups bucket either" 1 $?

# --- the live drill hands its inputs to a container that runs as another user (finding M3, ADR-094) -----------------------------------------
# live.sh runs under umask 077; the restore runs as the postgres image's user (uid 999), not the
# runner's. The stand-in for in-container.sh checks the permission bits any other user is held to,
# that the private key arrives in the environment and is on no disk under the scratch directory,
# and that the archive then decrypts. The newest backup in the store is the one the last run wrote.
handoff_env=(
  "PATH=$PATH" "AWS_BIN=$DIR/fake-aws.sh" "FAKE_S3_ROOT=$s3" "R2_ENDPOINT_URL=http://r2.invalid"
  "R2_ACCOUNT_ID=00000000000000000000000000000000" "R2_BUCKET_BACKUPS=$bucket"
  "DRILL_R2_ACCESS_KEY_ID=drill-read-key" "DRILL_R2_SECRET_ACCESS_KEY=drill-read-secret"
  "BACKUP_DRILL_AGE_KEY=$(cat "$work/primary.key")" "AGE=$AGE"
  "RD_IN_CONTAINER=$RD/tests/fake-in-container.sh" "${SCOPE[@]}"
)
handoff_out=$(env -i "${handoff_env[@]}" "$RD/live.sh" --environment staging --scratch "$work/handoff" --max-age-hours 1000000 2>&1)
assert_rc "handoff: the live drill completes against the fake bucket" 0 $?
assert_contains "handoff: other users can open the archive" "PASS	read: other users can open $work/handoff/work/backup.dump.age" "$handoff_out"
assert_contains "handoff: other users can open the metadata" "PASS	read: other users can open $work/handoff/work/backup.meta.json" "$handoff_out"
assert_contains "handoff: other users can write the outputs" "PASS	write: other users can create files in out/" "$handoff_out"
assert_contains "handoff: the key arrives in the environment" "PASS	key: passed in the environment" "$handoff_out"
assert_contains "handoff: the key is on no disk" "PASS	key: no private key on disk under the scratch directory" "$handoff_out"
assert_contains "handoff: the archive decrypts with it" "PASS	decrypt: the archive opens to a PostgreSQL archive" "$handoff_out"
assert_eq "handoff: work is world-readable" "755" "$(stat -c %a "$work/handoff/work")"
assert_eq "handoff: out is world-writable" "777" "$(stat -c %a "$work/handoff/out")"
assert_eq "handoff: the scratch directory can be entered by others" "755" "$(stat -c %a "$work/handoff")"
assert_eq "handoff: the archive is world-readable" "644" "$(stat -c %a "$work/handoff/work/backup.dump.age")"
assert_eq "handoff: no private key was written anywhere in the scratch tree" "0" \
  "$(grep -rIlF 'AGE-SECRET-KEY-' "$work/handoff" | wc -l | tr -d ' ')"
assert_not_contains "handoff: the key is not in the output" "AGE-SECRET-KEY-" "$handoff_out"

# The check must be able to fail: the layout live.sh made before the fix (umask 077) is refused.
rm -rf "$work/bad-scratch"
mkdir -p "$work/bad-scratch/work" "$work/bad-scratch/out"
cp "$work/handoff/work/backup.dump.age" "$work/handoff/work/backup.meta.json" "$work/bad-scratch/work/"
chmod 700 "$work/bad-scratch" "$work/bad-scratch/work" "$work/bad-scratch/out"
chmod 600 "$work/bad-scratch/work/backup.dump.age" "$work/bad-scratch/work/backup.meta.json"
bad_out=$(env -i PATH="$PATH" AGE="$AGE" RD_SCRATCH="$work/bad-scratch" RD_IDENTITY="$(cat "$work/primary.key")" \
  "$RD/tests/fake-in-container.sh" 2>&1)
assert_rc "handoff: a 0700 scratch tree is refused (the original defect)" 1 $?
assert_contains "handoff: ... because the directory cannot be entered" "not searchable by other users" "$bad_out"
assert_contains "handoff: ... and the outputs cannot be written" "FAIL	write: " "$bad_out"
bad_out=$(env -i PATH="$PATH" AGE="$AGE" RD_SCRATCH="$work/handoff" "$RD/tests/fake-in-container.sh" 2>&1)
assert_rc "handoff: a missing key is refused" 1 $?
assert_contains "handoff: ... by name" "FAIL	key: RD_IDENTITY was not passed" "$bad_out"
bad_out=$(env -i PATH="$PATH" AGE="$AGE" RD_SCRATCH="$work/handoff" RD_IDENTITY="$(cat "$work/primary.key")" \
  "$RD/tests/fake-in-container.sh" 2>&1)
assert_rc "handoff: the fake passes on the layout live.sh now makes" 0 $?

# container-run.sh is what in-container.sh runs inside the container around the command.
cr_dir="$work/container-run"
mkdir -p "$cr_dir/scratch/out"
chmod 700 "$cr_dir/scratch/out"
printf 'report\n' >"$cr_dir/scratch/out/report.txt"
chmod 600 "$cr_dir/scratch/out/report.txt"
cr_out=$(env -i PATH="$PATH" RD_IDENTITY_FILE="$cr_dir/identity.key" RD_SCRATCH_DIR="$cr_dir/scratch" \
  RD_IDENTITY="$(cat "$work/primary.key")" "$RD/container-run.sh" bash -c '
    printf "mode %s\n" "$(stat -c %a "$RD_IDENTITY_FILE")"
    printf "age_ok %s\n" "$(grep -c "AGE-SECRET-KEY-" "$RD_IDENTITY_FILE")"
    printf "env %s\n" "${RD_IDENTITY:-unset}"
    printf "environ %s\n" "$(tr "\0" "\n" </proc/$$/environ | grep -c "^RD_IDENTITY=")"
    exit 7' 2>&1)
cr_rc=$?
assert_rc "container-run: the command's exit status is the exit status" 7 "$cr_rc"
assert_contains "container-run: the key file is private to its user" "mode 600" "$cr_out"
assert_contains "container-run: the key file holds the key" "age_ok 1" "$cr_out"
assert_contains "container-run: the command does not see the key variable" "env unset" "$cr_out"
assert_contains "container-run: ... and neither does its process environment" "environ 0" "$cr_out"
assert_eq "container-run: the key file is deleted afterwards" "absent" \
  "$([ -e "$cr_dir/identity.key" ] && echo present || echo absent)"
assert_eq "container-run: the reports are readable for the runner afterwards" "755 644" \
  "$(stat -c %a "$cr_dir/scratch/out") $(stat -c %a "$cr_dir/scratch/out/report.txt")"
env -i PATH="$PATH" RD_IDENTITY_FILE="$cr_dir/none.key" RD_SCRATCH_DIR="$cr_dir/scratch" "$RD/container-run.sh" true
assert_rc "container-run: without a key no key file is written" 0 $?
assert_eq "container-run: ... none" "absent" "$([ -e "$cr_dir/none.key" ] && echo present || echo absent)"
assert_eq "container-run: live.sh and container-run.sh agree on the key file" "1 1" \
  "$(grep -c -- '--identity /tmp/rd-identity.key' "$RD/live.sh") $(grep -c '/tmp/rd-identity.key' "$RD/container-run.sh")"

# --- the metadata object is the commit marker ---------------------------------------------------------------------------------------------------------
reset_store
run_backup
find "$store" -name '*.meta.json' -delete
marker_out=$(env -i "${STD[@]}" DRILL_R2_ACCESS_KEY_ID=drill-read-key DRILL_R2_SECRET_ACCESS_KEY=drill-read-secret PGHOST="$sock" PGPORT="$port" PGUSER=postgres "$RD/restore.sh" \
  --target rampsmith --identity "$work/primary.key" --work "$work/restore-marker" \
  --object staging/daily/2026-10-19/rampsmith-staging-20261019T010203Z.dump.age 2>&1)
assert_rc "restore refuses an archive without metadata: exit 1" 1 $?
assert_contains "restore refuses an archive without metadata: says why" "the upload never finished" "$marker_out"

# --- the R2 rule files agree with the retention (ADR-172 decisions 6 and 7) ------------------------------------------------------------------------
# The founder applies these files by hand, so nothing else would notice if an edit made the cost cap
# shorter than the retention (it would delete good backups) or a lock longer than it (the job's own
# prune would be refused). The numbers: 30 daily periods and 12 monthly periods; the oldest object a
# prune removes is at least 30 days old (daily) and at least 334 days old (monthly: twelve months
# back, less up to one month of position inside the period).
r2_query() { # path sql (the document is :'doc')
  printf '%s\n' "$2" |
    "$PGBIN/psql" -X -q -At -h "$sock" -p "$port" -U postgres -d postgres -v doc="$(cat "$1")"
}
lifecycle_sql="select count(*) || ' ' || coalesce(bool_and(
    (r -> 'deleteObjectsTransition' -> 'condition' ->> 'maxAge')::bigint
      > case when r -> 'conditions' ->> 'prefix' like '%/daily/' then 30 * 86400 else 366 * 86400 end), false)
  from jsonb_array_elements(:'doc'::jsonb -> 'rules') r;"
assert_eq "r2: the lifecycle cap is longer than the retention on all four prefixes" \
  "4 true" "$(r2_query "$BK/r2/lifecycle.json" "$lifecycle_sql")"
lock_sql="select count(*) || ' ' || coalesce(bool_and(
    (r -> 'condition' ->> 'maxAgeSeconds')::bigint
      < case when r ->> 'prefix' like '%/daily/' then 30 * 86400 else 334 * 86400 end), false)
  from jsonb_array_elements(:'doc'::jsonb -> 'rules') r;"
assert_eq "r2: the bucket lock is shorter than the retention on all four prefixes" \
  "4 true" "$(r2_query "$BK/r2/bucket-lock.json" "$lock_sql")"
prefix_sql="select string_agg(p, ' ' order by p) from (
  select coalesce(r -> 'conditions' ->> 'prefix', r ->> 'prefix') as p
  from jsonb_array_elements(:'doc'::jsonb -> 'rules') r) s;"
prefixes="production/daily/ production/monthly/ staging/daily/ staging/monthly/"
assert_eq "r2: the lifecycle rules name the backup key layout" "$prefixes" "$(r2_query "$BK/r2/lifecycle.json" "$prefix_sql")"
assert_eq "r2: the lock rules name the backup key layout" "$prefixes" "$(r2_query "$BK/r2/bucket-lock.json" "$prefix_sql")"

# The checks above must be able to fail: a cap of one day and a lock of a year are both refused.
sed 's/"maxAge": 5184000/"maxAge": 86400/' "$BK/r2/lifecycle.json" >"$work/lifecycle-short.json"
assert_eq "r2: a cap shorter than the retention is caught" \
  "4 false" "$(r2_query "$work/lifecycle-short.json" "$lifecycle_sql")"
sed 's/"maxAgeSeconds": 2160000/"maxAgeSeconds": 31536000/' "$BK/r2/bucket-lock.json" >"$work/lock-long.json"
assert_eq "r2: a lock longer than the retention is caught" \
  "4 false" "$(r2_query "$work/lock-long.json" "$lock_sql")"

printf 'backup-tests\t%s passed, %s failed\n' "$passed" "$failed"
[ "$failed" -eq 0 ] && [ "$passed" -gt 0 ]
