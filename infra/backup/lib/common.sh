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

# --- configuration the nightly job needs ---------------------------------------------------------
# The exit code of "this environment is not set up yet", which is neither success nor failure:
# the workflow turns it into a skip notice naming the LAUNCH.md section C rows (never silent).
# shellcheck disable=SC2034  # read by the scripts that source this file
BK_EXIT_NOT_CONFIGURED=3

# The names that LAUNCH.md section C row 6 (R2) must provide, and what the job itself needs.
BK_R2_VARIABLES=(R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET_BACKUPS)

# bk_missing_r2: prints the names of the R2 variables that are unset or empty, one per line.
bk_missing_r2() {
  local name
  for name in "${BK_R2_VARIABLES[@]}"; do
    if [ -z "${!name:-}" ]; then
      printf '%s\n' "$name"
    fi
  done
}

# --- names -----------------------------------------------------------------------------------
# One bucket, one prefix per environment:
#   <env>/daily/<YYYY-MM-DD>/rampsmith-<env>-<YYYYMMDDTHHMMSSZ>.dump.age   (the archive)
#   <env>/daily/<YYYY-MM-DD>/rampsmith-<env>-<YYYYMMDDTHHMMSSZ>.meta.json  (written last)
#   <env>/monthly/<YYYY-MM>/rampsmith-<env>-<YYYYMMDDTHHMMSSZ>.dump.age    (and .meta.json)
# The metadata object is the commit marker: an archive without one is an unfinished upload.

bk_valid_environment() {
  [[ ${1:-} =~ ^[a-z][a-z0-9-]{1,30}$ ]]
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
  [[ ${1:-} =~ ^[0-9]{8}T[0-9]{6}Z$ ]]
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
# bk_retention_victims ENVIRONMENT KIND KEEP: reads object keys on stdin (one per line) and prints
# the keys to delete: those of a period older than the KEEP-th newest *complete* period, where
# a period is complete when it holds an archive and its metadata object. The rules, all
# deliberately conservative:
#   - a key that does not match this environment's naming exactly is never a victim;
#   - an incomplete period (an unfinished upload) never counts towards KEEP and, while newer than
#     the cutoff, is never deleted;
#   - fewer than KEEP complete periods means nothing is deleted.
bk_retention_victims() {
  local env=$1 kind=$2 keep=$3
  bk_valid_environment "$env" || bk_die "invalid environment name: ${env}"
  case $kind in
    daily | monthly) ;;
    *) bk_die "unknown backup kind: ${kind}" ;;
  esac
  [[ $keep =~ ^[1-9][0-9]*$ ]] || bk_die "retention count must be a positive integer: ${keep}"
  LC_ALL=C awk -v env="$env" -v kind="$kind" -v keep="$keep" '
    BEGIN {
      if (kind == "daily") { period_re = "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]"; plen = 10 }
      else { period_re = "[0-9][0-9][0-9][0-9]-[0-9][0-9]"; plen = 7 }
      key_re = "^" env "/" kind "/" period_re "/rampsmith-" env "-[0-9]+T[0-9]+Z\\.(dump\\.age|meta\\.json)$"
    }
    $0 ~ key_re {
      key = $0
      prefix = env "/" kind "/"
      period = substr(key, length(prefix) + 1, plen)
      # The period in the directory must agree with the timestamp in the file name.
      stamp = key; sub(/^.*-/, "", stamp); sub(/\..*$/, "", stamp)
      if (length(stamp) != 16) next
      want = (kind == "daily") ? substr(stamp, 1, 4) "-" substr(stamp, 5, 2) "-" substr(stamp, 7, 2) \
                               : substr(stamp, 1, 4) "-" substr(stamp, 5, 2)
      if (want != period) next
      base = key; sub(/\.(dump\.age|meta\.json)$/, "", base)
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
