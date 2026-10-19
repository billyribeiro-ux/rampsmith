#!/usr/bin/env bash
# Smoke test for the web image (PLAN §22, §24 step 6): non-root, health check up, pages served
# with the security headers, and no start without its configuration.
set -euo pipefail
image=$1
test "$(docker inspect --format '{{.Config.User}}' "$image")" = "node"
docker run -d --name web -p 3000:3000 \
  -e API_URL=http://127.0.0.1:9 -e SHOPIFY_CLIENT_ID=ci-smoke -e ORIGIN=http://localhost:3000 \
  "$image"
trap 'docker rm -f web >/dev/null' EXIT
for _ in $(seq 1 30); do curl -fsS http://127.0.0.1:3000/healthz && break; sleep 1; done
curl -fsS http://127.0.0.1:3000/healthz | grep -q '"status":"ok"'
curl -fsS -D headers.txt -o home.html http://127.0.0.1:3000/
grep -qi "^content-security-policy:.*frame-ancestors 'none'" headers.txt
grep -q '<html lang="en"' home.html
docker rm -f web >/dev/null
if docker run --rm -e SHOPIFY_CLIENT_ID=ci-smoke "$image" 2> web.err; then
  echo "web started without API_URL" >&2
  exit 1
fi
grep -q 'API_URL must be set' web.err
