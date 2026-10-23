#!/usr/bin/env bash
# Signed backup metadata (ADR-256). Sourced after common.sh, never executed.
# shellcheck shell=bash
#
# The bucket is not trusted: whoever can write to it (a leaked backup token, a mistake) can also
# write a "newer" backup. What a restore trusts instead is an Ed25519 signature over the metadata
# object, made by the backup service with a key only that service holds
# (BACKUP_SIGNING_KEY, a Railway variable) and checked with the public key committed to this
# repository (infra/backup/signing/<environment>.pub.pem). The metadata carries the archive's key,
# size, SHA-256 and time; the archive is then trusted only when its SHA-256 is the signed one.
#
# Format: BACKUP_SIGNING_KEY is the base64 of the private key as PKCS#8 DER (one line, 64
# characters), made by infra/backup/signing/generate.sh. The signature object
# (<base>.meta.json.sig) is the base64 of the 64 raw signature bytes. OpenSSL 3 is the only tool:
# `openssl pkeyutl -sign|-verify -rawin` is its documented one-shot Ed25519 interface.

# bk_signing_key_file B64 FILE: writes the private key (DER) to FILE, mode 0600. Fails when B64 is not
# a base64 Ed25519 private key.
bk_signing_key_file() {
  local b64=$1 file=$2
  [[ $b64 =~ ^[A-Za-z0-9+/]{64}$ ]] || return 1
  (umask 077 && printf '%s' "$b64" | base64 -d >"$file") 2>/dev/null || return 1
  openssl pkey -inform DER -in "$file" -noout 2>/dev/null || return 1
  openssl pkey -inform DER -in "$file" -text -noout 2>/dev/null | grep -q 'ED25519 Private-Key' || return 1
}

# bk_public_key_of KEYFILE OUTFILE: the PEM public key of a DER private key.
bk_public_key_of() {
  openssl pkey -inform DER -in "$1" -pubout -out "$2" 2>/dev/null
}

# bk_sign FILE KEYFILE SIGFILE: the base64 signature of FILE.
bk_sign() {
  local raw
  raw=$(mktemp)
  if ! openssl pkeyutl -sign -inkey "$2" -keyform DER -rawin -in "$1" -out "$raw" 2>/dev/null; then
    rm -f "$raw"
    return 1
  fi
  base64 -w0 <"$raw" >"$3"
  printf '\n' >>"$3"
  rm -f "$raw"
}

# bk_verify_signature FILE SIGFILE PUBKEY: succeeds when SIGFILE is a valid signature of FILE.
bk_verify_signature() {
  local raw rc=0
  raw=$(mktemp)
  tr -d '[:space:]' <"$2" | base64 -d >"$raw" 2>/dev/null || rc=1
  if [ "$rc" -eq 0 ] && [ "$(wc -c <"$raw" | tr -d ' ')" = 64 ]; then
    openssl pkeyutl -verify -pubin -inkey "$3" -rawin -in "$1" -sigfile "$raw" >/dev/null 2>&1 || rc=1
  else
    rc=1
  fi
  rm -f "$raw"
  return "$rc"
}

# bk_meta_field META NAME: a top-level string or number field of the flat metadata document.
bk_meta_field() {
  grep -m1 "^  \"$2\": " "$1" | sed -E 's/^  "[a-z0-9_]+": *"?([^",]*)"?,?$/\1/'
}

# bk_verify_backup ENVIRONMENT ARCHIVE_KEY META SIG PUBKEY NOW_EPOCH [ARCHIVE_FILE]
# The one place that decides whether a backup is believed. Prints a reason and fails when:
#   - the signature does not verify against the committed public key;
#   - the signed metadata is not for this environment, this archive key, or the time in the key;
#   - the signed time is in the future (more than the allowed clock skew after NOW_EPOCH);
#   - an ARCHIVE_FILE is given and its size or SHA-256 differs from the signed ones.
# On success prints the signed creation time (UTC stamp) and the signed schema version.
bk_verify_backup() {
  local env=$1 key=$2 meta=$3 sig=$4 pub=$5 now=$6 archive=${7:-}
  local m_env m_key m_created m_stamp key_stamp epoch size sha
  [ -f "$pub" ] || { printf 'no public key at %s' "$pub"; return 1; }
  [ -s "$meta" ] && [ -s "$sig" ] || { printf 'the metadata or its signature is missing'; return 1; }
  if ! bk_verify_signature "$meta" "$sig" "$pub"; then
    printf 'the metadata signature does not verify against %s: the object was not written by the backup service' "$pub"
    return 1
  fi
  m_env=$(bk_meta_field "$meta" environment)
  m_key=$(bk_meta_field "$meta" key)
  m_created=$(bk_meta_field "$meta" created_utc)
  [ "$m_env" = "$env" ] || { printf 'signed for environment "%s", not "%s"' "$m_env" "$env"; return 1; }
  [ "$m_key" = "$key" ] || { printf 'signed for the archive "%s", not "%s"' "$m_key" "$key"; return 1; }
  key_stamp=${key##*-}
  key_stamp=${key_stamp%.dump.age}
  m_stamp=$(printf '%s' "$m_created" | tr -d ':-')
  [ "$m_stamp" = "$key_stamp" ] || { printf 'the signed time %s is not the time in the key name' "$m_created"; return 1; }
  epoch=$(bk_stamp_epoch "$key_stamp") || { printf 'the time in the key name is not a real time'; return 1; }
  if [ "$epoch" -gt $((now + BK_CLOCK_SKEW_SECONDS)) ]; then
    printf 'the backup is dated %s, in the future' "$m_created"
    return 1
  fi
  if [ -n "$archive" ]; then
    size=$(bk_meta_field "$meta" size_bytes)
    sha=$(bk_meta_field "$meta" sha256)
    [[ $sha =~ ^[0-9a-f]{64}$ ]] || { printf 'the signed sha256 is malformed'; return 1; }
    [ "$(wc -c <"$archive" | tr -d ' ')" = "$size" ] || { printf 'the archive size differs from the signed %s bytes' "$size"; return 1; }
    [ "$(sha256sum "$archive" | cut -d' ' -f1)" = "$sha" ] || {
      printf 'the archive sha256 differs from the signed one: the object was altered or replaced'
      return 1
    }
  fi
  printf '%s %s' "$key_stamp" "$(grep -o '"schema_version": *"[0-9a-z]*"' "$meta" | grep -o '"[0-9a-z]*"$' | tr -d '"' || true)"
}
