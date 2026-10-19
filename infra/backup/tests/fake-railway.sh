#!/usr/bin/env bash
# A stand-in for `railway ssh` that runs the remote command locally (ADR-172).
#
# `railway ssh [-p PROJECT] [-e ENVIRONMENT] [-s SERVICE] [-i KEY] -- COMMAND...` opens a shell in
# the service container and runs COMMAND there. This double checks the flags the backup passes,
# records the argument list (so a test can prove no secret is on a command line) and then runs
# COMMAND with the caller's stdin, like the real command, after dropping the token variable.
#
#   FAKE_RAILWAY_LOG   file that receives one line per argument (optional)
set -euo pipefail

fail() {
  printf 'fake-railway: %s\n' "$*" >&2
  exit 1
}

[ "${1:-}" = "ssh" ] || fail "only 'ssh' is supported, got: ${1:-nothing}"
shift
project="" environment="" service=""
while [ "$#" -gt 0 ]; do
  case $1 in
    -p | --project) project=$2; shift 2 ;;
    -e | --environment) environment=$2; shift 2 ;;
    -s | --service) service=$2; shift 2 ;;
    -i | --identity-file) [ -f "$2" ] || fail "identity file $2 does not exist"; shift 2 ;;
    --) shift; break ;;
    *) fail "unexpected flag: $1" ;;
  esac
done
[ -n "$project" ] && [ -n "$environment" ] && [ -n "$service" ] || fail "project, environment and service are all required"
[ -n "${RAILWAY_API_TOKEN:-}" ] || fail "RAILWAY_API_TOKEN is not set"
[ "$#" -gt 0 ] || fail "no remote command"

if [ -n "${FAKE_RAILWAY_LOG:-}" ]; then
  {
    printf 'project=%s\nenvironment=%s\nservice=%s\n' "$project" "$environment" "$service"
    printf 'arg=%s\n' "$@"
  } >>"$FAKE_RAILWAY_LOG"
fi

# The container does not have the runner's secrets.
unset RAILWAY_API_TOKEN BACKUP_DB_PASSWORD R2_SECRET_ACCESS_KEY R2_ACCESS_KEY_ID
exec "$@"
