#!/usr/bin/env bash
# Shared helpers for the logical backup scripts (ADR-171 to ADR-174). Sourced, never executed.
# shellcheck shell=bash

# --- messages --------------------------------------------------------------------------------
# Plain lines on stderr; GitHub Actions turns the ::level:: forms into annotations on the run.
bk_log() { printf '%s\n' "$*" >&2; }
bk_notice() { printf '::notice::%s\n' "$*" >&2; }
bk_warning() { printf '::warning::%s\n' "$*" >&2; }
bk_error() { printf '::error::%s\n' "$*" >&2; }
bk_die() {
  bk_error "$*"
  exit 1
}

# Appends a line to the job summary when running in Actions; a no-op elsewhere.
bk_summary() {
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    printf '%s\n' "$*" >>"$GITHUB_STEP_SUMMARY"
  fi
}

# bk_require VAR...: dies naming every variable that is unset or empty (never printing values).
bk_require() {
  local absent=() name
  for name in "$@"; do
    if [ -z "${!name:-}" ]; then
      absent+=("$name")
    fi
  done
  if [ "${#absent[@]}" -gt 0 ]; then
    bk_die "missing configuration: ${absent[*]}"
  fi
}

# --- configuration the backup service and the restore tools need ----------------------------------
# The exit code of "this environment is not set up yet", which is neither success nor failure:
# the entrypoint turns it into exit 0 after the script has logged a warning that names every
# missing variable and the LAUNCH.md row that provides it (never silent, never red).
# shellcheck disable=SC2034  # read by the scripts that source this file
BK_EXIT_NOT_CONFIGURED=3

# The LAUNCH.md section C row that provides the backup and drill inputs (ADR-252).
# shellcheck disable=SC2034  # read by the scripts that source this file
BK_LAUNCH_ROW="LAUNCH.md section C row 16"

# R2 credentials come in two sets that no other code uses (ADR-252), named by a prefix:
#   BACKUP_R2  the backup service of one environment: Object Read & Write on that environment's
#              backups bucket only
#   DRILL_R2   the restore drill and an operator restoring: Object Read only on the bucket of the
#              environment being restored (the drill's token: the staging bucket only)
# Each environment has its own bucket and its own backup token, so a token of staging cannot touch
# production's backups (finding M2 of the re-audit). The engine's token (R2_ACCESS_KEY_ID,
# R2_SECRET_ACCESS_KEY) reaches only the evidence bucket and is never read here. The account id
# and the bucket name are identifiers, not secrets.
bk_valid_r2_prefix() {
  [[ ${1:-} == BACKUP_R2 || ${1:-} == DRILL_R2 ]]
}

