# ADR-153: `rsctl keys`, the master-key tools

- Status: Accepted
- Date: 2026-10-19

## Context

ADR-021 defines the master key ring: `RAMPSMITH_MASTER_KEYS` is `id:base64key[,id:base64key…]`,
newest first; the first key seals, every key opens; rotation prepends a key, re-wraps old values
with `KeyRing::rewrap`, then drops the old key. LAUNCH.md row 12 says the founder generates the
ring with `rsctl keys generate`, once for `production` and once for `staging`
(`docs/FOUNDER_SETUP.md`). The master-key rotation runbook (PLAN §22) needs commands for the
rotate and drop steps. Nothing in the repository could produce or change a ring until now.

The tool handles key material, so the same rule as ADR-151 applies: key bytes appear only in the
one place the operator asked for them.

## Decision

1. The format is `crates/crypto`'s, not a copy of it. `rsctl` never decodes a key. New key bytes
   come from `KeyRing::generate_master_key` (32 bytes from the operating system's random source,
   unpadded standard base64: 43 characters), and every ring `rsctl` returns is parsed back with
   `KeyRing::parse` before it is printed. If `crypto` accepts a ring, so does the service; if
   `crypto` changes the format, `rsctl` follows it.
2. Key ids follow `crypto::KeyId`: 1 to 32 characters of `a-z`, `0-9`, `-` and `_`. The default id
   is `k` and the UTC date (`k20261019`), so ids are not reused. A rotation without `--id` that
   clashes with an existing id (a second rotation on the same day) takes `-2`, `-3`, ...; an
   explicit `--id` that clashes is refused.
3. Commands:
   - `rsctl keys generate [--id ID] [--output FILE]` prints a ring with one fresh key.
   - `rsctl keys rotate [--id ID] [--stdin] [--output FILE]` prints the current ring with a fresh
     key first. Every old entry is kept exactly as given, so values sealed under it still open.
   - `rsctl keys drop --id ID... [--stdin] [--output FILE]` prints the current ring without the
     named old keys. The active (first) key cannot be dropped, and an id that is not in the ring
     is refused.
   - `rsctl keys ids [--stdin]` prints the ids, newest first. Ids are not secret.
4. The current ring comes from `--stdin` (the first non-empty line) or from the
   `RAMPSMITH_MASTER_KEYS` variable; it is never a command-line argument, because arguments
   appear in process listings and shell history. With neither, the command says how to supply one
   (exit 2).
5. The new ring goes to standard output with a trailing newline, or, with `--output FILE`, to a
   new file created with mode 0600 and `create_new`: `rsctl` never overwrites a key file. An
   explanatory note goes to standard error, so `rsctl keys generate | pbcopy` or
   `... > file` captures the ring and only the ring. `generate` prints the ring once and keeps it
   nowhere else.
6. Messages never contain key bytes. The ring read from the environment or standard input is held
   in `Zeroizing` memory and registered, with each key in it, with the command's redactor; the
   error for a malformed ring is `crypto`'s own, which names no key bytes. `tests/redaction.rs`
   and `tests/keys_cli.rs` check this by feeding rings broken in several ways and asserting the
   output holds none of the key text.
7. Exit codes: 0 done; 1 refused (a ring that does not parse, a bad or duplicate or unknown id, an
   attempt to drop the active key); 2 could not run (no ring supplied, standard input empty, the
   output file exists or cannot be written, a usage error).

### Master-key rotation, for the runbook

The runbook (`docs/runbooks/`, written by another stream) can use these steps and commands.

1. Keep the current ring safe first: it is in the Railway variable and in the founder's password
   manager. Rotating changes nothing until a ring is deployed.
2. Make the new ring. Pipe the current one in, so it never touches the shell history:
   `printf '%s' "$RAMPSMITH_MASTER_KEYS" | rsctl keys rotate --stdin --output new-ring.txt`.
   The output is `new:base64key,old:base64key,...`: the fresh key first, every old key after it.
   `rsctl keys ids --stdin < new-ring.txt` lists the ids to confirm the order.
3. Store the new ring in the password manager, then set it as `RAMPSMITH_MASTER_KEYS` for the
   environment (staging first) and redeploy `api` and `ctl`. New values are sealed under the new
   key; values sealed under an old key still open. Run `rsctl doctor --row 12` with the new ring
   in the environment: it parses the ring and round-trips every key.
4. Re-wrap what the old key sealed with `KeyRing::rewrap` (ADR-021): the value is not decrypted,
   only its data key is re-wrapped. At the time of this ADR no job in the repository walks the
   stored rows and calls it (`crates/crypto` provides the function; nothing calls it), so until
   that job exists the old keys must stay in the ring. This is recorded as an integration note in
   `docs/evidence/ws-6-rsctl.md`.
5. When nothing is sealed under an old key any more, remove it:
   `... | rsctl keys drop --stdin --id <old id>`, store the result, set it, redeploy. Dropping a
   key that still wraps a value makes that value unreadable, and `rsctl` cannot see the database,
   so confirming it is the operator's step.
6. After a suspected leak of a key: rotate (steps 2 and 3), re-wrap (4), drop (5), in that order,
   and treat database backups taken while the leaked key was in use as readable by whoever has
   that key.

## Consequences

- The founder's one command, `rsctl keys generate`, produces a ring the service accepts, and the
  tests prove the round trip through `crates/crypto` (`generate_returns_a_ring_crypto_accepts`).
- Rotation is two commands and two deploys. It is safe to stop after step 3 indefinitely; the
  cost is that old keys stay valid.
- A ring printed to a terminal stays in the terminal's scrollback; `--output` or a pipe avoids it.
- `rsctl` cannot tell whether a key is still in use. That needs the rewrap job (step 4).

## Rejected alternatives

- Accepting the ring as an argument (`rsctl keys rotate "$RAMPSMITH_MASTER_KEYS"`): visible in
  process listings and shell history.
- Writing the ring to a default file: a key at a path nobody chose is a key nobody remembers to
  delete.
- Implementing key generation and parsing inside `rsctl`: two copies of a security-sensitive
  format drift apart.
