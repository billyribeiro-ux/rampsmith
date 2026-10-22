#!/usr/bin/env bash
# The nightly logical backup (ADR-171 to ADR-173, ADR-251): pg_dump -Fc, encrypted with age to
# public recipients, uploaded to the environment's R2 backups bucket under a dated key, verified,
# signed (ADR-256), then pruned.
#
#   backup.sh
#
# It runs as the entrypoint of the `backup` Railway service, a cron service inside the project
# that reaches the database over the private network (infra/backup/entrypoint.sh, ADR-251). No
# GitHub workflow runs it and no GitHub secret reaches it.
#
# The archive is never written unencrypted: pg_dump's output goes through a pipe, a copy of the
# stream feeds `pg_restore --list` (which proves the stream is a PostgreSQL archive), and age
# writes the only file. The private key is not here and never was: only `age1...` recipients
# are accepted.
#
# Configuration (environment; Railway variables of the backup service, infra/railway/railway.py):
#   BACKUP_ENVIRONMENT      production | staging: the key prefix
#   BACKUP_DB_HOST/PORT/USER/NAME/PASSWORD
#                           the database login (a least-privilege role: infra/backup/backup-role.sql)
#   BACKUP_AGE_RECIPIENTS   public age recipients, one per line
#   BACKUP_SIGNING_KEY      the Ed25519 key that signs the metadata object (ADR-256); the public half
#                           is committed as infra/backup/signing/<environment>.pub.pem
#   R2_ACCOUNT_ID, R2_BUCKET_BACKUPS, BACKUP_R2_ACCESS_KEY_ID, BACKUP_R2_SECRET_ACCESS_KEY
#                           this environment's backups bucket (rampsmith-backups-<environment>) and
#                           the token scoped to it alone (LAUNCH.md C row 16, ADR-252). The engine's
#                           R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are never read.
# Optional: BACKUP_KEEP_DAILY (30), BACKUP_KEEP_MONTHLY (12), BACKUP_PRUNE_MAX (10), PGBIN (a
# directory holding the PostgreSQL 18 client programs), AWS_BIN, AGE_BIN, BACKUP_NOW.
#
# Exit codes: 0 stored and verified; 1 failed; 3 the service is not configured yet (the entrypoint
# turns 3 into exit 0 after this script has warned, naming what is missing).
set -euo pipefail
umask 077

BK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$BK_DIR/lib/common.sh"
# shellcheck source=lib/s3.sh
source "$BK_DIR/lib/s3.sh"
# shellcheck source=lib/sign.sh
source "$BK_DIR/lib/sign.sh"

AGE_BIN="${AGE_BIN:-age}"
BACKUP_KEEP_DAILY="${BACKUP_KEEP_DAILY:-30}"
BACKUP_KEEP_MONTHLY="${BACKUP_KEEP_MONTHLY:-12}"
BACKUP_PRUNE_MAX="${BACKUP_PRUNE_MAX:-10}"
for _bk_name in BACKUP_KEEP_DAILY BACKUP_KEEP_MONTHLY BACKUP_PRUNE_MAX; do
  [[ "${!_bk_name}" =~ ^[1-9][0-9]*$ ]] || bk_die "${_bk_name} must be a positive integer (^[1-9][0-9]*\$), got a different value"
done

pg_tool() {
  if [ -n "${PGBIN:-}" ]; then printf '%s/%s' "$PGBIN" "$1"; else printf '%s' "$1"; fi
}

# --- configuration -------------------------------------------------------------------------------
# The founder's inputs. A variable that is empty or still an unresolved Railway reference counts
# as unset. Everything else (host, name, login, environment) is wired by railway.py.
missing=$(bk_missing_r2 BACKUP_R2 | tr '\n' ' ')
for name in BACKUP_AGE_RECIPIENTS BACKUP_SIGNING_KEY BACKUP_DB_PASSWORD; do
  if bk_is_unset "$name"; then
    missing="${missing}${name} "
  fi
done
if [ -n "$missing" ]; then
  bk_warning "backup of ${BACKUP_ENVIRONMENT:-unknown} not configured: needs ${missing}(${BK_LAUNCH_ROW}); nothing was backed up"
  exit "$BK_EXIT_NOT_CONFIGURED"
