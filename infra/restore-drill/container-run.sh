#!/usr/bin/env bash
# What in-container.sh runs inside the container around the caller's command (ADR-255). A file of
# its own so that tests can run it without Docker.
#
#   [RD_IDENTITY=<age private key>] container-run.sh COMMAND [ARGS...]
#
# - If RD_IDENTITY is set, its value (passed into the container by name, so on no command line) is
#   written to RD_IDENTITY_FILE, mode 0600, owned by the user the container runs as; the variable is
#   removed from the environment before COMMAND starts, so the command, its children and
#   /proc/<pid>/environ do not carry it; the file is deleted when COMMAND ends.
# - COMMAND's exit status is the exit status.
# - Afterwards every directory named in RD_DISCARD_DIRS (space separated, absolute, not under
#   RD_SCRATCH_DIR) is deleted, by the user that made it. A restore leaves a whole PostgreSQL cluster
#   of customer data behind; its owner is the container's user, so the runner could not delete it,
#   and nothing that outlives the container may hold it (finding HIGH-1). The command is expected to
#   clean up itself (restore-local.sh --discard-work); this is the second lock.
# - Afterwards everything under RD_SCRATCH_DIR is made readable for the runner's user, who is not
#   the container's user and could not otherwise collect the reports.
set -uo pipefail

identity_file=${RD_IDENTITY_FILE:-/tmp/rd-identity.key}
scratch=${RD_SCRATCH_DIR:-/scratch}

if [ -n "${RD_IDENTITY:-}" ]; then
  (umask 077 && printf '%s' "$RD_IDENTITY" >"$identity_file") || exit 126
fi
unset RD_IDENTITY

status=0
"$@" || status=$?

rm -f "$identity_file"
for dir in ${RD_DISCARD_DIRS:-}; do
  case $dir in
    / | /scratch | "$scratch" | "$scratch"/* | "") continue ;;
    /*) chmod -R u+rwX "$dir" 2>/dev/null || true; rm -rf "$dir" ;;
  esac
done
chmod -R a+rX "$scratch" 2>/dev/null || true
exit "$status"