# bk_is_unset NAME: succeeds when the variable is empty, or is still an unresolved Railway
# reference (`${{shared.X}}`, which is what a service sees when nobody has set X).
bk_is_unset() {
  local value=${!1:-}
  [[ -z $value || $value == *\$\{\{* ]]
}

# bk_missing_r2 PREFIX: prints the names of the variables that are unset, one per line.
bk_missing_r2() {
  local prefix=${1:-} name
  bk_valid_r2_prefix "$prefix" || {
    bk_error "bk_missing_r2 needs BACKUP_R2 or DRILL_R2, not '${prefix}'"
    return 2
  }
  for name in R2_ACCOUNT_ID "${prefix}_ACCESS_KEY_ID" "${prefix}_SECRET_ACCESS_KEY" R2_BUCKET_BACKUPS; do
    if bk_is_unset "$name"; then
      printf '%s\n' "$name"
    fi
  done
}

# --- names -----------------------------------------------------------------------------------
# One bucket per environment (named rampsmith-backups-<env>, ADR-252), one prefix per kind:
#   <env>/daily/<YYYY-MM-DD>/rampsmith-<env>-<YYYYMMDDTHHMMSSZ>.dump.age   (the archive)
#   <env>/daily/<YYYY-MM-DD>/rampsmith-<env>-<YYYYMMDDTHHMMSSZ>.meta.json  (written last)
#   <env>/daily/<YYYY-MM-DD>/rampsmith-<env>-<YYYYMMDDTHHMMSSZ>.meta.json.sig (written second to last)
#   <env>/monthly/<YYYY-MM>/rampsmith-<env>-<YYYYMMDDTHHMMSSZ>.dump.age    (and .meta.json, .meta.json.sig)
# The metadata object is the commit marker: an archive without one is an unfinished upload. Its
# signature (ADR-256) is what a restore trusts; the bucket is not trusted.

bk_valid_environment() {
  [[ ${1:-} =~ ^[a-z][a-z0-9-]{1,30}$ ]]
}

# bk_bucket_matches_environment BUCKET ENVIRONMENT: the bucket is the one named for the
# environment (rampsmith-backups-<env>, or any name ending in -<env>). A staging service pointed at
# production's bucket, or the drill at a bucket that is not staging's, is a configuration error that
# must stop before a byte moves (ADR-252).
bk_bucket_matches_environment() {
  [[ ${1:-} == *"-${2:-}" ]] && [[ -n ${2:-} ]]
}

# --- time --------------------------------------------------------------------------------------
# How far ahead of the clock a timestamp may be before it is not believed: a backup stamped in the
# future would sort newest and be restored, or make retention delete real backups (ADR-256).
BK_CLOCK_SKEW_SECONDS=600

# bk_stamp_epoch STAMP: seconds since the epoch, or failure for a stamp that is not a real UTC time.
bk_stamp_epoch() {
  local s=${1:-} epoch back
  bk_valid_stamp "$s" || return 1
  epoch=$(date -u -d "${s:0:4}-${s:4:2}-${s:6:2} ${s:9:2}:${s:11:2}:${s:13:2} UTC" +%s 2>/dev/null) || return 1
  back=$(date -u -d "@${epoch}" +%Y%m%dT%H%M%SZ 2>/dev/null) || return 1
  [ "$back" = "$s" ] || return 1
  printf '%s' "$epoch"
}

# bk_epoch_stamp EPOCH: the stamp of a time.
bk_epoch_stamp() {
  date -u -d "@${1}" +%Y%m%dT%H%M%SZ
}

# bk_future_limit NOW_EPOCH: the newest stamp believed at that time (now plus the allowed skew).
bk_future_limit() {
  bk_epoch_stamp $((${1} + BK_CLOCK_SKEW_SECONDS))
}

# bk_utc_stamp: the timestamp of this run, YYYYMMDDTHHMMSSZ. BACKUP_NOW overrides it for tests.
bk_utc_stamp() {
  if [ -n "${BACKUP_NOW:-}" ]; then
    printf '%s' "$BACKUP_NOW"
  else
    date -u +%Y%m%dT%H%M%SZ
  fi
}

bk_valid_stamp() {
  [[ ${1:-} =~ ^[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z$ ]]
}

# bk_object_base ENVIRONMENT KIND STAMP: the key without its extension.
#   KIND daily   -> <env>/daily/YYYY-MM-DD/rampsmith-<env>-<stamp>
#   KIND monthly -> <env>/monthly/YYYY-MM/rampsmith-<env>-<stamp>
bk_object_base() {
  local env=$1 kind=$2 stamp=$3 period
  bk_valid_environment "$env" || bk_die "invalid environment name: ${env}"
  bk_valid_stamp "$stamp" || bk_die "invalid timestamp: ${stamp}"
  case $kind in
    daily) period="${stamp:0:4}-${stamp:4:2}-${stamp:6:2}" ;;
    monthly) period="${stamp:0:4}-${stamp:4:2}" ;;
    *) bk_die "unknown backup kind: ${kind}" ;;
  esac
  printf '%s/%s/%s/rampsmith-%s-%s' "$env" "$kind" "$period" "$env" "$stamp"
}