fi
bk_require BACKUP_ENVIRONMENT BACKUP_DB_HOST BACKUP_DB_NAME BACKUP_DB_USER
BACKUP_DB_PORT="${BACKUP_DB_PORT:-5432}"
bk_valid_environment "$BACKUP_ENVIRONMENT" || bk_die "BACKUP_ENVIRONMENT is not a valid environment name"
bk_bucket_matches_environment "$R2_BUCKET_BACKUPS" "$BACKUP_ENVIRONMENT" ||
  bk_die "R2_BUCKET_BACKUPS is not the ${BACKUP_ENVIRONMENT} bucket: each environment has its own bucket, named rampsmith-backups-${BACKUP_ENVIRONMENT} (ADR-252)"
for name in BACKUP_DB_USER BACKUP_DB_NAME; do
  [[ ${!name} =~ ^[A-Za-z0-9_.-]+$ ]] || bk_die "${name} holds characters outside A-Za-z0-9_.-"
done
# A host name, an address, or the directory of a Unix socket.
# shellcheck disable=SC2153  # BACKUP_DB_HOST comes from the environment, checked by bk_require
[[ $BACKUP_DB_HOST =~ ^(/[A-Za-z0-9_./-]+|[A-Za-z0-9_.:-]+)$ ]] ||
  bk_die "BACKUP_DB_HOST is neither a host name nor a socket directory"
[[ $BACKUP_DB_PORT =~ ^[0-9]{1,5}$ ]] || bk_die "BACKUP_DB_PORT is not a port number"

work=$(mktemp -d)
cleanup() { rm -rf "$work"; }
trap cleanup EXIT

bk_write_recipients "$BACKUP_AGE_RECIPIENTS" "$work/recipients.txt"
bk_signing_key_file "$BACKUP_SIGNING_KEY" "$work/signing.der" ||
  bk_die "BACKUP_SIGNING_KEY is not an Ed25519 private key (one line of base64, 64 characters; infra/backup/signing/generate.sh makes it)"
bk_public_key_of "$work/signing.der" "$work/signing.pub.pem" || bk_die "could not derive the public signing key"
s3_init BACKUP_R2

# --- reaching the database ----------------------------------------------------------------------
# db_run TOOL ARGS...: runs a PostgreSQL client program against the database, writing to stdout.
# The login travels in the libpq environment, so nothing secret is on a command line.
db_run() {
  local tool=$1
  shift
  PGHOST=$BACKUP_DB_HOST PGPORT=$BACKUP_DB_PORT PGUSER=$BACKUP_DB_USER \
    PGDATABASE=$BACKUP_DB_NAME PGPASSWORD=$BACKUP_DB_PASSWORD \
    "$(pg_tool "$tool")" "$@"
}

dump_stream() {
  db_run pg_dump -Fc --no-password --lock-wait-timeout=300s
}

query() {
  db_run psql -X -At -v ON_ERROR_STOP=1 --no-password -c "$1"
}

# --- 1. dump, check and encrypt in one pass --------------------------------------------------------
stamp=$(bk_utc_stamp)
bk_valid_stamp "$stamp" || bk_die "BACKUP_NOW is not YYYYMMDDTHHMMSSZ"
run_epoch=$(bk_stamp_epoch "$stamp") || bk_die "BACKUP_NOW is not a real time"
base=$(bk_object_base "$BACKUP_ENVIRONMENT" daily "$stamp")
archive="$work/archive.age"
bk_log "backup ${BACKUP_ENVIRONMENT} ${stamp}"

schema_version=$(query "select coalesce(max(version)::text, 'none') from public._sqlx_migrations where success") ||
  bk_die "could not read the migration version: the login cannot reach the database or lacks SELECT (see infra/backup/backup-role.sql)"
server_version=$(query "show server_version") || bk_die "could not read the server version"
[[ $schema_version =~ ^[0-9a-z]+$ ]] || bk_die "unexpected migration version"
[[ $server_version =~ ^[0-9A-Za-z._\ ()+-]+$ ]] || bk_die "unexpected server version"

mkfifo "$work/toc.fifo"
"$(pg_tool pg_restore)" --list <"$work/toc.fifo" >"$work/toc.txt" 2>"$work/toc.err" &
toc_pid=$!

set +e
dump_stream 2>"$work/dump.err" | tee -p "$work/toc.fifo" | "$AGE_BIN" -R "$work/recipients.txt" -o "$archive" 2>"$work/age.err"
statuses=("${PIPESTATUS[@]}")
set -e
# Release the TOC reader if the pipeline ended before the tee opened its fifo.
: <>"$work/toc.fifo"
toc_status=0
wait "$toc_pid" || toc_status=$?

