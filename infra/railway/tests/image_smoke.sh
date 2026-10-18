#!/usr/bin/env bash
# Start a release image the way Railway will and check it serves (ADR-185). This is the
# substitute test for the staging deploy in LAUNCH.md E: same image, same start and pre-deploy
# commands (read from railway.py), same port and health check, a real PostgreSQL 18.6 with the
# logins from bootstrap.sql, and throwaway credentials.
#
# Usage: image_smoke.sh <web|api|ctl|engine|egress> <image>
# Env:   PGHOST, PGPORT, PGUSER, PGPASSWORD for a disposable superuser connection (api, ctl,
#        engine); sqlx on PATH; STRICT=1 on main, where an integration gap fails instead of
#        warning (a gap is something the image's owner still has to add, listed in
#        docs/evidence/ws-9-deploy.md).
set -euo pipefail

service=${1:?service}
image=${2:?image}
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
strict=${STRICT:-0}
work=$(mktemp -d "${RUNNER_TEMP:-/tmp}/smoke-XXXXXX")
chmod 700 "$work"
container="smoke-$service-$RANDOM"
env_file="$work/env"

spec=$(python3 "$root/infra/railway/scripts/service_spec.py" "$service")
port=$(jq -r '.port' <<<"$spec")
health=$(jq -r '.healthcheck' <<<"$spec")
webhook_port=$(jq -r '.webhookPort // empty' <<<"$spec")
mapfile -t start < <(jq -r '.start // [] | .[]' <<<"$spec")
mapfile -t pre < <(jq -r '.preDeploy // [] | .[]' <<<"$spec")

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

fail() {
  echo "::error title=$service image::$*"
  docker logs "$container" 2>&1 | tail -50 || true
  exit 1
}

# Something the image's owner still has to add: fails a release, warns on a pull request.
gap() {
  if [ "$strict" = 1 ]; then
    fail "$*"
  fi
  echo "::warning title=$service image (integration gap)::$*"
}

hex() { openssl rand -hex 32; }

user=$(docker image inspect --format '{{.Config.User}}' "$image")
case "$user" in
  "" | root | 0 | 0:*) fail "the image runs as root (USER is '${user}')" ;;
esac
echo "runs as $user"

# Database for this service: fresh, with bootstrap.sql's logins, so the pre-deploy step really
# migrates an empty schema.
database_url() { echo "postgresql://$1:$2@${PGHOST:-127.0.0.1}:${PGPORT:-5432}/$db"; }
db=""
case "$service" in
  api | ctl | engine)
    db="smoke_${service}_$RANDOM"
    psql -X -q -v ON_ERROR_STOP=1 -d postgres -c "create database $db"
    export RAMPSMITH_DB_PASSWORD_MIGRATOR RAMPSMITH_DB_PASSWORD_API RAMPSMITH_DB_PASSWORD_CTL \
      RAMPSMITH_DB_PASSWORD_ENGINE
    RAMPSMITH_DB_PASSWORD_MIGRATOR=$(hex)
    RAMPSMITH_DB_PASSWORD_API=$(hex)
    RAMPSMITH_DB_PASSWORD_CTL=$(hex)
    RAMPSMITH_DB_PASSWORD_ENGINE=$(hex)
    psql -X -q -v ON_ERROR_STOP=1 -d "$db" -f "$root/infra/railway/bootstrap.sql"
    ;;
esac

{
  echo "PORT=$port"
  echo "SERVICE_VERSION=smoke"
  echo "RUST_LOG=info"
  case "$service" in
    api)
      echo "BIND_ADDR=[::]:$port"
      echo "WEBHOOK_BIND_ADDR=[::]:$webhook_port"
      echo "DATABASE_URL=$(database_url rampsmith_api "$RAMPSMITH_DB_PASSWORD_API")"
      echo "MIGRATION_DATABASE_URL=$(database_url rampsmith_migrator "$RAMPSMITH_DB_PASSWORD_MIGRATOR")"
      echo "SHOPIFY_CLIENT_ID=smoke"
      echo "SHOPIFY_CLIENT_SECRET=smoke"
      echo "RAMPSMITH_MASTER_KEYS=smoke:$(head -c 32 /dev/urandom | base64 -w0)"
      echo "WEBAUTHN_RP_ID=localhost"
      echo "WEBAUTHN_RP_ORIGIN=http://localhost:3000"
      ;;
    ctl)
      echo "BIND_ADDR=[::]:$port"
      echo "DATABASE_URL=$(database_url rampsmith_ctl "$RAMPSMITH_DB_PASSWORD_CTL")"
      echo "SHOPIFY_CLIENT_ID=smoke"
      echo "SHOPIFY_CLIENT_SECRET=smoke"
      echo "RAMPSMITH_MASTER_KEYS=smoke:$(head -c 32 /dev/urandom | base64 -w0)"
      ;;
    engine)
      echo "DATABASE_URL=$(database_url rampsmith_engine "$RAMPSMITH_DB_PASSWORD_ENGINE")"
      echo "EGRESS_PROXY_URL=http://127.0.0.1:9"
      echo "EGRESS_TOKEN_SECRET=$(hex)"
      ;;
    egress)
      echo "EGRESS_BIND=[::]:$port"
      echo "EGRESS_TOKEN_SECRET=$(hex)"
      ;;
    web)
      echo "HOST=::"
      echo "API_URL=http://127.0.0.1:9"
      echo "SHOPIFY_CLIENT_ID=smoke"
      ;;
    *) fail "unknown service $service" ;;
  esac
} >"$env_file"
chmod 600 "$env_file"

