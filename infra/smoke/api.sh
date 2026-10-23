#!/usr/bin/env bash
# Smoke test for the api/ctl image (PLAN §24 step 6): liveness up, readiness refuses without a
# database, non-root, and ctl refuses to start without its configuration.
set -euo pipefail
image=$1
# Throwaway credentials and a fresh random key: the process must start, not reach Shopify.
docker run -d --name api -p 8080:8080 \
  -e DATABASE_URL=postgres://nobody@127.0.0.1:9/none \
  -e SHOPIFY_API_KEY=ci-smoke \
  -e SHOPIFY_API_SECRET=ci-smoke \
  -e RAMPSMITH_MASTER_KEYS="ci:$(head -c 32 /dev/urandom | base64 -w0)" \
  -e WEBAUTHN_RP_ID=localhost -e WEBAUTHN_RP_ORIGIN=http://localhost:5173 \
  "$image"
trap 'docker rm -f api >/dev/null' EXIT
for _ in $(seq 1 30); do curl -fsS http://127.0.0.1:8080/healthz && break; sleep 1; done
curl -fsS http://127.0.0.1:8080/healthz | grep -q '"ok"'
code=$(curl -s -o readyz.json -w '%{http_code}' http://127.0.0.1:8080/readyz)
test "$code" = 503
grep -q '"code":"unavailable"' readyz.json
test "$(docker inspect --format '{{.Config.User}}' "$image")" = "10001:10001"
if docker run --rm --entrypoint /usr/local/bin/ctl "$image" 2> ctl.err; then
  echo "ctl started without configuration" >&2
  exit 1
fi
grep -q 'DATABASE_URL must be set' ctl.err
# The operator path for a redaction that cannot finish by itself ships in the image (ADR-269).
docker run --rm --entrypoint /usr/local/bin/rsctl "$image" shops redact --help | grep -q -- '--confirmed-by'