if [ "${statuses[0]}" -ne 0 ]; then
  bk_error "pg_dump failed (exit ${statuses[0]}): $(tr '\n' ' ' <"$work/dump.err" | head -c 600)"
  exit 1
fi
if [ "${statuses[2]}" -ne 0 ]; then
  bk_error "age failed (exit ${statuses[2]}): $(tr '\n' ' ' <"$work/age.err" | head -c 600)"
  exit 1
fi
if [ "$toc_status" -ne 0 ]; then
  bk_error "the dump is not a PostgreSQL archive (pg_restore --list exit ${toc_status}): $(tr '\n' ' ' <"$work/toc.err" | head -c 600)"
  exit 1
fi
[ -s "$archive" ] || bk_die "age wrote an empty file"
if ! grep -Eq '^[0-9]+; [0-9]+ [0-9]+ TABLE DATA public _sqlx_migrations ' "$work/toc.txt"; then
  bk_die "the archive does not contain public._sqlx_migrations: this is not a Rampsmith database or the dump was filtered"
fi
tables=$(grep -Ec '^[0-9]+; [0-9]+ [0-9]+ TABLE DATA ' "$work/toc.txt" || true)
policies=$(grep -Ec '^[0-9]+; [0-9]+ [0-9]+ POLICY ' "$work/toc.txt" || true)
if [ "$policies" -lt 1 ]; then
  bk_die "the archive holds no row-level security policy: the dump is not of the application schema"
fi

size=$(wc -c <"$archive" | tr -d ' ')
sha=$(sha256sum "$archive" | cut -d' ' -f1)
fingerprint=$(bk_recipients_fingerprint "$work/recipients.txt")
age_version=$("$AGE_BIN" --version 2>/dev/null | head -n 1 | tr -cd '0-9A-Za-z._+-' || true)
dump_version=$(grep -m1 '^; Dumped by pg_dump version' "$work/toc.txt" | sed 's/^; Dumped by pg_dump version: *//' | tr -cd '0-9A-Za-z._ ()+-' || true)
bk_log "dumped: ${size} bytes encrypted, ${tables} tables, ${policies} policies, schema ${schema_version}"

# --- 2. upload and verify ----------------------------------------------------------------------------
write_meta() {
  local kind=$1 key=$2 file=$3 run=""
  # Railway sets the deployment id of the cron run; anything else in it is ignored.
  if [[ ${RAILWAY_DEPLOYMENT_ID:-} =~ ^[A-Za-z0-9-]{1,64}$ ]]; then
    run="railway-deployment:${RAILWAY_DEPLOYMENT_ID}"
  fi
  cat >"$file" <<EOF
{
  "format": "rampsmith-backup-meta/1",
  "environment": "${BACKUP_ENVIRONMENT}",
  "kind": "${kind}",
  "key": "${key}",
  "created_utc": "${stamp:0:4}-${stamp:4:2}-${stamp:6:2}T${stamp:9:2}:${stamp:11:2}:${stamp:13:2}Z",
  "size_bytes": ${size},
  "sha256": "${sha}",
  "encryption": {"tool": "age", "version": "${age_version}", "recipients_fingerprint": "${fingerprint}"},
  "database": {"server_version": "${server_version}", "schema_version": "${schema_version}", "tables": ${tables}, "policies": ${policies}},
  "pg_dump": "${dump_version}",
  "source": "railway-cron",
  "run": "${run}"
}
EOF
}

