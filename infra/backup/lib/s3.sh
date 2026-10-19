#!/usr/bin/env bash
# The S3 calls the backup scripts make against Cloudflare R2 (ADR-172). Sourced, never executed.
# shellcheck shell=bash
#
# Only operations that R2's S3 API supports are used: PutObject (multipart through `aws s3 cp`),
# GetObject, HeadObject, ListObjectsV2 and DeleteObject. The AWS CLI is `aws`; tests replace it
# with a script (AWS_BIN) that serves a directory, so the same code runs in the unit tests, in
# the restore drill and in production.

AWS_BIN="${AWS_BIN:-aws}"

# s3_init PREFIX: points the AWS CLI at R2 with one of the two credential sets (see common.sh):
#   BACKUP_R2  BACKUP_R2_ACCESS_KEY_ID, BACKUP_R2_SECRET_ACCESS_KEY  (the backup service)
#   DRILL_R2   DRILL_R2_ACCESS_KEY_ID, DRILL_R2_SECRET_ACCESS_KEY    (the drill, an operator restoring)
# plus R2_ACCOUNT_ID and R2_BUCKET_BACKUPS, which are identifiers. The engine's R2_ACCESS_KEY_ID
# and R2_SECRET_ACCESS_KEY are never read: that token reaches the evidence bucket only (ADR-091).
#   endpoint   https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com (R2_ENDPOINT_URL overrides it,
#              for the EU jurisdiction or a test double)
#   region     auto
#   checksums  `when_required`. botocore (the AWS CLI engine) defaults both settings to
#              `when_supported`, which adds a checksum to every upload and validates every
#              download. R2's documentation lists the algorithms it accepts, not that default
#              streaming behaviour, so the scripts ask for checksums only where an operation
#              needs one and verify integrity themselves: size from HeadObject and the sha256 of
#              a re-download (backup.sh). Whether the default would also work is not checked
#              against a live bucket (ADR-172, Section E).
s3_init() {
  local prefix=${1:-} key_var secret_var
  bk_valid_r2_prefix "$prefix" || bk_die "s3_init needs the credential set BACKUP_R2 or DRILL_R2"
  key_var="${prefix}_ACCESS_KEY_ID"
  secret_var="${prefix}_SECRET_ACCESS_KEY"
  bk_require "$key_var" "$secret_var" R2_BUCKET_BACKUPS
  if [ -z "${R2_ENDPOINT_URL:-}" ]; then
    bk_require R2_ACCOUNT_ID
    if [[ ! $R2_ACCOUNT_ID =~ ^[0-9a-f]{32}$ ]]; then
      bk_die "R2_ACCOUNT_ID is not a 32-character hexadecimal account id"
    fi
    S3_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
  else
    S3_ENDPOINT=$R2_ENDPOINT_URL
  fi
  if [[ ! $R2_BUCKET_BACKUPS =~ ^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$ ]]; then
    bk_die "R2_BUCKET_BACKUPS is not a valid bucket name"
  fi
  S3_BUCKET=$R2_BUCKET_BACKUPS
  export AWS_ACCESS_KEY_ID=${!key_var}
  export AWS_SECRET_ACCESS_KEY=${!secret_var}
  export AWS_DEFAULT_REGION=auto
  export AWS_REQUEST_CHECKSUM_CALCULATION=when_required
  export AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
  export AWS_EC2_METADATA_DISABLED=true
  export AWS_PAGER=""
  unset AWS_SESSION_TOKEN AWS_PROFILE
  S3_READY=1
}

s3_aws() {
  [ "${S3_READY:-0}" = "1" ] || bk_die "s3_init has not run"
  "$AWS_BIN" --endpoint-url "$S3_ENDPOINT" "$@"
}

# s3_put LOCAL_FILE KEY
s3_put() {
  s3_aws s3 cp "$1" "s3://${S3_BUCKET}/$2" --only-show-errors --no-progress
}

# s3_get KEY LOCAL_FILE
s3_get() {
  s3_aws s3 cp "s3://${S3_BUCKET}/$1" "$2" --only-show-errors --no-progress
}

# s3_cat KEY: the object's bytes on stdout.
s3_cat() {
  s3_aws s3 cp "s3://${S3_BUCKET}/$1" - --only-show-errors --no-progress
}

# s3_size KEY: the object's size in bytes, from HeadObject.
s3_size() {
  s3_aws s3api head-object --bucket "$S3_BUCKET" --key "$1" --query ContentLength --output text
}

# s3_list PREFIX: every key under the prefix, one per line, across all pages. An empty bucket
# prints nothing. The AWS CLI prints "None" for an empty result and joins values with tabs.
s3_list() {
  local out
  out=$(s3_aws s3api list-objects-v2 --bucket "$S3_BUCKET" --prefix "$1" \
    --query 'Contents[].Key' --output text) || return 1
  printf '%s\n' "$out" | tr '\t' '\n' | awk 'NF && $0 != "None"'
}

# s3_delete KEY
s3_delete() {
  s3_aws s3 rm "s3://${S3_BUCKET}/$1" --only-show-errors
}
