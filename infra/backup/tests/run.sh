#!/usr/bin/env bash
# Tests for the logical backup scripts (ADR-171 to ADR-173, ADR-251 to ADR-257).
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
# shellcheck source=../lib/sign.sh
source "$BK/lib/sign.sh"
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
bucket=bk-tests-staging
store="$s3/$bucket"
mkdir -p "$store"

# The signing key pair of this run (infra/backup/signing/generate.sh makes the real ones).
openssl genpkey -algorithm ed25519 -outform DER -out "$work/sign.der" 2>/dev/null
openssl pkey -inform DER -in "$work/sign.der" -pubout -out "$work/sign.pub.pem" 2>/dev/null
SIGN_B64=$(base64 -w0 <"$work/sign.der")
openssl genpkey -algorithm ed25519 -out "$work/other-sign.pem" 2>/dev/null
openssl pkey -in "$work/other-sign.pem" -pubout -out "$work/other-sign.pub.pem" 2>/dev/null

STD=(
  "PATH=$PGBIN:$PATH" "LD_LIBRARY_PATH=${LD_LIBRARY_PATH:-}" "HOME=$work"
  "PGBIN=$PGBIN" "AGE_BIN=$AGE" "AWS_BIN=$DIR/fake-aws.sh" "FAKE_S3_ROOT=$s3"
  "R2_ACCOUNT_ID=00000000000000000000000000000000" "R2_ENDPOINT_URL=http://r2.invalid"
  "BACKUP_R2_ACCESS_KEY_ID=test-key" "BACKUP_R2_SECRET_ACCESS_KEY=test-secret" "R2_BUCKET_BACKUPS=$bucket"
  "BACKUP_ENVIRONMENT=staging" "BACKUP_DB_HOST=$sock" "BACKUP_DB_PORT=$port"
  "BACKUP_DB_USER=rampsmith_backup" "BACKUP_DB_NAME=rampsmith" "BACKUP_DB_PASSWORD=pw"
  "BACKUP_AGE_RECIPIENTS=$both" "BACKUP_SIGNING_KEY=$SIGN_B64" "BACKUP_NOW=20261019T010203Z"
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
run_backup --without BACKUP_SIGNING_KEY
assert_rc "unconfigured: no signing key is exit 3 too" 3 "$rc"
assert_contains "unconfigured: names BACKUP_SIGNING_KEY" "needs BACKUP_SIGNING_KEY (" "$result"
run_backup BACKUP_SIGNING_KEY=not-a-key
assert_rc "a malformed signing key is an error, not a skip" 1 "$rc"
assert_contains "... naming the variable" "BACKUP_SIGNING_KEY is not an Ed25519 private key" "$result"
assert_eq "... and nothing is stored" "" "$(files)"
run_backup BACKUP_SIGNING_KEY="$(openssl genpkey -algorithm x25519 -outform DER 2>/dev/null | base64 -w0)"
assert_rc "a key of another algorithm is refused" 1 "$rc"
run_backup --without BACKUP_DB_PASSWORD
assert_rc "unconfigured: no database password is exit 3 too" 3 "$rc"
assert_contains "unconfigured: names BACKUP_DB_PASSWORD" "BACKUP_DB_PASSWORD" "$result"
# shellcheck disable=SC2016  # the text is Railway's own reference syntax, not a shell expansion
run_backup 'BACKUP_R2_SECRET_ACCESS_KEY=${{shared.BACKUP_R2_SECRET_ACCESS_KEY}}'
assert_rc "unconfigured: a Railway reference nobody resolved counts as unset" 3 "$rc"
assert_contains "unconfigured: names the unresolved variable" "needs BACKUP_R2_SECRET_ACCESS_KEY (" "$result"
# The engine's token is not the backup's (ADR-252): with only the engine's names set, the service
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
  "R2_ACCOUNT_ID BACKUP_R2_ACCESS_KEY_ID BACKUP_R2_SECRET_ACCESS_KEY R2_BUCKET_BACKUPS BACKUP_AGE_RECIPIENTS BACKUP_SIGNING_KEY BACKUP_DB_PASSWORD" "$entry_out"

# --- the live restore drill: skip with a notice, never silently ------------------------------------------------------------------------
live_out=$(env -i PATH="$PATH" "$RD/live.sh" --environment staging --scratch "$work/live-scratch" 2>&1)
assert_rc "live drill: nothing configured is not an error" 0 $?
assert_contains "live drill: nothing configured is a warning" "::warning::live restore drill skipped" "$live_out"
assert_contains "live drill: names LAUNCH.md section C row 16" "LAUNCH.md section C row 16" "$live_out"
assert_contains "live drill: names the drill's R2 variables" "DRILL_R2_ACCESS_KEY_ID DRILL_R2_SECRET_ACCESS_KEY" "$live_out"
assert_contains "live drill: names the drill key" "BACKUP_DRILL_AGE_KEY" "$live_out"
assert_not_contains "live drill: does not ask for the backup service's token" "BACKUP_R2_" "$live_out"
assert_contains "live drill: names the public key to commit" "infra/backup/signing/staging.pub.pem (commit the public key)" "$live_out"
live_out=$(env -i PATH="$PATH" R2_ACCOUNT_ID=0123456789abcdef0123456789abcdef DRILL_R2_ACCESS_KEY_ID=x \
  DRILL_R2_SECRET_ACCESS_KEY=y R2_BUCKET_BACKUPS=rampsmith-backups-staging "$RD/live.sh" --environment staging \
  --verify-key "$work/sign.pub.pem" --scratch "$work/live-scratch" 2>&1)
assert_rc "live drill: only the drill key missing is still a skip" 0 $?
assert_contains "live drill: names only what is missing" "needs BACKUP_DRILL_AGE_KEY (LAUNCH" "$live_out"
assert_not_contains "live drill: does not name what is present" "DRILL_R2_ACCESS_KEY_ID" "$live_out"
# The backup service's token is no substitute for the drill's (ADR-252).
live_out=$(env -i PATH="$PATH" R2_ACCOUNT_ID=0123456789abcdef0123456789abcdef BACKUP_R2_ACCESS_KEY_ID=x \
  BACKUP_R2_SECRET_ACCESS_KEY=y R2_BUCKET_BACKUPS=rampsmith-backups-staging BACKUP_DRILL_AGE_KEY=k "$RD/live.sh" \
  --environment staging --verify-key "$work/sign.pub.pem" --scratch "$work/live-scratch" 2>&1)
assert_rc "live drill: the backup service's token alone is a skip" 0 $?
assert_contains "live drill: ... that names the drill's token" "DRILL_R2_ACCESS_KEY_ID" "$live_out"
# Both tokens in one environment is a configuration error, not a skip.
live_out=$(env -i PATH="$PATH" R2_ACCOUNT_ID=0123456789abcdef0123456789abcdef DRILL_R2_ACCESS_KEY_ID=x \
  DRILL_R2_SECRET_ACCESS_KEY=y R2_BUCKET_BACKUPS=rampsmith-backups-staging BACKUP_DRILL_AGE_KEY=k BACKUP_R2_SECRET_ACCESS_KEY=write-marker \
  "$RD/live.sh" --environment staging --verify-key "$work/sign.pub.pem" --scratch "$work/live-scratch" 2>&1)
assert_rc "live drill: the write token in the drill's environment is refused" 1 $?
assert_contains "live drill: ... naming the variable" "BACKUP_R2_SECRET_ACCESS_KEY is set" "$live_out"
assert_not_contains "live drill: ... without printing it" "write-marker" "$live_out"
live_out=$(env -i PATH="$PATH" "$RD/live.sh" --environment 'Bad Env' 2>&1)
assert_rc "live drill: a bad environment name is an error" 1 $?
# The drill reads staging's bucket only, and restores staging only (ADR-252, ADR-253).
live_env=(PATH="$PATH" R2_ACCOUNT_ID=0123456789abcdef0123456789abcdef DRILL_R2_ACCESS_KEY_ID=x DRILL_R2_SECRET_ACCESS_KEY=y BACKUP_DRILL_AGE_KEY=k)
live_out=$(env -i "${live_env[@]}" R2_BUCKET_BACKUPS=rampsmith-backups-production "$RD/live.sh" --environment staging \
  --verify-key "$work/sign.pub.pem" --scratch "$work/live-scratch" 2>&1)
assert_rc "live drill: production's bucket in the drill's environment is refused" 1 $?
assert_contains "live drill: ... naming the rule" "is not the staging bucket" "$live_out"
live_out=$(env -i "${live_env[@]}" R2_BUCKET_BACKUPS=rampsmith-backups-production "$RD/live.sh" --environment production \
  --verify-key "$work/sign.pub.pem" --scratch "$work/live-scratch" 2>&1)
assert_rc "live drill: it restores staging only" 1 $?
assert_contains "live drill: ... and says so" "staging backups only" "$live_out"

# --- the happy path --------------------------------------------------------------------------------------------------------------------
reset_store
run_backup
assert_rc "backup: succeeds" 0 "$rc"
assert_eq "backup: stores a daily and a monthly archive, metadata object and signature" \
  "staging/daily/2026-10-19/rampsmith-staging-20261019T010203Z.dump.age
staging/daily/2026-10-19/rampsmith-staging-20261019T010203Z.meta.json
staging/daily/2026-10-19/rampsmith-staging-20261019T010203Z.meta.json.sig
staging/monthly/2026-10/rampsmith-staging-20261019T010203Z.dump.age
staging/monthly/2026-10/rampsmith-staging-20261019T010203Z.meta.json
staging/monthly/2026-10/rampsmith-staging-20261019T010203Z.meta.json.sig" "$(files)"

# list-backups.sh, which the restore runbook uses to pick the object: complete and unfinished
# archives, newest first, and a loud failure when the token variables are missing.
mkdir -p "$store/staging/daily/2026-10-18"
: >"$store/staging/daily/2026-10-18/rampsmith-staging-20261018T010203Z.dump.age"
list_env=(
  "PATH=$PATH" "AWS_BIN=$DIR/fake-aws.sh" "FAKE_S3_ROOT=$s3" "R2_ENDPOINT_URL=http://r2.invalid"
  "R2_ACCOUNT_ID=00000000000000000000000000000000" "DRILL_R2_ACCESS_KEY_ID=drill-read-key"
  "DRILL_R2_SECRET_ACCESS_KEY=drill-read-secret" "R2_BUCKET_BACKUPS=$bucket"
)
list_out=$(env -i "${list_env[@]}" "$RD/list-backups.sh" --verify-key "$work/sign.pub.pem" --environment staging 2>&1)
assert_rc "list-backups: lists a configured bucket" 0 $?
assert_eq "list-backups: newest first, unfinished uploads marked, monthly after daily" \
  "daily	staging/daily/2026-10-19/rampsmith-staging-20261019T010203Z.dump.age	complete
daily	staging/daily/2026-10-18/rampsmith-staging-20261018T010203Z.dump.age	incomplete
monthly	staging/monthly/2026-10/rampsmith-staging-20261019T010203Z.dump.age	complete" "$list_out"
list_out=$(env -i "${list_env[@]}" "$RD/list-backups.sh" --verify-key "$work/sign.pub.pem" --environment staging --kind monthly 2>&1)
assert_eq "list-backups: --kind monthly lists only the monthly archive" \
  "monthly	staging/monthly/2026-10/rampsmith-staging-20261019T010203Z.dump.age	complete" "$list_out"
list_out=$(env -i "${list_env[@]}" R2_BUCKET_BACKUPS=bk-tests-production "$RD/list-backups.sh" --verify-key "$work/sign.pub.pem" --environment production 2>&1)
assert_rc "list-backups: an environment with no backups is not an error" 0 $?
assert_contains "list-backups: says there is nothing" "no backups under production/" "$list_out"
assert_not_contains "list-backups: never lists another environment's keys" "staging/" "$list_out"
list_out=$(env -i "${list_env[@]}" "$RD/list-backups.sh" --verify-key "$work/sign.pub.pem" --environment production 2>&1)
assert_rc "list-backups: another environment's bucket is refused" 1 $?
assert_contains "list-backups: ... naming the rule" "is not the production bucket" "$list_out"
list_out=$(env -i PATH="$PATH" "$RD/list-backups.sh" --verify-key "$work/sign.pub.pem" --environment staging 2>&1)
assert_rc "list-backups: missing variables fail" 1 $?
assert_contains "list-backups: names the variables and the row" "DRILL_R2_ACCESS_KEY_ID" "$list_out"
assert_contains "list-backups: names LAUNCH.md section C row 16" "LAUNCH.md section C row 16" "$list_out"
list_out=$(env -i PATH="$PATH" AWS_BIN="$DIR/fake-aws.sh" FAKE_S3_ROOT="$s3" R2_ENDPOINT_URL=http://r2.invalid \
  R2_ACCOUNT_ID=00000000000000000000000000000000 R2_BUCKET_BACKUPS="$bucket" \
  BACKUP_R2_ACCESS_KEY_ID=test-key BACKUP_R2_SECRET_ACCESS_KEY=test-secret "$RD/list-backups.sh" --verify-key "$work/sign.pub.pem" --environment staging 2>&1)
assert_rc "list-backups: the backup service's write token is not accepted in its place" 1 $?
assert_contains "list-backups: ... and the drill's variables are named" "DRILL_R2_SECRET_ACCESS_KEY" "$list_out"
list_out=$(env -i "${list_env[@]}" "$RD/list-backups.sh" --verify-key "$work/sign.pub.pem" --environment '../x' 2>&1)
assert_rc "list-backups: a bad environment name fails" 1 $?
list_out=$(env -i "${list_env[@]}" "$RD/list-backups.sh" --verify-key "$work/sign.pub.pem" --environment staging --kind weekly 2>&1)
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
assert_eq "same day: two daily sets in one period, one monthly set" "9" "$(files | wc -l | tr -d ' ')"
run_backup BACKUP_NOW=20261020T010203Z
assert_contains "next day: the monthly copy already exists" "monthly backup for 2026-10 already exists" "$result"
assert_eq "next day: a new daily period only" "12" "$(files | wc -l | tr -d ' ')"
run_backup BACKUP_NOW=20261101T010203Z
assert_eq "next month: a new monthly period" "1" "$(files | grep -c 'monthly/2026-11/.*meta.json$' || true)"

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
assert_eq "retention: 30 daily periods remain" "30" "$(files | grep -c 'daily/.*meta.json$' || true)"
assert_eq "retention: the new backup is among them" "1" "$(files | grep -c 'daily/2026-10-01/.*meta.json$' || true)"

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
assert_eq "retention: the new backup is stored anyway" "1" "$(files | grep -c 'daily/2026-12-01/.*meta.json$' || true)"
assert_eq "retention: nothing was deleted" "31" "$(files | grep -c 'daily/.*meta.json$' || true)"

for bad in 0 abc -1 '5;rm' 05; do
  reset_store
  run_backup "BACKUP_PRUNE_MAX=$bad"
  assert_rc "BACKUP_PRUNE_MAX='$bad' is refused" 1 "$rc"
  assert_contains "BACKUP_PRUNE_MAX='$bad' says why" "must be a positive integer" "$result"
  assert_eq "BACKUP_PRUNE_MAX='$bad' stores nothing" "" "$(files)"
done
run_backup BACKUP_KEEP_DAILY=0
assert_rc "BACKUP_KEEP_DAILY=0 is refused" 1 "$rc"

# --- failures leave no archive without its metadata ---------------------------------------------------------------------------------------
expect_failure() { # name expected-message
  assert_rc "$1: exit 1" 1 "$rc"
  assert_contains "$1: says why" "$2" "$result"
  assert_eq "$1: stores no metadata object" "0" "$(files | grep -c 'meta.json$' || true)"
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
assert_eq "prune failure: the new backup is stored" "1" "$(files | grep -c 'daily/2026-10-19/.*meta.json$' || true)"

# --- a failed backup is a failed run, and a success stays a success, through the entrypoint ----------------------------------------------
BK_COMMAND="$BK/entrypoint.sh"
reset_store
run_backup
assert_rc "entrypoint: a configured backup exits 0" 0 "$rc"
assert_eq "entrypoint: ... and stores the six objects" "6" "$(files | wc -l | tr -d ' ')"
reset_store
run_backup BACKUP_DB_USER=rampsmith_api
assert_rc "entrypoint: a failed backup exits 1, so Railway shows a failed run" 1 "$rc"
assert_contains "entrypoint: ... and says why" "could not read the migration version" "$result"
reset_store
run_backup --without BACKUP_AGE_RECIPIENTS
assert_rc "entrypoint: an unconfigured backup exits 0" 0 "$rc"
assert_eq "entrypoint: ... and stores nothing" "" "$(files)"
unset BK_COMMAND

# --- the three R2 tokens each reach only what they are for (ADR-252, finding M1) -------------------------------------------------------
# The fake bucket answers 403 AccessDenied to a token that does not cover the bucket and to a read
# only token that writes, as R2 documents (error code 10003).
reset_store
SCOPE=(FAKE_AWS_WRITE_KEY=backup-write-key FAKE_AWS_READ_KEY=drill-read-key)
run_backup "${SCOPE[@]}" BACKUP_R2_ACCESS_KEY_ID=backup-write-key R2_ACCESS_KEY_ID=engine-evidence-key \
  R2_SECRET_ACCESS_KEY=engine-secret-marker
assert_rc "tokens: the backup uses its own token, with the engine's names set beside it" 0 "$rc"
assert_eq "tokens: ... and stores its six objects" "6" "$(files | wc -l | tr -d ' ')"
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
list_out=$(env -i "${drill_env[@]}" "$RD/list-backups.sh" --verify-key "$work/sign.pub.pem" --environment staging --kind daily 2>&1)
assert_rc "tokens: the drill's read-only token lists the backups" 0 $?
assert_contains "tokens: ... and sees the archive" "staging/daily/2026-10-19/rampsmith-staging-20261019T010203Z.dump.age" "$list_out"
env -i "${drill_env[@]}" bash -c 'source "$1"; source "$2"; s3_init DRILL_R2; s3_delete "$3"' _ \
  "$BK/lib/common.sh" "$BK/lib/s3.sh" "staging/daily/2026-10-19/rampsmith-staging-20261019T010203Z.meta.json" >/dev/null 2>&1
assert_rc "tokens: the drill's read-only token cannot delete a backup" 1 $?
assert_eq "tokens: ... and the metadata object is still there" "1" \
  "$(files | grep -c 'daily/.*meta.json$' || true)"
env -i "${drill_env[@]}" DRILL_R2_ACCESS_KEY_ID=engine-evidence-key bash -c \
  'source "$1"; source "$2"; s3_init DRILL_R2; s3_size "$3"' _ "$BK/lib/common.sh" "$BK/lib/s3.sh" \
  "staging/daily/2026-10-19/rampsmith-staging-20261019T010203Z.dump.age" >/dev/null 2>&1
assert_rc "tokens: the evidence token cannot read the backups bucket either" 1 $?

# --- the live drill hands its inputs to a container that runs as another user (finding M3, ADR-255) -----------------------------------------
# live.sh runs under umask 077; the restore runs as the postgres image's user (uid 999), not the
# runner's. The stand-in for in-container.sh checks the permission bits any other user is held to,
# that the private key arrives in the environment and is on no disk under the scratch directory,
# and that the archive then decrypts. The newest backup in the store is the one the last run wrote.
handoff_env=(
  "PATH=$PGBIN:$PATH" "LD_LIBRARY_PATH=${LD_LIBRARY_PATH:-}" "HOME=$work" "PGBIN=$PGBIN"
  "AWS_BIN=$DIR/fake-aws.sh" "FAKE_S3_ROOT=$s3" "R2_ENDPOINT_URL=http://r2.invalid"
  "R2_ACCOUNT_ID=00000000000000000000000000000000" "R2_BUCKET_BACKUPS=$bucket"
  "DRILL_R2_ACCESS_KEY_ID=drill-read-key" "DRILL_R2_SECRET_ACCESS_KEY=drill-read-secret"
  "BACKUP_DRILL_AGE_KEY=$(cat "$work/primary.key")" "AGE=$AGE" "AGE_KEYGEN=$AGE_KEYGEN"
  "RD_CONTAINER_TMP=$work/handoff-container-tmp" "DRILL_PORT_BASE=54950"
  "RD_IN_CONTAINER=$RD/tests/fake-in-container.sh" "${SCOPE[@]}"
)
handoff_out=$(env -i "${handoff_env[@]}" "$RD/live.sh" --environment staging --verify-key "$work/sign.pub.pem" \
  --scratch "$work/handoff" --max-age-hours 1000000 2>&1)
assert_rc "handoff: the live drill completes against the fake bucket, restoring for real" 0 $?
assert_contains "handoff: other users can open the archive" "PASS	read: other users can open $work/handoff/work/backup.dump.age" "$handoff_out"
assert_contains "handoff: other users can open the metadata" "PASS	read: other users can open $work/handoff/work/backup.meta.json" "$handoff_out"
assert_contains "handoff: other users can write the outputs" "PASS	write: other users can create files in out/" "$handoff_out"
assert_contains "handoff: the key arrives in the environment" "PASS	key: passed in the environment" "$handoff_out"
assert_contains "handoff: the key is on no disk" "PASS	key: no private key on disk under the scratch directory" "$handoff_out"
assert_contains "handoff: the archive decrypts with it" "PASS	decrypt: the archive opens to a PostgreSQL archive" "$handoff_out"
assert_contains "handoff: the restore ran and verified" "restore-local	PASS" "$handoff_out"
assert_contains "handoff: the backup was verified by signature" "signature verified" "$handoff_out"
assert_eq "handoff: work is world-readable" "755" "$(stat -c %a "$work/handoff/work")"
assert_eq "handoff: out is world-writable" "777" "$(stat -c %a "$work/handoff/out")"
assert_eq "handoff: the scratch directory can be entered by others" "755" "$(stat -c %a "$work/handoff")"
assert_eq "handoff: the archive is world-readable" "644" "$(stat -c %a "$work/handoff/work/backup.dump.age")"
assert_eq "handoff: no private key was written anywhere in the scratch tree" "0" \
  "$(grep -rIlF 'AGE-SECRET-KEY-' "$work/handoff" | wc -l | tr -d ' ')"
assert_not_contains "handoff: the key is not in the output" "AGE-SECRET-KEY-" "$handoff_out"

# HIGH-1: the restored cluster is customer data and the repository is public. After a live run
# nothing the workflow collects or uploads may hold it, and the container's own copy is gone.
leaks=$(find "$work/handoff" \( -name PG_VERSION -o -name toc.txt -o -name restore.dump -o -name 'dst' -o -name pg_wal \) | head -n 5)
assert_eq "live run: no PostgreSQL data directory, table of contents or decrypted dump in the scratch tree" "" "$leaks"
assert_eq "live run: no tenant identifier in out/ or report/" "0" \
  "$(grep -rIlE 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa|bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' "$work/handoff/out" "$work/handoff/report" | wc -l | tr -d ' ')"
assert_not_contains "live run: no tenant identifier in the job log" "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" "$handoff_out"
assert_eq "live run: the container's restore directory was deleted" "absent" \
  "$([ -e "$work/handoff-container-tmp/rd-restore" ] && echo present || echo absent)"
assert_eq "live run: the container's key file was deleted" "absent" \
  "$([ -e "$work/handoff-container-tmp/rd-identity.key" ] && echo present || echo absent)"
assert_eq "live run: the only file for upload is the summary" "summary.txt" "$(ls "$work/handoff/report")"
summary=$(cat "$work/handoff/report/summary.txt")
assert_contains "live run: the summary says PASS" "result: PASS" "$summary"
assert_contains "live run: ... with the backup's date" "backup_date_utc: 2026-10-19" "$summary"
assert_eq "live run: ... and only fixed fields" "result environment backup_date_utc backup_age_hours fetch_ms restore_and_verification_ms total_ms rto_target_ms checks_passed checks_failed" \
  "$(sed 's/:.*//' "$work/handoff/report/summary.txt" | tr '\n' ' ' | sed 's/ $//')"
assert_eq "live run: the summary holds nothing but names, numbers and one date" "0" \
  "$(sed 's/^[a-z_]*: //' "$work/handoff/report/summary.txt" | grep -cvE '^(PASS|FAIL|staging|[0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]+)$' || true)"

# The check must be able to fail: restoring with --work beside --out and no --discard-work leaves the
# cluster where a careless job would upload it, and the find above sees it; --work inside --out is refused.
leak_out=$(env -i "${handoff_env[@]}" "$RD/restore-local.sh" --file "$work/handoff/work/backup.dump.age" \
  --identity "$work/primary.key" --out "$work/leaky/out" --work "$work/leaky/out/restore" 2>&1)
assert_rc "restore-local: --work inside --out is refused" 1 $?
assert_contains "restore-local: ... saying why" "is inside --out" "$leak_out"
leak_out=$(env -i "${handoff_env[@]}" "$RD/restore-local.sh" --file "$work/handoff/work/backup.dump.age" \
  --identity "$work/primary.key" --out "$work/leaky" --work "$work/leaky" 2>&1)
assert_rc "restore-local: --work and --out the same directory is refused" 1 $?
env -i "${handoff_env[@]}" "$RD/restore-local.sh" --file "$work/handoff/work/backup.dump.age" \
  --identity "$work/primary.key" --out "$work/kept/out" --work "$work/kept/work" >/dev/null 2>&1
assert_eq "restore-local: without --discard-work the cluster stays in --work (what the live run avoids)" "found" \
  "$([ "$(find "$work/kept/work" -name PG_VERSION | wc -l | tr -d ' ')" -gt 0 ] && echo found || echo none)"
assert_eq "restore-local: ... and none of it is in --out" "" "$(find "$work/kept/out" \( -name PG_VERSION -o -name toc.txt -o -name restore.dump \))"
env -i "${handoff_env[@]}" "$RD/restore-local.sh" --file "$work/handoff/work/backup.dump.age" \
  --identity "$work/primary.key" --out "$work/dropped/out" --work "$work/dropped/work" --discard-work >/dev/null 2>&1
assert_rc "restore-local: --discard-work restores" 0 $?
assert_eq "restore-local: ... and leaves no work directory" "absent" "$([ -e "$work/dropped/work" ] && echo present || echo absent)"

# A tampered bucket: the drill must not restore what the backup service did not sign.
newest=$(cd "$store" && find staging/daily -name '*.dump.age' | LC_ALL=C sort | tail -n 1)
cp "$store/$newest" "$work/newest.dump.age.orig"
printf 'X' | dd of="$store/$newest" bs=1 seek=300 conv=notrunc 2>/dev/null
bad_out=$(env -i "${handoff_env[@]}" "$RD/live.sh" --environment staging --verify-key "$work/sign.pub.pem" \
  --scratch "$work/handoff-bad" --max-age-hours 1000000 2>&1)
assert_rc "live drill: an altered archive is not restored" 1 $?
assert_contains "live drill: ... because it is not the signed one" "differs from the signed one" "$bad_out"
cp "$work/newest.dump.age.orig" "$store/$newest"
bad_out=$(env -i "${handoff_env[@]}" "$RD/live.sh" --environment staging --verify-key "$work/other-sign.pub.pem" \
  --scratch "$work/handoff-bad" --max-age-hours 1000000 2>&1)
assert_rc "live drill: a backup signed by another key is not restored" 1 $?
assert_contains "live drill: ... because the signature does not verify" "signature does not verify" "$bad_out"
assert_eq "live drill: ... and no cluster was started" "absent" "$([ -e "$work/handoff-container-tmp/rd-restore" ] && echo present || echo absent)"

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

# What reaches the public log: identifiers and database messages are removed (ADR-255).
scrubbed=$(printf '%s\n' \
  'FAIL	rls	tenants: tenant aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa sees 3 rows' \
  'ERROR: pg_restore failed: COPY findings, line 3: "secret-customer-value"' \
  'DETAIL:  Failing row contains (secret-customer-value, 1).' \
  'PASS	manifest	all 173 entries exist' | rd_scrub)
assert_contains "scrub: a tenant identifier becomes <id>" "tenant <id> sees 3 rows" "$scrubbed"
assert_not_contains "scrub: ... and is gone" "aaaaaaaa-aaaa" "$scrubbed"
assert_not_contains "scrub: a database message that quotes data is withheld" "secret-customer-value" "$scrubbed"
assert_contains "scrub: ... with a notice" "a database message was withheld" "$scrubbed"
assert_contains "scrub: a result line of the drill itself is kept" "PASS	manifest	all 173 entries exist" "$scrubbed"

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
mkdir -p "$cr_dir/discard/data" "$cr_dir/scratch/keep"
printf 'cluster\n' >"$cr_dir/discard/data/PG_VERSION"
chmod 500 "$cr_dir/discard/data"
env -i PATH="$PATH" RD_IDENTITY_FILE="$cr_dir/none.key" RD_SCRATCH_DIR="$cr_dir/scratch" RD_DISCARD_DIRS="$cr_dir/discard /" \
  "$RD/container-run.sh" true
assert_eq "container-run: RD_DISCARD_DIRS deletes the restored cluster even when it is read-only" "absent" \
  "$([ -e "$cr_dir/discard" ] && echo present || echo absent)"
env -i PATH="$PATH" RD_IDENTITY_FILE="$cr_dir/none.key" RD_SCRATCH_DIR="$cr_dir/scratch" RD_DISCARD_DIRS="$cr_dir/scratch/keep" \
  "$RD/container-run.sh" true
assert_eq "container-run: ... but never a directory under the scratch directory it reports from" "present" \
  "$([ -e "$cr_dir/scratch/keep" ] && echo present || echo absent)"

# --- the metadata object is the commit marker ---------------------------------------------------------------------------------------------------------
reset_store
run_backup
find "$store" -name '*.meta.json' -delete
marker_out=$(env -i "${STD[@]}" DRILL_R2_ACCESS_KEY_ID=drill-read-key DRILL_R2_SECRET_ACCESS_KEY=drill-read-secret PGHOST="$sock" PGPORT="$port" PGUSER=postgres "$RD/restore.sh" \
  --target rampsmith --identity "$work/primary.key" --work "$work/restore-marker" --verify-key "$work/sign.pub.pem" \
  --object staging/daily/2026-10-19/rampsmith-staging-20261019T010203Z.dump.age 2>&1)
assert_rc "restore refuses an archive without metadata: exit 1" 1 $?
assert_contains "restore refuses an archive without metadata: says why" "the upload never finished" "$marker_out"

# --- the bucket is not trusted: time, order and signature (finding M2, ADR-256) -------------------------------------------------------------
now_epoch=$(date -u +%s)
limit_now=$(bk_future_limit "$now_epoch")
assert_eq "time: a stamp parses to its epoch second" "1792371723" "$(bk_stamp_epoch 20261019T010203Z)"
(bk_stamp_epoch 20261340T010203Z) >/dev/null 2>&1
assert_rc "time: an impossible date is not a time" 1 $?
(bk_stamp_epoch 20261019T250203Z) >/dev/null 2>&1
assert_rc "time: an impossible hour is not a time" 1 $?
assert_eq "time: the limit is now plus ten minutes" "$(bk_epoch_stamp $((now_epoch + 600)))" "$limit_now"

daily_key() { # stamp [dir-date] -> three keys of a complete signed backup in env "tst"
  local stamp=$1 day=${2:-${1:0:4}-${1:4:2}-${1:6:2}}
  printf 'tst/daily/%s/rampsmith-tst-%s.%s\n' "$day" "$stamp" dump.age "$day" "$stamp" meta.json "$day" "$stamp" meta.json.sig
}
daily_set() { # stamp [dir-date]
  local stamp=$1 day=${2:-${1:0:4}-${1:4:2}-${1:6:2}} ext
  for ext in dump.age meta.json meta.json.sig; do printf 'tst/daily/%s/rampsmith-tst-%s.%s\n' "$day" "$stamp" "$ext"; done
}
future_stamp=$(bk_epoch_stamp $((now_epoch + 86400)))
listing=$({
  daily_set 20260101T010000Z
  daily_set 20260301T010000Z
  daily_set 20260201T010000Z
  daily_set "$future_stamp"
  daily_set 20260401T010000Z 2026-04-02
  printf 'tst/daily/2026-03-02/rampsmith-tst-20260302T010000Z.dump.age\n'
  printf 'tst/daily/2026-03-03/rampsmith-tst-20260303T010000Z.dump.age\ntst/daily/2026-03-03/rampsmith-tst-20260303T010000Z.meta.json\n'
  printf 'tst/daily/2026-12-31/zzz-not-ours.dump.age\nother/daily/2026-05-01/rampsmith-other-20260501T010000Z.dump.age\n'
})
assert_eq "order: by the parsed timestamp, newest first; the future, misfiled and unfinished are marked" \
  "${future_stamp}	tst/daily/${future_stamp:0:4}-${future_stamp:4:2}-${future_stamp:6:2}/rampsmith-tst-${future_stamp}.dump.age	future
20260401T010000Z	tst/daily/2026-04-02/rampsmith-tst-20260401T010000Z.dump.age	misfiled
20260303T010000Z	tst/daily/2026-03-03/rampsmith-tst-20260303T010000Z.dump.age	incomplete
20260302T010000Z	tst/daily/2026-03-02/rampsmith-tst-20260302T010000Z.dump.age	incomplete
20260301T010000Z	tst/daily/2026-03-01/rampsmith-tst-20260301T010000Z.dump.age	complete
20260201T010000Z	tst/daily/2026-02-01/rampsmith-tst-20260201T010000Z.dump.age	complete
20260101T010000Z	tst/daily/2026-01-01/rampsmith-tst-20260101T010000Z.dump.age	complete" \
  "$(printf '%s\n' "$listing" | bk_backups tst daily "$limit_now")"
assert_eq "newest: the newest complete backup, not the newest text, not the future, not a misfiled one" \
  "tst/daily/2026-03-01/rampsmith-tst-20260301T010000Z.dump.age" \
  "$(printf '%s\n' "$listing" | bk_newest_complete tst daily "$limit_now")"
assert_eq "newest: a backup without a signature is not complete" "" \
  "$(printf 'tst/daily/2026-03-03/rampsmith-tst-20260303T010000Z.dump.age\ntst/daily/2026-03-03/rampsmith-tst-20260303T010000Z.meta.json\n' | bk_newest_complete tst daily "$limit_now")"
assert_eq "newest: an empty bucket has none" "" "$(printf '' | bk_newest_complete tst daily "$limit_now")"
# A key one dated just inside the clock skew is believed, one just beyond it is not.
inside=$(bk_epoch_stamp $((now_epoch + 300)))
assert_contains "time: five minutes ahead is clock skew, believed" "complete" \
  "$(daily_set "$inside" | bk_backups tst daily "$limit_now")"
beyond=$(bk_epoch_stamp $((now_epoch + 1200)))
assert_contains "time: twenty minutes ahead is not" "future" "$(daily_set "$beyond" | bk_backups tst daily "$limit_now")"
# Retention: a future-dated set neither counts towards the periods kept nor is deleted.
victims=$({ daily_keys 1 30; daily_set 20261201T010000Z; } | bk_retention_victims tst daily 30 20261101T000000Z)
assert_eq "retention: an object from the future does not push a real backup out" "" "$victims"
victims=$({ daily_keys 1 30; daily_set 20261201T010000Z; } | bk_retention_victims tst daily 30)
assert_eq "retention: (without the limit it would have: the 31st period)" \
  "tst/daily/2026-10-01/rampsmith-tst-20261001T010000Z.dump.age
tst/daily/2026-10-01/rampsmith-tst-20261001T010000Z.meta.json" "$victims"
victims=$({ daily_keys 2 31; daily_set 20261001T010000Z; } | bk_retention_victims tst daily 30)
assert_eq "retention: an old signature is swept with its backup" \
  "tst/daily/2026-10-01/rampsmith-tst-20261001T010000Z.dump.age
tst/daily/2026-10-01/rampsmith-tst-20261001T010000Z.meta.json
tst/daily/2026-10-01/rampsmith-tst-20261001T010000Z.meta.json.sig" "$victims"
bk_bucket_matches_environment rampsmith-backups-production production
assert_rc "bucket: the production bucket for production" 0 $?
bk_bucket_matches_environment rampsmith-backups-production staging
assert_rc "bucket: ... not for staging" 1 $?
bk_bucket_matches_environment rampsmith-backups staging
assert_rc "bucket: one shared bucket matches no environment" 1 $?
bk_bucket_matches_environment "" ""
assert_rc "bucket: empty is refused" 1 $?

# The signature: made by backup.sh, checked with the public key.
reset_store
run_backup
b_meta="$store/staging/daily/2026-10-19/rampsmith-staging-20261019T010203Z.meta.json"
b_sig="$b_meta.sig"
b_key=staging/daily/2026-10-19/rampsmith-staging-20261019T010203Z.dump.age
b_archive="$store/$b_key"
t_ok=$(bk_stamp_epoch 20261020T000000Z)
reason=$(bk_verify_backup staging "$b_key" "$b_meta" "$b_sig" "$work/sign.pub.pem" "$t_ok" "$b_archive")
assert_rc "verify: the backup service's metadata verifies" 0 $?
assert_contains "verify: ... and reports the signed time and schema" "20261019T010203Z $(rd_repo_newest_migration)" "$reason"
reason=$(bk_verify_backup staging "$b_key" "$b_meta" "$b_sig" "$work/other-sign.pub.pem" "$t_ok" "$b_archive")
assert_rc "verify: another key's signature does not verify" 1 $?
assert_contains "verify: ... and says so" "signature does not verify" "$reason"
sed 's/"size_bytes": [0-9]*/"size_bytes": 7/' "$b_meta" >"$work/meta.tampered"
reason=$(bk_verify_backup staging "$b_key" "$work/meta.tampered" "$b_sig" "$work/sign.pub.pem" "$t_ok" "$b_archive")
assert_rc "verify: metadata changed after signing is refused" 1 $?
reason=$(bk_verify_backup production "$b_key" "$b_meta" "$b_sig" "$work/sign.pub.pem" "$t_ok" "$b_archive")
assert_rc "verify: staging's metadata is not production's" 1 $?
assert_contains "verify: ... because of the environment" 'signed for environment "staging"' "$reason"
reason=$(bk_verify_backup staging "staging/daily/2026-10-18/rampsmith-staging-20261018T010203Z.dump.age" "$b_meta" "$b_sig" "$work/sign.pub.pem" "$t_ok" "$b_archive")
assert_rc "verify: a valid pair moved to another key name is refused" 1 $?
assert_contains "verify: ... because it is signed for another archive" "signed for the archive" "$reason"
reason=$(bk_verify_backup staging "$b_key" "$b_meta" "$b_sig" "$work/sign.pub.pem" "$(bk_stamp_epoch 20261018T000000Z)" "$b_archive")
assert_rc "verify: a backup dated after the clock is refused" 1 $?
assert_contains "verify: ... as in the future" "in the future" "$reason"
cp "$b_archive" "$work/archive.copy"
printf 'X' | dd of="$work/archive.copy" bs=1 seek=300 conv=notrunc 2>/dev/null
reason=$(bk_verify_backup staging "$b_key" "$b_meta" "$b_sig" "$work/sign.pub.pem" "$t_ok" "$work/archive.copy")
assert_rc "verify: an archive other than the signed one is refused" 1 $?
assert_contains "verify: ... by its sha256" "differs from the signed one" "$reason"
head -c 200 "$b_archive" >"$work/archive.short"
reason=$(bk_verify_backup staging "$b_key" "$b_meta" "$b_sig" "$work/sign.pub.pem" "$t_ok" "$work/archive.short")
assert_contains "verify: a truncated archive is refused by its size" "archive size differs" "$reason"
: >"$work/empty.sig"
reason=$(bk_verify_backup staging "$b_key" "$b_meta" "$work/empty.sig" "$work/sign.pub.pem" "$t_ok" "$b_archive")
assert_rc "verify: a missing signature is refused" 1 $?
reason=$(bk_verify_backup staging "$b_key" "$b_meta" "$b_sig" "$work/does-not-exist.pem" "$t_ok" "$b_archive")
assert_rc "verify: a missing public key is refused" 1 $?

# A bucket writer who has no signing key cannot make a believed backup, even with a newer date,
# and a future one is flagged; the listing and the restore both say so.
forge() { # stamp -> a backup under the staging prefix, signed by the key given in FORGER_KEY (a pem)
  local stamp=$1 day base
  day="${stamp:0:4}-${stamp:4:2}-${stamp:6:2}"
  base="staging/daily/$day/rampsmith-staging-$stamp"
  mkdir -p "$store/staging/daily/$day"
  cp "$b_archive" "$store/$base.dump.age"
  sed -e "s/20261019T010203Z/$stamp/g" -e "s/2026-10-19T01:02:03Z/${stamp:0:4}-${stamp:4:2}-${stamp:6:2}T${stamp:9:2}:${stamp:11:2}:${stamp:13:2}Z/" \
    -e "s#staging/daily/2026-10-19#staging/daily/$day#" "$b_meta" >"$store/$base.meta.json"
  openssl pkeyutl -sign -inkey "$FORGER_KEY" -rawin -in "$store/$base.meta.json" -out "$work/forged.raw" 2>/dev/null
  base64 -w0 <"$work/forged.raw" >"$store/$base.meta.json.sig"
}
FORGER_KEY="$work/other-sign.pem" forge 20261020T010203Z
FORGER_KEY="$work/other-sign.pem" forge "$future_stamp"
list_out=$(env -i "${drill_env[@]}" "$RD/list-backups.sh" --verify-key "$work/sign.pub.pem" --environment staging --kind daily 2>&1)
assert_contains "forged: a newer backup signed by another key is listed invalid" \
  "daily	staging/daily/2026-10-20/rampsmith-staging-20261020T010203Z.dump.age	invalid" "$list_out"
assert_contains "forged: a future-dated one is listed as such" "future" "$list_out"
assert_contains "forged: the real backup is still complete" "rampsmith-staging-20261019T010203Z.dump.age	complete" "$list_out"
assert_eq "forged: the future one is listed first by time, and is not complete" "future" \
  "$(printf '%s\n' "$list_out" | head -n 1 | cut -f3)"
restore_out=$(env -i "${STD[@]}" DRILL_R2_ACCESS_KEY_ID=drill-read-key DRILL_R2_SECRET_ACCESS_KEY=drill-read-secret \
  PGHOST="$sock" PGPORT="$port" PGUSER=rampsmith_migrator "$RD/restore.sh" --target rampsmith --identity "$work/primary.key" \
  --work "$work/restore-forged" --verify-key "$work/sign.pub.pem" \
  --object staging/daily/2026-10-20/rampsmith-staging-20261020T010203Z.dump.age 2>&1)
assert_rc "forged: restore.sh refuses the newer backup the key did not sign" 1 $?
assert_contains "forged: ... saying the signature does not verify" "signature does not verify" "$restore_out"
# The live drill passes over both and restores the real one.
newest_pick=$(printf '%s\n' "$(cd "$store" && find staging/daily -type f | LC_ALL=C sort)" | bk_newest_complete staging daily "$limit_now")
assert_contains "forged: a text-sort 'newest' would have picked the forgery; the drill picks by time (it sees the forgery as complete in the name list, then the signature refuses it)" \
  "2026-10-20" "$newest_pick"
# A future-dated object is warned about by the next backup and not counted by its retention.
run_backup BACKUP_NOW=20261021T010203Z
assert_rc "forged: the next backup still succeeds" 0 "$rc"
assert_contains "forged: ... and warns about the object dated in the future" "dated in the future" "$result"
assert_eq "forged: ... and the future object is still there (retention never deletes it)" "1" \
  "$(files | grep -c "rampsmith-staging-${future_stamp}.dump.age" || true)"
reset_store

# A staging service pointed at production's bucket stops before a byte moves.
run_backup R2_BUCKET_BACKUPS=bk-tests-production
assert_rc "bucket: the staging service refuses another environment's bucket" 1 "$rc"
assert_contains "bucket: ... saying which rule" "is not the staging bucket" "$result"
assert_eq "bucket: ... and stores nothing" "" "$(files)"

# --- what an archive may hold (finding M2, ADR-257) ---------------------------------------------------------------------------------------------
dump="$work/toc.dump"
"$PGBIN/pg_dump" -Fc -h "$sock" -p "$port" -U postgres rampsmith >"$dump"
"$PGBIN/pg_restore" --list "$dump" >"$work/toc-real.txt"
assert_eq "toc: the archive of the real schema holds nothing outside it" "" "$(rd_toc_violations "$work/toc-real.txt")"
toc_with() { { cat "$work/toc-real.txt"; printf '%s\n' "$1"; } >"$work/toc-bad.txt"; rd_toc_violations "$work/toc-bad.txt"; }
for entry in \
  '9001; 1255 16401 EXTENSION - pgcrypto postgres' \
  '9002; 2618 16402 EVENT TRIGGER - evil postgres' \
  '9003; 2618 16403 RULE public findings x postgres' \
  '9004; 0 16404 PUBLICATION - everything postgres' \
  '9005; 0 16405 SUBSCRIPTION - stolen postgres' \
  '9006; 1259 16406 TABLE evil payload postgres' \
  '9007; 0 16407 TABLE DATA evil payload postgres' \
  '9008; 1255 16408 FUNCTION evil run() postgres' \
  '9009; 2612 16409 PROCEDURAL LANGUAGE - plpython3u postgres' \
  '9010; 0 16410 CAST pg_catalog (text AS int) postgres' \
  '9011; 0 16411 FOREIGN DATA WRAPPER - w postgres' \
  '9012; 0 16412 SERVER - s postgres' \
  '9013; 0 16413 DEFAULT ACL public DEFAULT PRIVILEGES FOR TABLES postgres' \
  '9014; 0 16414 OPERATOR public + (int, int) postgres' \
  '9015; 0 16415 AGGREGATE public evil(int) postgres' \
  '9016; 0 16416 COMMENT - EXTENSION pgcrypto postgres' \
  '9017; 0 16417 SCHEMA - evil postgres' \
  'this is not a table of contents line'; do
  assert_contains "toc: refused: ${entry:0:60}" "${entry}" "$(toc_with "$entry")"
done
assert_eq "toc: a table of the schema is accepted" "" \
  "$(toc_with '9100; 1259 16500 TABLE public brand_new_table rampsmith_migrator')"
assert_eq "toc: a policy of the schema is accepted" "" \
  "$(toc_with '9101; 3256 16501 POLICY public findings findings_tenant rampsmith_migrator')"
restore_out=$(env -i "${STD[@]}" AGE="$AGE" PGHOST="$sock" PGPORT="$port" PGUSER=postgres "$RD/restore.sh" --target rampsmith \
  --identity "$work/primary.key" --file "$work/handoff/work/backup.dump.age" --work "$work/restore-super" 2>&1)
assert_rc "restore: a superuser connection is refused" 1 $?
assert_contains "restore: ... asking for rampsmith_migrator" "restore as rampsmith_migrator" "$restore_out"
restore_out=$(env -i "${STD[@]}" AGE="$AGE" PGHOST="$sock" PGPORT="$port" PGUSER=rampsmith_api "$RD/restore.sh" --target rampsmith \
  --identity "$work/primary.key" --file "$work/handoff/work/backup.dump.age" --work "$work/restore-api" 2>&1)
assert_rc "restore: any other login is refused too" 1 $?
assert_contains "restore: ... naming the owner role" "restore as rampsmith_migrator, the role that owns the schema" "$restore_out"
: >"$work/empty.tsv"
vrf_out=$(env -i PATH="$PATH" PGBIN="$PGBIN" PGHOST="$sock" PGPORT="$port" PGUSER=postgres PGDATABASE=rampsmith \
  "$RD/verify.sh" --expected "$work/empty.tsv" --partial 2>&1)
assert_rc "verify: a superuser connection is refused" 1 $?
assert_contains "verify: ... asking for the schema owner" "verify as rampsmith_migrator" "$vrf_out"

# --- signing keys: generate.sh --------------------------------------------------------------------------------------------------------------
gen_repo="$work/gen-repo"
mkdir -p "$gen_repo/infra/backup/signing"
cp "$BK/signing/generate.sh" "$gen_repo/infra/backup/signing/generate.sh"
git -C "$gen_repo" init -q 2>/dev/null || true
gen_out=$("$gen_repo/infra/backup/signing/generate.sh" --environment staging --private-out "$work/gen-staging.key" 2>&1)
assert_rc "generate: makes a key pair" 0 $?
assert_eq "generate: the private key is one line of 64 characters, mode 600" "64 600" \
  "$(wc -c <"$work/gen-staging.key" | tr -d ' ') $(stat -c %a "$work/gen-staging.key")"
assert_not_contains "generate: it does not print the private key" "$(cat "$work/gen-staging.key")" "$gen_out"
assert_contains "generate: it writes the public key where the restore looks" "BEGIN PUBLIC KEY" "$(cat "$gen_repo/infra/backup/signing/staging.pub.pem")"
run_backup BACKUP_SIGNING_KEY="$(cat "$work/gen-staging.key")"
assert_rc "generate: its private key signs a backup" 0 "$rc"
reason=$(bk_verify_backup staging "$b_key" "$b_meta" "$b_sig" "$gen_repo/infra/backup/signing/staging.pub.pem" "$t_ok" 2>&1)
assert_rc "generate: ... and its public key verifies that backup" 0 $?
reason=$(bk_verify_backup staging "$b_key" "$b_meta" "$b_sig" "$work/sign.pub.pem" "$t_ok" 2>&1)
assert_rc "generate: ... and no other key does" 1 $?
"$gen_repo/infra/backup/signing/generate.sh" --environment staging --private-out "$work/gen-staging2.key" >/dev/null 2>&1
assert_rc "generate: an existing public key is not replaced" 1 $?
"$gen_repo/infra/backup/signing/generate.sh" --environment staging --private-out "$work/gen-staging3.key" --rotate >/dev/null 2>&1
assert_rc "generate: --rotate replaces it" 0 $?
"$gen_repo/infra/backup/signing/generate.sh" --environment production --private-out "$gen_repo/prod.key" >/dev/null 2>&1
assert_rc "generate: a private key inside the repository is refused" 1 $?
"$gen_repo/infra/backup/signing/generate.sh" --environment Production --private-out "$work/gen-p.key" >/dev/null 2>&1
assert_rc "generate: a bad environment name is refused" 1 $?
reset_store

# --- the runbooks name what the scripts read (finding M3) ------------------------------------------------------------------------------------------
repo_root="$(cd "$BK/../.." && pwd)"
runbook="$repo_root/docs/runbooks/restore-from-logical-backup.md"
# What the restore tools read from the environment, taken from the code itself: the variables
# list-backups.sh and restore.sh --object require are the ones bk_missing_r2 reports for the drill's set.
read_vars=$(env -i PATH="$PATH" bash -c 'source "$1"; bk_missing_r2 DRILL_R2' _ "$BK/lib/common.sh" | sort -u)
exported=$(grep -E '^export ' "$runbook" | grep -oE '[A-Z][A-Z0-9_]*=' | tr -d '=' | sort -u)
assert_eq "runbook: it exports every variable list-backups.sh requires" "" \
  "$(comm -13 <(printf '%s\n' "$exported") <(printf '%s\n' "$read_vars"))"
generic="PGBIN AGE AGE_KEYGEN PGHOST PGPORT PGUSER PGDATABASE PGPASSWORD VERIFY_APP_PASSWORD AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION RESTORE_ALLOW_SUPERUSER"
unknown=""
for var in $exported; do
  case " $generic " in *" $var "*) continue ;; esac
  printf '%s\n' "$read_vars" | grep -qx "$var" || unknown="$unknown $var"
done
assert_eq "runbook: every variable it exports is one the scripts read" "" "$unknown"
for wrong in R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY BACKUP_R2_ACCESS_KEY_ID BACKUP_R2_SECRET_ACCESS_KEY; do
  assert_eq "runbook: never exports ${wrong} (the engine's or the backup service's token, not the drill's)" "0" \
    "$(grep -E '^export ' "$runbook" | grep -cE "(^| )${wrong}=" || true)"
done
assert_contains "runbook: it names the drill's read-only token" "DRILL_R2_ACCESS_KEY_ID" "$(cat "$runbook")"
cited=$(grep -rhoE '\.github/workflows/[A-Za-z0-9_-]+\.yml' "$repo_root/docs/runbooks" | sort -u)
missing_wf=""
for wf in $cited; do [ -f "$repo_root/$wf" ] || missing_wf="$missing_wf $wf"; done
assert_eq "runbooks: every workflow they cite exists" "" "$missing_wf"
assert_eq "runbooks: none cites the deleted backup.yml" "0" "$(grep -rc 'backup\.yml' "$repo_root/docs/runbooks" | awk -F: '{ n += $2 } END { print n + 0 }')"
runbook_scripts=$(grep -ohE 'infra/(restore-drill|backup)/[A-Za-z0-9_./-]+\.(sh|sql|py)' "$repo_root"/docs/runbooks/*.md | sort -u)
missing_scripts=""
for f in $runbook_scripts; do [ -f "$repo_root/$f" ] || missing_scripts="$missing_scripts $f"; done
assert_eq "runbooks: every script they run exists" "" "$missing_scripts"

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