# store KIND: uploads the archive, checks size and content, then signs the metadata and writes its
# signature and the metadata object last (the metadata object is the commit marker).
store() {
  local kind=$1 object remote_size remote_sha
  object=$(bk_object_base "$BACKUP_ENVIRONMENT" "$kind" "$stamp")
  s3_put "$archive" "${object}.dump.age" || bk_die "upload of ${object}.dump.age failed"
  remote_size=$(s3_size "${object}.dump.age") || bk_die "could not read the size of ${object}.dump.age back"
  if [ "$remote_size" != "$size" ]; then
    bk_die "stored size ${remote_size} differs from the ${size} bytes sent for ${object}.dump.age"
  fi
  remote_sha=$(s3_cat "${object}.dump.age" | sha256sum | cut -d' ' -f1)
  if [ "$remote_sha" != "$sha" ]; then
    bk_die "stored content of ${object}.dump.age differs from what was sent (sha256 mismatch)"
  fi
  write_meta "$kind" "${object}.dump.age" "$work/meta-${kind}.json"
  bk_sign "$work/meta-${kind}.json" "$work/signing.der" "$work/meta-${kind}.sig" || bk_die "could not sign the metadata of ${object}"
  s3_put "$work/meta-${kind}.sig" "${object}.meta.json.sig" || bk_die "upload of ${object}.meta.json.sig failed"
  s3_put "$work/meta-${kind}.json" "${object}.meta.json" || bk_die "upload of ${object}.meta.json failed"
  # Read both back and verify them the way a restore will, with the public half of the key just used.
  s3_get "${object}.meta.json" "$work/readback.json" || bk_die "could not read the metadata of ${object} back"
  s3_get "${object}.meta.json.sig" "$work/readback.sig" || bk_die "could not read the signature of ${object} back"
  if ! reason=$(bk_verify_backup "$BACKUP_ENVIRONMENT" "${object}.dump.age" "$work/readback.json" \
    "$work/readback.sig" "$work/signing.pub.pem" "$run_epoch"); then
    bk_die "the stored metadata of ${object} does not verify: ${reason}"
  fi
  bk_log "stored ${object}.dump.age (${size} bytes, sha256 ${sha:0:16}...)"
}

store daily

# The first backup of each month is kept a second time under monthly/; a missed first day
# is made up by the next run, because the test is "no complete monthly backup yet".
monthly_prefix="${BACKUP_ENVIRONMENT}/monthly/"
monthly_keys=$(s3_list "$monthly_prefix") || bk_die "could not list ${monthly_prefix}"
if printf '%s\n' "$monthly_keys" | bk_period_complete "$BACKUP_ENVIRONMENT" monthly "$stamp"; then
  bk_log "monthly backup for ${stamp:0:4}-${stamp:4:2} already exists"
else
  store monthly
fi

# --- 3. retention (after the new backup is in place and verified) ---------------------------------------
limit_stamp=$(bk_future_limit "$run_epoch")
prune_kind() {
  local kind=$1 keep=$2 keys victims count key future
  keys=$(s3_list "${BACKUP_ENVIRONMENT}/${kind}/") || bk_die "could not list ${BACKUP_ENVIRONMENT}/${kind}/ for pruning"
  # Objects stamped after this run's own time (plus the clock skew) are neither counted nor deleted.
  future=$(printf '%s\n' "$keys" | bk_backups "$BACKUP_ENVIRONMENT" "$kind" "$limit_stamp" | awk -F'\t' '$3 == "future"' | wc -l | tr -d ' ')
  if [ "$future" -gt 0 ]; then
    bk_warning "${BACKUP_ENVIRONMENT}/${kind}/ holds ${future} backup(s) dated in the future; restores ignore them and retention leaves them alone. Someone with write access to the bucket put them there: investigate (ADR-256)"
  fi
  victims=$(printf '%s\n' "$keys" | bk_retention_victims "$BACKUP_ENVIRONMENT" "$kind" "$keep" "$limit_stamp")
  count=$(printf '%s\n' "$victims" | awk 'NF' | wc -l | tr -d ' ')
  if [ "$count" -eq 0 ]; then
    bk_log "retention ${kind}: nothing to prune (keeping the newest ${keep} periods)"
    return 0
  fi
  if [ "$count" -gt "$BACKUP_PRUNE_MAX" ]; then
    bk_die "retention ${kind}: refusing to delete ${count} objects (limit ${BACKUP_PRUNE_MAX}); the backup is stored. Check BACKUP_KEEP_* and the bucket, then raise BACKUP_PRUNE_MAX once"
  fi
  while IFS= read -r key; do
    [ -n "$key" ] || continue
    s3_delete "$key" || bk_die "retention ${kind}: could not delete ${key}"
    bk_log "pruned ${key}"
  done <<<"$victims"
}
prune_kind daily "$BACKUP_KEEP_DAILY"
prune_kind monthly "$BACKUP_KEEP_MONTHLY"

bk_notice "backup ${BACKUP_ENVIRONMENT} ${stamp} stored and verified: ${size} bytes, ${tables} tables, schema ${schema_version}"
bk_log "archive ${base}.dump.age, sha256 ${sha}; ${tables} tables, ${policies} policies, migration ${schema_version}; recipients ${fingerprint}"
