#!/usr/bin/env bash
# Smoke test for the engine image (PLAN §11, §22, §24 step 6): non-root, refuses to start
# without its configuration, and scans a page with Chromium's sandbox on under the seccomp
# profile it ships with.
set -euo pipefail
image=$1
profile=$(dirname "$0")/../engine.seccomp.json
test "$(docker inspect --format '{{.Config.User}}' "$image")" = "pwuser"
if docker run --rm "$image" 2> engine.err; then
  echo "engine started without DATABASE_URL" >&2
  exit 1
fi
grep -q 'DATABASE_URL must be set' engine.err
docker run --rm --init --network none --security-opt "seccomp=$profile" \
  --entrypoint /usr/local/bin/node "$image" packages/engine/src/self-check.ts | tee self-check.json
grep -q '"node":"v26.12.0"' self-check.json
grep -q '"rules":\["image-alt"\]' self-check.json
