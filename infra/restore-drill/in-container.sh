#!/usr/bin/env bash
# Runs a command inside the pinned PostgreSQL 18 image, for the CI jobs (ADR-175).
#
#   RD_IMAGE=postgres:18.6-bookworm@sha256:... RD_TOOLS=/dir/with/age RD_SCRATCH=/dir \
#     in-container.sh COMMAND [ARGS...]
#
# The repository is mounted read-only at /repo (the working directory), the directory holding
# the `age` and `age-keygen` binaries read-only at /tools, and RD_SCRATCH at /scratch. The
# container runs as the image's postgres user, because initdb refuses root, and has no network
# unless RD_NETWORK is set. Afterwards the scratch files are made readable for the runner.
set -euo pipefail

image=${RD_IMAGE:?RD_IMAGE is not set}
tools=${RD_TOOLS:?RD_TOOLS is not set}
scratch=${RD_SCRATCH:?RD_SCRATCH is not set}
network=${RD_NETWORK:-none}
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

mkdir -p "$scratch"
chmod 777 "$scratch"

docker run --rm --user postgres --network "$network" \
  -v "$repo:/repo:ro" -v "$tools:/tools:ro" -v "$scratch:/scratch" -w /repo \
  -e AGE=/tools/age -e AGE_KEYGEN=/tools/age-keygen \
  -e DRILL_FAULT -e DRILL_PORT_BASE -e RTO_TARGET_SECONDS \
  "$image" bash -c 'rc=0; "$@" || rc=$?; chmod -R a+rX /scratch 2>/dev/null || true; exit "$rc"' bash "$@"
