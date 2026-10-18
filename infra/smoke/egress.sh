#!/usr/bin/env bash
# Smoke test for the egress image (PLAN §18, §24 step 6): refuses to start without its secret,
# runs as non-root, and demands a scan token before proxying anything.
set -euo pipefail
image=$1
if docker run --rm "$image" 2> egress.err; then
  echo "egress started without EGRESS_TOKEN_SECRET" >&2
  exit 1
fi
grep -q 'EGRESS_TOKEN_SECRET must be set' egress.err
test "$(docker inspect --format '{{.Config.User}}' "$image")" = "65532:65532"
docker run -d --name egress -p 8888:8888 \
  -e EGRESS_TOKEN_SECRET="$(head -c 32 /dev/urandom | base64 -w0)" "$image"
trap 'docker rm -f egress >/dev/null' EXIT
for _ in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -x http://127.0.0.1:8888 http://example.com/ || true)
  test "$code" != 000 && break
  sleep 1
done
# No token: 407. A forged token: 407. Nothing reaches the network either way.
test "$code" = 407
code=$(curl -s -o /dev/null -w '%{http_code}' -x http://127.0.0.1:8888 \
  --proxy-user 'rampsmith:e30.AAAA' http://example.com/)
test "$code" = 407