# --- retention ---------------------------------------------------------------------------------
# bk_retention_victims ENVIRONMENT KIND KEEP [LIMIT_STAMP]: reads object keys on stdin (one per line)
# and prints the keys to delete: those of a period older than the KEEP-th newest *complete* period,
# where a period is complete when it holds an archive and its metadata object. The rules, all
# deliberately conservative:
#   - a key that does not match this environment's naming exactly is never a victim;
#   - a key stamped after LIMIT_STAMP (when given) is neither counted nor deleted: an object
#     from the future must not push real backups out of the retention window (ADR-256);
#   - an incomplete period (an unfinished upload) never counts towards KEEP and, while newer than
#     the cutoff, is never deleted;
#   - fewer than KEEP complete periods means nothing is deleted.
bk_retention_victims() {
  local env=$1 kind=$2 keep=$3 limit=${4:-}
  bk_valid_environment "$env" || bk_die "invalid environment name: ${env}"
  case $kind in
    daily | monthly) ;;
    *) bk_die "unknown backup kind: ${kind}" ;;
  esac
  [[ $keep =~ ^[1-9][0-9]*$ ]] || bk_die "retention count must be a positive integer: ${keep}"
  LC_ALL=C awk -v env="$env" -v kind="$kind" -v keep="$keep" -v limit="$limit" '
    BEGIN {
      if (kind == "daily") { period_re = "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]"; plen = 10 }
      else { period_re = "[0-9][0-9][0-9][0-9]-[0-9][0-9]"; plen = 7 }
      # Explicit digit classes, not {n}: the awk of Debian images (mawk) has no interval expressions.
      key_re = "^" env "/" kind "/" period_re "/rampsmith-" env "-[0-9]+T[0-9]+Z\\.(dump\\.age|meta\\.json|meta\\.json\\.sig)$"
    }
    $0 ~ key_re {
      key = $0
      prefix = env "/" kind "/"
      period = substr(key, length(prefix) + 1, plen)
      # The period in the directory must agree with the timestamp in the file name.
      stamp = key; sub(/^.*-/, "", stamp); sub(/\..*$/, "", stamp)
      if (length(stamp) != 16) next
      if (limit != "" && stamp > limit) next
      want = (kind == "daily") ? substr(stamp, 1, 4) "-" substr(stamp, 5, 2) "-" substr(stamp, 7, 2) \
                               : substr(stamp, 1, 4) "-" substr(stamp, 5, 2)
      if (want != period) next
      base = key; sub(/\.(dump\.age|meta\.json\.sig|meta\.json)$/, "", base)
      keys[key] = period
      if (key ~ /\.dump\.age$/) dump[base] = period
      if (key ~ /\.meta\.json$/) meta[base] = period
    }
    END {
      for (base in meta) if (base in dump) complete[meta[base]] = 1
      n = 0
      for (p in complete) periods[++n] = p
      # Sort the complete periods, newest first (ISO dates sort as text).
      for (i = 2; i <= n; i++) {
        v = periods[i]; j = i - 1
        while (j >= 1 && periods[j] < v) { periods[j + 1] = periods[j]; j-- }
        periods[j + 1] = v
      }
      if (n < keep) exit
      cutoff = periods[keep]
      for (key in keys) if (keys[key] < cutoff) print key
    }' | LC_ALL=C sort
}

# bk_backups ENVIRONMENT KIND LIMIT_STAMP: reads object keys on stdin and prints one line per backup
# archive, tab separated: stamp, archive key, status. Newest first, ordered by the *parsed* timestamp
# in the file name and not by the key's text, so a key placed in another directory cannot jump the
# queue. Statuses:
#   complete    archive, metadata object and signature exist; the directory agrees with the stamp
#   incomplete  the archive has no metadata object or no signature (an unfinished upload, or a
#               backup made before signatures existed): never restored
#   future      the stamp is later than LIMIT_STAMP: not believed, never restored (ADR-256)
#   misfiled    the directory does not agree with the stamp: not believed, never restored
# Keys that do not match the environment's naming are ignored.
bk_backups() {
  local env=$1 kind=$2 limit=$3
  bk_valid_environment "$env" || bk_die "invalid environment name: ${env}"
  case $kind in
    daily | monthly) ;;
    *) bk_die "unknown backup kind: ${kind}" ;;
  esac
  bk_valid_stamp "$limit" || bk_die "invalid time limit: ${limit}"
  LC_ALL=C awk -v env="$env" -v kind="$kind" -v limit="$limit" '
    BEGIN {
      if (kind == "daily") { period_re = "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]"; plen = 10 }
      else { period_re = "[0-9][0-9][0-9][0-9]-[0-9][0-9]"; plen = 7 }
      key_re = "^" env "/" kind "/" period_re "/rampsmith-" env "-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z\\.(dump\\.age|meta\\.json|meta\\.json\\.sig)$"
    }
    $0 ~ key_re {
      key = $0
      prefix = env "/" kind "/"
      period = substr(key, length(prefix) + 1, plen)
      stamp = key; sub(/^.*-/, "", stamp); sub(/\..*$/, "", stamp)
      base = key; sub(/\.(dump\.age|meta\.json\.sig|meta\.json)$/, "", base)
      stampof[base] = stamp; periodof[base] = period
      if (key ~ /\.dump\.age$/) dump[base] = 1
      else if (key ~ /\.meta\.json\.sig$/) sig[base] = 1
      else meta[base] = 1
    }
    END {
      for (base in dump) {
        stamp = stampof[base]
        want = (kind == "daily") ? substr(stamp, 1, 4) "-" substr(stamp, 5, 2) "-" substr(stamp, 7, 2) \
                                 : substr(stamp, 1, 4) "-" substr(stamp, 5, 2)
        if (stamp > limit) status = "future"
        else if (want != periodof[base]) status = "misfiled"
        else if ((base in meta) && (base in sig)) status = "complete"
        else status = "incomplete"
        printf "%s\t%s.dump.age\t%s\n", stamp, base, status
      }
    }' | LC_ALL=C sort -t "$(printf '\t')" -k1,1r -k2,2r
}

