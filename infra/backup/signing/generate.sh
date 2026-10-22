#!/usr/bin/env bash
# Makes the signing key pair of one environment's backups (ADR-256).
#
#   infra/backup/signing/generate.sh --environment staging --private-out ~/rampsmith-vault/staging-signing.key
#
# - The PRIVATE key is written, as one line of base64, to --private-out (mode 0600). That line is
#   the value of the Railway variable BACKUP_SIGNING_KEY of that environment (sealed). It is refused
#   a path inside this repository, and it is never printed.
# - The PUBLIC key is written to infra/backup/signing/<environment>.pub.pem. Commit it: a restore
#   (the weekly drill, the runbook) verifies every backup against that file, so a change to it is a
#   reviewed change to what the restore trusts.
# - An existing public key is not replaced unless --rotate is given. Rotating means every backup
#   signed with the old key stops verifying: keep the old public key as <environment>.pub.pem until
#   you no longer need those backups, or restore them first.
set -euo pipefail
umask 077

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$DIR/../../.." && pwd)"
environment=""
private_out=""
rotate=0
while [ "$#" -gt 0 ]; do
  case $1 in
    --environment) environment=${2:-}; shift 2 ;;
    --private-out) private_out=${2:-}; shift 2 ;;
    --rotate) rotate=1; shift ;;
    *) echo "ERROR: unknown argument: $1" >&2; exit 1 ;;
  esac
done
[[ $environment =~ ^[a-z][a-z0-9-]{1,30}$ ]] || { echo "ERROR: --environment must be an environment name such as production" >&2; exit 1; }
[ -n "$private_out" ] || { echo "ERROR: --private-out FILE is required (outside this repository)" >&2; exit 1; }
case "$(realpath -m "$private_out")/" in
  "$REPO"/*) echo "ERROR: --private-out is inside the repository; the private key must never be committed" >&2; exit 1 ;;
esac
[ ! -e "$private_out" ] || { echo "ERROR: $private_out exists; choose a new file" >&2; exit 1; }
public="$DIR/${environment}.pub.pem"
if [ -e "$public" ] && [ "$rotate" -ne 1 ]; then
  echo "ERROR: $public exists; pass --rotate to replace it (see the notes at the top of this script)" >&2
  exit 1
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
openssl genpkey -algorithm ed25519 -outform DER -out "$work/key.der" 2>/dev/null
openssl pkey -inform DER -in "$work/key.der" -pubout -out "$work/pub.pem" 2>/dev/null
base64 -w0 <"$work/key.der" >"$work/key.b64"
[ "$(wc -c <"$work/key.b64" | tr -d ' ')" = 64 ] || { echo "ERROR: unexpected key length" >&2; exit 1; }
cp "$work/key.b64" "$private_out"
chmod 600 "$private_out"
cp "$work/pub.pem" "$public"
chmod 644 "$public"
echo "wrote the private key to $private_out (the value of BACKUP_SIGNING_KEY for ${environment}; keep it in the vault, then set it as a sealed Railway variable)"
echo "wrote the public key to ${public#"$REPO"/}: commit it"
