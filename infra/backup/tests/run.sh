#!/usr/bin/env bash
# Tests for the logical backup scripts (ADR-171 to ADR-174).
#
#   PGBIN=/usr/lib/postgresql/18/bin AGE=age AGE_KEYGEN=age-keygen tests/run.sh [--out DIR]
#
# Pure functions (names, retention, recipients) are tested directly. The backup itself runs end to
# end against a throwaway PostgreSQL 18 cluster with the real repository migrations, a directory
# standing in for the R2 bucket (tests/fake-aws.sh) and a stand-in for `railway ssh`
# (tests/fake-railway.sh). Every failure path leaves an assertion that it left no archive without
# its metadata and no plaintext behind.
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
  "R2_ACCESS_KEY_ID=test-key" "R2_SECRET_ACCESS_KEY=test-secret" "R2_BUCKET_BACKUPS=$bucket"
  "BACKUP_ENVIRONMENT=staging" "BACKUP_SOURCE=url" "BACKUP_DB_HOST=$sock" "BACKUP_DB_PORT=$port"
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
  result=$(env -i "${args[@]}" "$BK/backup.sh" 2>&1)
  rc=$?
  printf '%s\n' "$result" >>"$out/backup-runs.log"
}
files() { (cd "$store" && find . -type f | sed 's|^\./||' | LC_ALL=C sort); }
reset_store() { rm -rf "$store"; mkdir -p "$store"; }

# --- not configured: skip loudly, never silently -----------------------------------------------------------------------------
reset_store
run_backup --without R2_SECRET_ACCESS_KEY --without R2_BUCKET_BACKUPS
assert_rc "unconfigured: exit 3" 3 "$rc"
assert_contains "unconfigured: names the missing variables" "R2_SECRET_ACCESS_KEY R2_BUCKET_BACKUPS" "$result"
assert_contains "unconfigured: names LAUNCH.md section C rows 6 and 8" "LAUNCH.md section C rows 6 and 8" "$result"
assert_contains "unconfigured: is a warning annotation" "::warning::" "$result"
assert_eq "unconfigured: nothing was stored" "" "$(files)"
run_backup --without BACKUP_AGE_RECIPIENTS
assert_rc "unconfigured: no recipients is exit 3 too" 3 "$rc"
assert_contains "unconfigured: names BACKUP_AGE_RECIPIENTS" "BACKUP_AGE_RECIPIENTS" "$result"

# --- the workflow gate: skip with a notice, never silently ---------------------------------------------------------------------------
gate_url=(
  "BACKUP_SOURCE=url" "BACKUP_ENVIRONMENT=production"
  "R2_ACCOUNT_ID=a" "R2_ACCESS_KEY_ID=b" "R2_SECRET_ACCESS_KEY=c" "R2_BUCKET_BACKUPS=d"
  "BACKUP_AGE_RECIPIENTS=$primary" "BACKUP_DB_NAME=n" "BACKUP_DB_PASSWORD=p" "BACKUP_DB_HOST=h"
)
gate_out=$(env -i PATH="$PATH" GITHUB_OUTPUT="$work/gate.out" "${gate_url[@]}" "$BK/gate.sh" 2>&1)
assert_rc "gate: a complete url configuration passes" 0 $?
assert_contains "gate: reports configured" "configured=true" "$gate_out"
assert_not_contains "gate: no warning when complete" "::warning::" "$gate_out"
gate_out=$(env -i PATH="$PATH" GITHUB_OUTPUT="$work/gate.out" BACKUP_SOURCE=railway-ssh BACKUP_ENVIRONMENT=production "$BK/gate.sh" 2>&1)
assert_rc "gate: nothing configured is not an error" 0 $?
assert_contains "gate: nothing configured is a warning" "::warning::backup of production skipped" "$gate_out"
assert_contains "gate: names section C rows 6 and 8" "LAUNCH.md section C rows 6 and 8" "$gate_out"
assert_contains "gate: names the R2 variables" "R2_ACCESS_KEY_ID" "$gate_out"
assert_contains "gate: names the Railway variables" "RAILWAY_API_TOKEN" "$gate_out"
assert_contains "gate: reports configured=false" "configured=false" "$gate_out"
assert_contains "gate: writes the step output" "configured=false" "$(cat "$work/gate.out")"
gate_out=$(env -i PATH="$PATH" "${gate_url[@]}" BACKUP_AGE_RECIPIENTS= "$BK/gate.sh" 2>&1)
assert_contains "gate: one missing input is enough to skip" "needs BACKUP_AGE_RECIPIENTS" "$gate_out"
gate_out=$(env -i PATH="$PATH" "${gate_url[@]}" BACKUP_SOURCE=nonsense "$BK/gate.sh" 2>&1)
assert_rc "gate: an unknown transport is an error" 1 $?

