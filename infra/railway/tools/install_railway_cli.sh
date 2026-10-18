#!/usr/bin/env bash
# Install the Railway CLI from its official GitHub release tarball, checked against the SHA-256
# in railway-cli.sha256 next to this script (ADR-185). release.yml checks that pin against
# GitHub's own record of the release asset on every run.
#
# Usage: install_railway_cli.sh <directory>
# Leaves <directory>/railway and prints its version. Never builds from source, never reads a
# cache another job could have written.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
pin="$here/railway-cli.sha256"
dir=${1:?usage: install_railway_cli.sh <directory>}

read -r _ asset <"$pin"
[[ "$asset" =~ ^railway-v([0-9]+\.[0-9]+\.[0-9]+)-x86_64-unknown-linux-musl\.tar\.gz$ ]] ||
  { echo "::error title=Railway CLI::unexpected asset name in $pin"; exit 1; }
version=${BASH_REMATCH[1]}

mkdir -p "$dir"
curl -sSfL --proto '=https' --tlsv1.2 --retry 3 --retry-all-errors -o "$dir/$asset" \
  "https://github.com/railwayapp/cli/releases/download/v$version/$asset"
(cd "$dir" && sha256sum --check --strict "$pin")
tar -xzf "$dir/$asset" -C "$dir" railway
rm -f "$dir/$asset"
installed=$("$dir/railway" --version)
[ "$installed" = "railway $version" ] ||
  { echo "::error title=Railway CLI::expected railway $version, got $installed"; exit 1; }
echo "$installed from $asset (SHA-256 verified)"