# bk_newest_complete ENVIRONMENT KIND LIMIT_STAMP < keys: the key of the newest backup archive that is
# complete and not from the future, or nothing.
bk_newest_complete() {
  bk_backups "$1" "$2" "$3" | awk -F'\t' '$3 == "complete" { print $2; exit }'
}

# bk_period_exists ENVIRONMENT KIND STAMP < keys: succeeds when a complete backup of the stamp's
# period already exists in the listing on stdin (used to decide on the monthly copy).
bk_period_complete() {
  local env=$1 kind=$2 stamp=$3 prefix
  prefix=$(bk_object_base "$env" "$kind" "$stamp")
  prefix=${prefix%/*}/
  awk -v prefix="$prefix" '
    index($0, prefix) == 1 && $0 ~ /\.meta\.json$/ { found = 1 }
    END { exit found ? 0 : 1 }'
}

# --- recipients --------------------------------------------------------------------------------
# bk_write_recipients TEXT FILE: validates the age recipients and writes them to FILE. Only
# public recipients are accepted. A private key in this variable would put it in CI, which
# the design forbids, so it is refused outright.
bk_write_recipients() {
  local text=$1 file=$2 count=0 pq=0 line
  case $text in
    *AGE-SECRET-KEY-* | *AGE-PLUGIN-*)
      bk_die "BACKUP_AGE_RECIPIENTS holds a private key; it must hold only public recipients (age1...)"
      ;;
  esac
  : >"$file"
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%%#*}
    line=$(printf '%s' "$line" | tr -d '[:space:]')
    [ -n "$line" ] || continue
    if [[ ! $line =~ ^age1[0-9a-z]{50,}$ ]]; then
      bk_die "BACKUP_AGE_RECIPIENTS has an entry that is not an age public key"
    fi
    printf '%s\n' "$line" >>"$file"
    count=$((count + 1))
    if [[ $line == age1pq1* ]]; then pq=$((pq + 1)); fi
  done <<<"$text"
  # age v1.3 refuses to encrypt to post-quantum and classic recipients at once, because the
  # file would only be as strong as the classic one. Say so before the dump runs.
  if [ "$pq" -gt 0 ] && [ "$pq" -lt "$count" ]; then
    bk_die "BACKUP_AGE_RECIPIENTS mixes post-quantum (age1pq1...) and classic (age1...) recipients; age refuses both in one file, so use one kind for every recipient"
  fi
  if [ "$count" -lt 1 ]; then
    bk_die "BACKUP_AGE_RECIPIENTS holds no recipient"
  fi
  if [ "$count" -lt 2 ]; then
    bk_warning "BACKUP_AGE_RECIPIENTS holds one recipient: losing that key loses every backup; add a second, offline recipient"
  fi
}

# A short fingerprint of the recipient list, recorded in the metadata so a restore can tell
# which key it needs without trying them all.
bk_recipients_fingerprint() {
  LC_ALL=C sort "$1" | sha256sum | cut -c1-16
}
