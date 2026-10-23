#!/usr/bin/env bash
# A stand-in for the `aws` command that serves a directory as an S3 bucket (ADR-171).
#
# The backup scripts only use five calls (s3 cp, s3 rm, s3api head-object, s3api list-objects-v2),
# so a directory is enough to run them end to end in tests and in the restore drill. It also
# checks what the real client would be told about R2: an endpoint, region `auto` and the
# `when_required` checksum settings that R2 needs.
#
#   FAKE_S3_ROOT   directory holding one subdirectory per bucket (required)
#   FAKE_AWS_LOG   file that receives one line per call (optional)
#   FAKE_AWS_FAULT  one of: put-fail, put-truncate, put-corrupt, get-corrupt, list-fail,
#                   head-fail, rm-fail; limited to keys matching FAKE_AWS_FAULT_KEY (a glob)
#   FAKE_AWS_WRITE_KEY      when set, the access key id of a token that covers the bucket with
#                           Object Read & Write; any other key id is refused (403 AccessDenied), as
#                           R2 refuses a token scoped to other buckets (ADR-252)
#   FAKE_AWS_READ_KEY       the access key id of an Object Read only token on the same bucket: it
#                           may get, head and list, and is refused every write and delete
set -euo pipefail

root=${FAKE_S3_ROOT:?FAKE_S3_ROOT is not set}
log() {
  if [ -n "${FAKE_AWS_LOG:-}" ]; then printf '%s\n' "$*" >>"$FAKE_AWS_LOG"; fi
}
fail() {
  printf 'fake-aws: %s\n' "$*" >&2
  exit 1
}

endpoint=""
if [ "${1:-}" = "--endpoint-url" ]; then
  endpoint=$2
  shift 2
fi
[ -n "$endpoint" ] || fail "no --endpoint-url: R2 needs one"
[ "${AWS_DEFAULT_REGION:-}" = "auto" ] || fail "AWS_DEFAULT_REGION must be auto for R2"
[ "${AWS_REQUEST_CHECKSUM_CALCULATION:-}" = "when_required" ] || fail "AWS_REQUEST_CHECKSUM_CALCULATION must be when_required for R2"
[ "${AWS_RESPONSE_CHECKSUM_VALIDATION:-}" = "when_required" ] || fail "AWS_RESPONSE_CHECKSUM_VALIDATION must be when_required for R2"
[ -n "${AWS_ACCESS_KEY_ID:-}" ] && [ -n "${AWS_SECRET_ACCESS_KEY:-}" ] || fail "no credentials"

# Token scopes, as R2 documents them: a token that does not cover the bucket, and a read-only
# token that tries to write, both get 403 AccessDenied (error code 10003).
if [ -n "${FAKE_AWS_WRITE_KEY:-}" ] && [ "$AWS_ACCESS_KEY_ID" != "$FAKE_AWS_WRITE_KEY" ] &&
  [ "$AWS_ACCESS_KEY_ID" != "${FAKE_AWS_READ_KEY:-}" ]; then
  fail "AccessDenied (403): this token does not cover the bucket"
fi
may_write() {
  [ -z "${FAKE_AWS_READ_KEY:-}" ] || [ "$AWS_ACCESS_KEY_ID" != "$FAKE_AWS_READ_KEY" ] ||
    fail "AccessDenied (403): this token is read only"
}

fault=${FAKE_AWS_FAULT:-}
fault_key=${FAKE_AWS_FAULT_KEY:-*}
# Writes $1 to stdout with byte 101 flipped (XOR 0xFF), never replaced by a fixed value: an
# encrypted archive has a 1 in 256 chance of already holding any fixed byte there, which made the
# "corrupted read-back" case flaky.
corrupt() {
  local original flipped octal
  original=$(dd if="$1" bs=1 skip=100 count=1 2>/dev/null | od -An -tu1 | tr -d ' ')
  [ -n "$original" ] || fail "corrupt: $1 is shorter than 101 bytes"
  flipped=$((original ^ 255))
  octal=$(printf '%03o' "$flipped")
  head -c 100 "$1"
  printf '%b' "\\0${octal}"
  tail -c +102 "$1"
}

faulty() {
  # faulty KIND KEY: succeeds when the fault applies to this call.
  # shellcheck disable=SC2254
  [ "$fault" = "$1" ] && case $2 in $fault_key) return 0 ;; esac
  return 1
}

path_of() {
  # path_of s3://bucket/key -> file path; refuses anything that climbs out of the bucket
  local uri=${1#s3://} bucket key
  bucket=${uri%%/*}
  key=${uri#*/}
  case $key in *..*) fail "key escapes the bucket: $key" ;; esac
  printf '%s/%s/%s' "$root" "$bucket" "$key"
}

cmd=${1:-}
sub=${2:-}
shift 2 || true

case "$cmd $sub" in
  "s3 cp")
    src=$1 dst=$2
    case $src in
      s3://*)
        key=${src#s3://*/}
        log "get $key"
        file=$(path_of "$src")
        [ -f "$file" ] || fail "NoSuchKey: $key"
        if [ "$dst" = "-" ]; then
          if faulty get-corrupt "$key"; then
            corrupt "$file"
          else
            cat "$file"
          fi
        else
          cp "$file" "$dst"
        fi
        ;;
      *)
        key=${dst#s3://*/}
        log "put $key"
        may_write
        faulty put-fail "$key" && fail "AccessDenied: $key"
        file=$(path_of "$dst")
        mkdir -p "$(dirname "$file")"
        if faulty put-truncate "$key"; then
          head -c 10 "$src" >"$file"
        elif faulty put-corrupt "$key"; then
          corrupt "$src" >"$file"
        else
          cp "$src" "$file"
        fi
        ;;
    esac
    ;;
  "s3 rm")
    key=${1#s3://*/}
    log "delete $key"
    may_write
    faulty rm-fail "$key" && fail "AccessDenied: delete $key"
    rm -f "$(path_of "$1")"
    ;;
  "s3api head-object")
    bucket="" key=""
    while [ "$#" -gt 0 ]; do
      case $1 in
        --bucket) bucket=$2; shift 2 ;;
        --key) key=$2; shift 2 ;;
        --query | --output) shift 2 ;;
        *) fail "unexpected head-object argument: $1" ;;
      esac
    done
    log "head $key"
    faulty head-fail "$key" && fail "head-object failed"
    file="$root/$bucket/$key"
    [ -f "$file" ] || fail "NotFound: $key"
    wc -c <"$file" | tr -d ' '
    ;;
  "s3api list-objects-v2")
    bucket="" prefix=""
    while [ "$#" -gt 0 ]; do
      case $1 in
        --bucket) bucket=$2; shift 2 ;;
        --prefix) prefix=$2; shift 2 ;;
        --query | --output) shift 2 ;;
        *) fail "unexpected list-objects-v2 argument: $1" ;;
      esac
    done
    log "list $prefix"
    faulty list-fail "$prefix" && fail "list failed"
    dir="$root/$bucket"
    if [ ! -d "$dir" ]; then
      printf 'None\n'
      exit 0
    fi
    keys=$(cd "$dir" && find . -type f | sed 's|^\./||' | LC_ALL=C sort | awk -v p="$prefix" 'index($0, p) == 1')
    if [ -z "$keys" ]; then
      printf 'None\n'
    else
      # The real CLI prints text output as tab-separated values on one line.
      printf '%s\n' "$keys" | paste -sd '\t' -
    fi
    ;;
  *) fail "unsupported call: $cmd $sub" ;;
esac
