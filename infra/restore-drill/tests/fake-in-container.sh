#!/usr/bin/env bash
# A stand-in for in-container.sh that checks what the real container could do (ADR-255). It is the
# test that would have caught finding M3: live.sh made its scratch directories under umask 077, so
# the container's user (uid 999, the postgres image's user) could neither enter them nor read the
# archive, and the live drill failed on its first real run.
#
#   RD_SCRATCH=DIR RD_IDENTITY=KEY AGE=age [RD_CONTAINER_TMP=DIR] RD_IN_CONTAINER=this-script live.sh ...
#
# A test cannot become another user without root, so this checks the permission bits a different,
# unrelated user would be held to: the "other" triple of every directory from RD_SCRATCH down to
# the archive and of the archive itself, and of the output directory. It also checks that the
# private key reached it in the environment and is not on disk anywhere under the scratch
# directory, then decrypts the archive with it, as restore-local.sh would.
#
# Given a command (as live.sh gives one), it then RUNS it the way the container would: the paths
# /scratch, /tmp/rd-identity.key and /tmp/rd-restore become RD_SCRATCH and files under
# RD_CONTAINER_TMP (the container's own filesystem, outside every directory the runner collects),
# and container-run.sh wraps the command as it does in the image. So a test can look at what a live
# run leaves in the scratch directory, which is what the workflow uploads from (finding HIGH-1).
#
# Output: tab-separated PASS or FAIL lines, and exit 1 when any failed. Without a command, on success
# it writes out/window_ms, as restore-local.sh does.
set -uo pipefail

scratch=${RD_SCRATCH:?RD_SCRATCH is not set}
age=${AGE:-age}
failed=0

pass() { printf 'PASS\t%s\n' "$*"; }
fail() {
  printf 'FAIL\t%s\n' "$*"
  failed=1
}

# other_has PATH BIT: the "other" permission triple of PATH has the bit (4 read, 2 write, 1 search).
other_has() {
  local mode
  mode=$(stat -c %a "$1") || return 1
  (((${mode: -1} & $2) != 0))
}

# can_read FILE: every directory from the scratch directory down is searchable by others, and the
# file is readable by others.
can_read() {
  local file=$1 dir
  dir=$(dirname "$file")
  while :; do
    other_has "$dir" 1 || {
      fail "read: $dir is not searchable by other users (mode $(stat -c %a "$dir"))"
      return 1
    }
    [ "$dir" = "$scratch" ] && break
    dir=$(dirname "$dir")
  done
  other_has "$file" 4 || {
    fail "read: $file is not readable by other users (mode $(stat -c %a "$file"))"
    return 1
  }
  pass "read: other users can open $file"
}

can_read "$scratch/work/backup.dump.age" || true
can_read "$scratch/work/backup.meta.json" || true

# The container writes everything it produces under out/: it needs to enter, list and create there.
for bit in 1 2 4; do
  other_has "$scratch/out" "$bit" ||
    fail "write: $scratch/out is not usable by other users (mode $(stat -c %a "$scratch/out"), missing bit $bit)"
done
[ "$failed" -ne 0 ] || pass "write: other users can create files in out/"

# The private key travels in the environment; nothing under the scratch directory may hold it.
if [ -z "${RD_IDENTITY:-}" ]; then
  fail "key: RD_IDENTITY was not passed"
elif [[ $RD_IDENTITY != *AGE-SECRET-KEY-* ]]; then
  fail "key: RD_IDENTITY does not hold an age private key"
else
  pass "key: passed in the environment"
  if grep -rIlF "AGE-SECRET-KEY-" "$scratch" >/dev/null 2>&1; then
    fail "key: a private key is on disk under $scratch"
  else
    pass "key: no private key on disk under the scratch directory"
  fi
fi

# And it must work: decrypt the archive with the key the way restore-local.sh does.
if [ "$failed" -eq 0 ]; then
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  (umask 077 && printf '%s' "$RD_IDENTITY" >"$work/identity.key")
  if "$age" -d -i "$work/identity.key" -o "$work/plain.dump" "$scratch/work/backup.dump.age" 2>"$work/age.err" &&
    [ "$(head -c 5 "$work/plain.dump")" = PGDMP ]; then
    pass "decrypt: the archive opens to a PostgreSQL archive"
  else
    fail "decrypt: $(tr '\n' ' ' <"$work/age.err")"
  fi
fi

if [ "$#" -gt 0 ]; then
  [ "$failed" -eq 0 ] || exit 1
  tmp=${RD_CONTAINER_TMP:?RD_CONTAINER_TMP is not set}
  repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
  mkdir -p "$tmp"
  mapped=()
  for arg in "$@"; do
    case $arg in
      /scratch | /scratch/*) arg="$scratch${arg#/scratch}" ;;
      /tmp/rd-*) arg="$tmp/${arg#/tmp/}" ;;
    esac
    mapped+=("$arg")
  done
  discard=""
  for dir in ${RD_DISCARD_DIRS:-}; do discard="$discard $tmp/${dir#/tmp/}"; done
  cd "$repo" || exit 1
  RD_IDENTITY_FILE="$tmp/rd-identity.key" RD_SCRATCH_DIR="$scratch" RD_DISCARD_DIRS="$discard" \
    exec "$repo/infra/restore-drill/container-run.sh" "${mapped[@]}"
fi
if [ "$failed" -eq 0 ]; then
  printf '%s\n' 1 >"$scratch/out/window_ms"
  printf 'restore-local\tPASS\n'
else
  printf 'restore-local\tFAIL\n'
fi
exit "$failed"
