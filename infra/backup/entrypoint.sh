#!/usr/bin/env bash
# The entrypoint of the `backup` image, run by Railway's cron schedule (ADR-251): one backup, then
# exit. Railway skips the next run while a container is still running, so the process must end.
#
#   entrypoint.sh
#
# backup.sh exits 3 when the service is not configured yet. That is neither a success nor a
# failure: backup.sh has already logged a warning that names every missing variable and the
# LAUNCH.md row that provides it, and this script exits 0 so an unconfigured service does not look
# like a crashing one and is not restarted. Any other status is returned as it is, so a failed
# backup is a failed deployment.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$DIR/lib/common.sh"

status=0
"$DIR/backup.sh" || status=$?
if [ "$status" -eq "$BK_EXIT_NOT_CONFIGURED" ]; then
  bk_log "backup skipped: the service is not configured, see the warning above"
  exit 0
fi
exit "$status"
