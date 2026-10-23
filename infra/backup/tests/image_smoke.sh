#!/usr/bin/env bash
# Starts the backup image the way Railway's cron schedule does and checks what can be checked
# without a bucket or a database (ADR-251, ADR-258). release.yml runs it on the image it built (pull
# requests) and on the pushed digest (main), through infra/railway/tests/image_smoke.sh.
#
#   image_smoke.sh IMAGE
#
# Checks: the image runs as a non-root user and bakes in no credential; its tools start and are
# the pinned versions; an unconfigured start warns, names every missing input and exits 0; a
# configured start that cannot reach its database exits non-zero without printing a secret. Every
# container has no network: nothing here talks to R2 or to a real database.
set -euo pipefail

image=${1:?usage: image_smoke.sh IMAGE}
fail() {
  echo "::error title=backup image::$*"
  exit 1
}

user=$(docker image inspect --format '{{.Config.User}}' "$image")
case "$user" in
  "" | root | root:* | 0 | 0:*) fail "the image runs as root (USER is '${user}')" ;;
esac
echo "runs as $user"

entrypoint=$(docker image inspect --format '{{json .Config.Entrypoint}}' "$image")
[ "$entrypoint" = '["/opt/rampsmith/backup/entrypoint.sh"]' ] || fail "unexpected entrypoint $entrypoint"

# The environment baked into the image holds no credential and no database login.
baked=$(docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$image" | cut -d= -f1)
if grep -E '^(BACKUP_|DRILL_|R2_|AWS_(ACCESS|SECRET|SESSION)|RAILWAY_|PGPASSWORD|PGUSER|PGHOST)' <<<"$baked"; then
  fail "the image bakes in a variable that should come from Railway"
fi

# run PROGRAM ARGS...: a program of the image in place of the entrypoint, with no network.
run() {
  local program=$1
  shift
  docker run --rm --network none --entrypoint "$program" "$image" "$@"
}
# tool EXPECTED PROGRAM ARGS...: the program starts and its first output line holds EXPECTED.
tool() {
  local expected=$1 out
  shift
  out=$(run "$@" 2>&1) || fail "$1 did not start: $out"
  [[ $out == *"$expected"* ]] || fail "$1 reported '$out', expected '$expected'"
  echo "$1: $(head -n 1 <<<"$out")"
}
tool "v1.3.2" age --version
tool "aws-cli/1.46.1" aws --version
tool "(PostgreSQL) 18." pg_dump --version
tool "(PostgreSQL) 18." pg_restore --version
tool "(PostgreSQL) 18." psql --version
tool "OpenSSL 3." openssl version

# The image is the slim client image (finding MEDIUM-1): no PostgreSQL server, no gosu, and the
# signing round trip the nightly run depends on (Ed25519 with -rawin) works with its OpenSSL.
if run test -e /usr/lib/postgresql/18/bin/postgres; then fail "the image holds a PostgreSQL server binary"; fi
if run sh -c 'command -v gosu'; then fail "the image holds gosu"; fi
sign_out=$(docker run --rm --network none --entrypoint sh "$image" -c '
  set -e
  cd "$(mktemp -d)"
  openssl genpkey -algorithm ed25519 -outform DER -out k.der
  openssl pkey -inform DER -in k.der -pubout -out k.pub
  printf "{}" >m.json
  openssl pkeyutl -sign -inkey k.der -keyform DER -rawin -in m.json -out m.sig
  openssl pkeyutl -verify -pubin -inkey k.pub -rawin -in m.json -sigfile m.sig' 2>&1) ||
  fail "the image cannot sign and verify with Ed25519: $sign_out"
echo "signing: Ed25519 sign and verify work"

[ "$(run id -u)" != 0 ] || fail "the container runs as uid 0"
if run test -w /opt/rampsmith/backup/backup.sh; then
  fail "the backup scripts are writable by the user that runs them"
fi

# Unconfigured: Railway starts the service before the founder has set anything.
status=0
out=$(docker run --rm --network none "$image" 2>&1) || status=$?
[ "$status" -eq 0 ] || fail "an unconfigured start exited $status, not 0: $out"
for needle in "::warning::" "not configured" R2_ACCOUNT_ID BACKUP_R2_ACCESS_KEY_ID \
  BACKUP_R2_SECRET_ACCESS_KEY R2_BUCKET_BACKUPS BACKUP_AGE_RECIPIENTS BACKUP_SIGNING_KEY BACKUP_DB_PASSWORD \
  "LAUNCH.md section C row 16"; do
  [[ $out == *"$needle"* ]] || fail "the unconfigured start did not say '$needle': $out"
done
echo "unconfigured start: warns, names the missing inputs, exits 0"

# Configured, with no database to reach: a failed backup is a failed run, and the output carries
# no secret. A public age recipient generated for this test (the private half was discarded).
marker=smoke-marker-$RANDOM$RANDOM
status=0
out=$(docker run --rm --network none \
  -e BACKUP_ENVIRONMENT=staging -e BACKUP_DB_HOST=127.0.0.1 -e BACKUP_DB_PORT=9 \
  -e BACKUP_DB_NAME=rampsmith -e BACKUP_DB_USER=rampsmith_backup -e "BACKUP_DB_PASSWORD=pw-$marker" \
  -e R2_ACCOUNT_ID=00000000000000000000000000000000 -e R2_BUCKET_BACKUPS=smoke-backups-staging \
  -e "BACKUP_SIGNING_KEY=$(openssl genpkey -algorithm ed25519 -outform DER 2>/dev/null | base64 -w0)" \
  -e "BACKUP_R2_ACCESS_KEY_ID=key-$marker" -e "BACKUP_R2_SECRET_ACCESS_KEY=secret-$marker" \
  -e BACKUP_AGE_RECIPIENTS=age17prg4nysv8q4w5m3tl4dr49m7m4s98vt38pjd68xykpugw8qa3dqfqxq5n \
  "$image" 2>&1) || status=$?
[ "$status" -ne 0 ] || fail "a backup with no reachable database exited 0"
[[ $out == *"could not read the migration version"* ]] || fail "unexpected failure output: $out"
[[ $out != *"$marker"* ]] || fail "the failure output contains a credential"
echo "configured start without a database: exits $status, prints no credential"

echo "backup image smoke test: PASS"