# --- the live restore drill: skip with a notice, never silently ------------------------------------------------------------------------
live_out=$(env -i PATH="$PATH" "$RD/live.sh" --environment staging --scratch "$work/live-scratch" 2>&1)
assert_rc "live drill: nothing configured is not an error" 0 $?
assert_contains "live drill: nothing configured is a warning" "::warning::live restore drill skipped" "$live_out"
assert_contains "live drill: names section C rows 6 and 8" "LAUNCH.md section C rows 6 and 8" "$live_out"
assert_contains "live drill: names the R2 variables" "R2_ACCESS_KEY_ID" "$live_out"
assert_contains "live drill: names the drill key" "BACKUP_DRILL_AGE_KEY" "$live_out"
live_out=$(env -i PATH="$PATH" R2_ACCOUNT_ID=0123456789abcdef0123456789abcdef R2_ACCESS_KEY_ID=x \
  R2_SECRET_ACCESS_KEY=y R2_BUCKET_BACKUPS=some-bucket "$RD/live.sh" --environment staging --scratch "$work/live-scratch" 2>&1)
assert_rc "live drill: only the drill key missing is still a skip" 0 $?
assert_contains "live drill: names only what is missing" "needs BACKUP_DRILL_AGE_KEY (LAUNCH" "$live_out"
assert_not_contains "live drill: does not name what is present" "R2_ACCESS_KEY_ID" "$live_out"
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
  "R2_ACCOUNT_ID=00000000000000000000000000000000" "R2_ACCESS_KEY_ID=test-key" "R2_SECRET_ACCESS_KEY=test-secret" "R2_BUCKET_BACKUPS=$bucket"
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
assert_contains "list-backups: names the variables and the row" "R2_ACCOUNT_ID" "$list_out"
assert_contains "list-backups: names LAUNCH.md section C row 6" "LAUNCH.md section C row 6" "$list_out"
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

# --- the railway-ssh transport ---------------------------------------------------------------------------------------------------------------------
reset_store
: >"$work/railway.log"
SSH_ENV=(
  "BACKUP_SOURCE=railway-ssh" "RAILWAY_BIN=$DIR/fake-railway.sh" "RAILWAY_API_TOKEN=tok-railway-secret"
  "BACKUP_RAILWAY_PROJECT_ID=proj-1" "BACKUP_RAILWAY_ENVIRONMENT=staging" "BACKUP_RAILWAY_SERVICE=postgres"
  "FAKE_RAILWAY_LOG=$work/railway.log"
)
run_backup "${SSH_ENV[@]}" BACKUP_DB_PASSWORD=zq9-marker-password
assert_rc "railway-ssh: succeeds" 0 "$rc"
assert_eq "railway-ssh: stores the same four objects" "4" "$(files | wc -l | tr -d ' ')"
railway_log=$(cat "$work/railway.log")
assert_contains "railway-ssh: targets the project" "project=proj-1" "$railway_log"
assert_contains "railway-ssh: targets the service" "service=postgres" "$railway_log"
assert_contains "railway-ssh: runs pg_dump remotely" "arg=pg_dump" "$railway_log"
assert_not_contains "railway-ssh: the database password is on no command line" "zq9-marker-password" "$railway_log"
assert_not_contains "railway-ssh: the database password is not in the output" "zq9-marker-password" "$result"
assert_not_contains "railway-ssh: the token is on no command line" "tok-railway-secret" "$railway_log"
run_backup "${SSH_ENV[@]}" --without RAILWAY_API_TOKEN
assert_rc "railway-ssh: needs the token" 1 "$rc"
assert_contains "railway-ssh: names the missing token" "RAILWAY_API_TOKEN" "$result"

# --- the metadata object is the commit marker ---------------------------------------------------------------------------------------------------------
reset_store
run_backup
find "$store" -name '*.meta.json' -delete
marker_out=$(env -i "${STD[@]}" PGHOST="$sock" PGPORT="$port" PGUSER=postgres "$RD/restore.sh" \
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