with_command() {
  # Railway runs a start or pre-deploy command in exec form, replacing the entrypoint.
  local -n argv=$1
  shift
  if [ ${#argv[@]} -gt 0 ]; then
    docker run "$@" --network host --env-file "$env_file" --entrypoint "${argv[0]}" "$image" \
      "${argv[@]:1}"
  else
    docker run "$@" --network host --env-file "$env_file" "$image"
  fi
}

if [ ${#pre[@]} -gt 0 ]; then
  echo "pre-deploy: ${pre[*]}"
  if docker run --rm --entrypoint /bin/sh "$image" -c \
    'test -x /usr/local/bin/sqlx && test -d /usr/local/share/rampsmith/migrations'; then
    with_command pre --rm || fail "the pre-deploy command failed"
  else
    gap "the image has no /usr/local/bin/sqlx or /usr/local/share/rampsmith/migrations, so" \
      "Railway's pre-deploy step cannot migrate; migrating from the runner instead"
    DATABASE_URL=$(database_url rampsmith_migrator "$RAMPSMITH_DB_PASSWORD_MIGRATOR") \
      sqlx migrate run --source "$root/crates/db/migrations"
  fi
elif [ -n "$db" ]; then
  DATABASE_URL=$(database_url rampsmith_migrator "$RAMPSMITH_DB_PASSWORD_MIGRATOR") \
    sqlx migrate run --source "$root/crates/db/migrations"
fi

with_command start -d --name "$container" >/dev/null

served=""
for _ in $(seq 1 90); do
  if ! docker inspect --format '{{.State.Running}}' "$container" | grep -q true; then
    fail "the container exited during start-up"
  fi
  if curl -fsS -o /dev/null "http://127.0.0.1:$port$health"; then
    served=yes
    break
  fi
  sleep 1
done
if [ -n "$served" ]; then
  echo "$health answers 200 on port $port"
else
  gap "no 200 from GET $health on PORT $port within 90 s (Railway's deploy health check)"
fi

sleep 5
docker inspect --format '{{.State.Running}}' "$container" | grep -q true ||
  fail "the container exited after start-up"

if [ "$service" = api ]; then
  curl -fsS -o /dev/null "http://127.0.0.1:$port/healthz" || fail "/healthz did not answer 200"
  # The start command scrubs the migration credential from the api process.
  environ=$(docker exec "$container" cat /proc/1/environ | tr '\0' '\n' | cut -d= -f1)
  grep -qx DATABASE_URL <<<"$environ" || fail "could not read the api process environment"
  if grep -qx MIGRATION_DATABASE_URL <<<"$environ"; then
    fail "the api process can read MIGRATION_DATABASE_URL"
  fi
  echo "the api process cannot see MIGRATION_DATABASE_URL"
  # The public domain reaches only the webhook listener.
  if curl -s -o /dev/null "http://127.0.0.1:$webhook_port/"; then
    code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$webhook_port/readyz")
    [ "$code" = 404 ] || fail "the webhook listener serves /readyz ($code); it must serve only /webhooks/*"
    code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$webhook_port/webhooks/shopify")
    [ "$code" = 401 ] || fail "an unsigned Shopify webhook got $code, not 401"
    echo "the webhook listener serves only signed /webhooks/* requests"
  else
    gap "nothing listens on WEBHOOK_BIND_ADDR (port $webhook_port), the only port the public" \
      "webhook domain reaches (ADR-182)"
  fi
fi

echo "$service image smoke test: PASS"
