#!/usr/bin/env bash
# Decides whether the nightly backup can run in a GitHub environment (ADR-174).
#
#   gate.sh            (reads the environment; writes configured=true|false to $GITHUB_OUTPUT)
#
# The workflow maps its environment secrets and variables to environment variables for this step
# only. When something the backup needs is missing, the script writes a warning annotation that
# names the missing variables and LAUNCH.md section C rows 6 and 8, adds the same text to the job
# summary, and reports configured=false so the workflow skips the rest. It exits 0 then: the
# founder's accounts come last, and an unconfigured environment is a skipped check that says so,
# never a silent pass and never a red run.
#
# What the backup needs, by transport:
#   always         R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_BACKUPS (row 6),
#                  BACKUP_AGE_RECIPIENTS (public keys), BACKUP_DB_NAME, BACKUP_DB_PASSWORD
#   url            BACKUP_DB_HOST
#   railway-ssh    RAILWAY_API_TOKEN, BACKUP_RAILWAY_PROJECT_ID, BACKUP_RAILWAY_ENVIRONMENT,
#                  BACKUP_RAILWAY_SERVICE, BACKUP_RAILWAY_SSH_PRIVATE_KEY (row 8)
set -euo pipefail

# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

transport="${BACKUP_SOURCE:-railway-ssh}"
required=(R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET_BACKUPS
  BACKUP_AGE_RECIPIENTS BACKUP_DB_NAME BACKUP_DB_PASSWORD)
case $transport in
  url) required+=(BACKUP_DB_HOST) ;;
  railway-ssh)
    required+=(RAILWAY_API_TOKEN BACKUP_RAILWAY_PROJECT_ID BACKUP_RAILWAY_ENVIRONMENT
      BACKUP_RAILWAY_SERVICE BACKUP_RAILWAY_SSH_PRIVATE_KEY)
    ;;
  *) bk_die "BACKUP_SOURCE must be url or railway-ssh, not '${transport}'" ;;
esac

missing=""
for name in "${required[@]}"; do
  if [ -z "${!name:-}" ]; then
    missing="${missing}${name} "
  fi
done

environment="${BACKUP_ENVIRONMENT:-unknown}"
if [ -n "$missing" ]; then
  bk_warning "backup of ${environment} skipped: needs ${missing}(LAUNCH.md section C rows 6 and 8); nothing was backed up"
  bk_summary "### Backup ${environment}: SKIPPED"
  bk_summary ""
  bk_summary "Needs ${missing}(LAUNCH.md section C rows 6 and 8). See docs/evidence/ws-8-ops.md, Section E."
  configured=false
else
  bk_log "backup of ${environment}: all inputs present (transport ${transport})"
  configured=true
fi
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  printf 'configured=%s\n' "$configured" >>"$GITHUB_OUTPUT"
fi
printf 'configured=%s\n' "$configured"
