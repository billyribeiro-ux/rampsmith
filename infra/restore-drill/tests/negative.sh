#!/usr/bin/env bash
# Proves the restore drill can fail (ADR-175). Runs drill.sh once as a control and once per
# injected fault; the control must pass, and every fault must make the drill exit non-zero with
# the message that names it. A drill that cannot fail proves nothing.
#
#   negative.sh [--out DIR] [--only FAULT]
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRILL="$DIR/../drill.sh"
out=""
only=""
while [ "$#" -gt 0 ]; do
  case $1 in
    --out) out=$2; shift 2 ;;
    --only) only=$2; shift 2 ;;
    *) printf 'ERROR: unknown argument: %s\n' "$1" >&2; exit 1 ;;
  esac
done
[ -n "$out" ] || out=$(mktemp -d)
mkdir -p "$out"

# name | environment assignments | extended regular expression the output must contain
# (fields are separated by `|`; tabs in the expression are written as \t).
cases=(
  "control||drill\tPASS"
  "tamper-manifest-checksum|DRILL_FAULT=tamper-manifest-checksum|FAIL\tchanged\ttable\tpublic\.findings\tchecksum"
  "tamper-data|DRILL_FAULT=tamper-data|FAIL\tchanged\ttable\tpublic\.findings\tchecksum"
  "drop-policy|DRILL_FAULT=drop-policy|FAIL\tmissing\tobject\tpolicy\tpublic\.findings\."
  "disable-rls|DRILL_FAULT=disable-rls|FAIL\tchanged\ttable\tpublic\.sites\trls"
  "drop-table|DRILL_FAULT=drop-table|FAIL\tmissing\ttable\tpublic\.audit_log\t"
  "truncate-table|DRILL_FAULT=truncate-table|FAIL\tchanged\ttable\tpublic\.audit_log\trows"
  "drop-grant|DRILL_FAULT=drop-grant|FAIL\tchanged\ttable\tpublic\.sites\tprivileges"
  "stale-backup|DRILL_FAULT=stale-backup|FAIL\tschema-version"
  "corrupt-ciphertext|DRILL_FAULT=corrupt-ciphertext|archive sha256 differs from the signed one"
  "wrong-key|DRILL_FAULT=wrong-key|age could not decrypt the archive"
  "skip-bootstrap|DRILL_FAULT=skip-bootstrap|cannot connect to the server as rampsmith_migrator"
  "nonempty-target|DRILL_FAULT=nonempty-target|already holds [0-9]+ objects"
  "no-bypassrls|DRILL_FAULT=no-bypassrls|pg_dump failed"
  "tampered-signature|DRILL_FAULT=tampered-signature|signature does not verify"
  "wrong-signing-key|DRILL_FAULT=wrong-signing-key|signature does not verify"
  "future-backup|DRILL_FAULT=future-backup|in the future"
  "foreign-schema|DRILL_FAULT=foreign-schema|not objects of the application schema"
  "superuser-restore|DRILL_FAULT=superuser-restore|restore as rampsmith_migrator"
  "rto-exceeded|RTO_TARGET_SECONDS=0|FAIL\trto\tthe restore took"
)

failed=0
ran=0
index=0
for entry in "${cases[@]}"; do
  IFS='|' read -r name assignment pattern <<<"$entry"
  index=$((index + 1))
  if [ -n "$only" ] && [ "$only" != "$name" ]; then continue; fi
  ran=$((ran + 1))
  log="$out/$name.txt"
  rc=0
  # shellcheck disable=SC2086  # the assignment is a single NAME=value word, or empty
  env $assignment DRILL_PORT_BASE=$((54800 + index * 4)) \
    "$DRILL" --out "$out/$name" >"$log" 2>&1 || rc=$?
  pattern=${pattern//\\t/$'\t'}
  if [ "$name" = "control" ]; then
    if [ "$rc" -eq 0 ] && grep -Eq -- "$pattern" "$log"; then
      printf 'PASS\t%s\tthe unmodified drill passes\n' "$name"
    else
      printf 'FAIL\t%s\tthe control drill must pass (exit %s); see %s\n' "$name" "$rc" "$log"
      failed=$((failed + 1))
    fi
  elif [ "$rc" -ne 0 ] && grep -Eq -- "$pattern" "$log"; then
    printf 'PASS\t%s\tthe drill failed (exit %s) and named the fault\n' "$name" "$rc"
  elif [ "$rc" -eq 0 ]; then
    printf 'FAIL\t%s\tthe drill PASSED with the fault injected; see %s\n' "$name" "$log"
    failed=$((failed + 1))
  else
    printf 'FAIL\t%s\tthe drill failed (exit %s) but not with the expected message; see %s\n' "$name" "$rc" "$log"
    failed=$((failed + 1))
  fi
done

printf 'negative\t%s cases, %s failed\n' "$ran" "$failed"
[ "$failed" -eq 0 ] && [ "$ran" -gt 0 ]
