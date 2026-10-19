# ADR-173: Backup encryption with age, and who holds the private key

- Status: Accepted
- Date: 2026-10-19
- Stream: WS-8 (`infra/backup/`)
- Refines: PLAN §22 ("encrypted with `age`"); LAUNCH.md C rows 6 and 12; CLAUDE.md ("Never ... commit a
  secret")

## Context

The archive holds every tenant's rows, so it is encrypted before it leaves the database host's
memory, to a public recipient whose private half the CI job never has. age documentation, read on
19 Oct 2026 from the project's repository (`FiloSottile/age`: `README.md`, `doc/age.1.ronn`,
`doc/age-keygen.1.ronn`; the sandbox cannot reach filippo.io):

- `age -R PATH` encrypts to "recipients listed at PATH", and "every recipient can decrypt the file";
  `-i` names an identity file for decryption; `age-keygen -y` prints the recipient of an identity file.
- Recipients are X25519 `age1...` public keys. SSH keys are also accepted as recipients, but they
  embed "a public key tag in the encrypted file, making it possible to track files that are encrypted
  to a specific public key".
- Since v1.3.0 hybrid post-quantum keys exist (`age-keygen -pq`): identities start with
  `AGE-SECRET-KEY-PQ-1`, recipients with `age1pq1` and are about 2,000 characters long.
- The release asset used is `age-v1.3.2-linux-amd64.tar.gz` from
  <https://github.com/FiloSottile/age/releases/tag/v1.3.2>; its SHA-256, computed on 19 Oct 2026, is
  pinned in both workflows (`cbe24006683f8eb669266162894b9a522a1af52f2665fbc63a4bb032ed26ac10`).

Testing against age 1.3.2 found one rule the documentation does not state: `age` refuses to encrypt
one file to post-quantum and classic recipients together ("can't mix post-quantum and classic
recipients, or the file would be vulnerable to quantum computers").

## Decision

1. **Recipients are public keys only.** `bk_write_recipients` accepts lines matching
   `^age1[0-9a-z]{50,}$` (comments and blank lines are dropped) and refuses anything else: SSH
   recipients, passphrases, plugin identities, and above all `AGE-SECRET-KEY-` material, which it
   rejects by name without echoing it. A private key pasted into `BACKUP_AGE_RECIPIENTS` would put it in CI;
   the check runs at the start of `backup.sh`, before anything touches the database, and the tests
   assert that the refusal does not print the key.
2. **At least two recipients.** One held by the founder for operations, one offline, in a different
   place (paper or a hardware token), so that losing one does not lose every backup. A single recipient
   passes with a warning annotation (`holds one recipient: losing that key loses every backup`).
3. **One kind per list.** All classic (`age-keygen`) or all post-quantum (`age-keygen -pq`). The helper
   refuses a mixed list with the sentence above before the dump runs, and the backup tests cover a
   post-quantum pair (a file opens with either key) and the refused mix. Classic keys are the documented
   default: anyone who restores in an emergency can use the same pinned release (v1.3.2) on any
   machine, and an operating system's packaged `age` older than 1.3.0 cannot open a post-quantum file.
   The founder may choose post-quantum keys for a 12-month archive; the restore runbook names the
   version rule.
4. **The private keys are never in CI.** `BACKUP_AGE_RECIPIENTS` is a GitHub environment *variable*
   (public values) of `backup-production` and `backup-staging`. The production private key exists
   only where the founder keeps it. The restore drill's live variant restores *staging* backups with
   `BACKUP_DRILL_AGE_KEY`, the private half of a staging-only recipient, held as a secret of
   `backup-staging` only; staging data is test data. A production backup is restored by a person
   (`docs/runbooks/restore-from-logical-backup.md`), which is also the quarterly drill of PLAN §22.
5. **The recipient list is fingerprinted.** The first 16 hex digits of the SHA-256 of the sorted list go
   into each metadata object, so a restore can tell which key it needs without trying them all.
6. **Rotating a backup key.** Add the new recipient, deploy by changing the variable (no code), and keep
   the old private key until the last backup encrypted only to it has aged out (12 months for monthly
   copies); or re-encrypt in place with `age -d -i old | age -R new` for the archives worth keeping and
   upload them as new objects. Removing a recipient does not revoke access to files already encrypted to
   it.
7. **What the encryption does not give.** Anyone who knows a recipient can produce a file that opens with
   the matching private key, so the SHA-256 in the metadata object protects against accidents and partial
   uploads, not against an attacker who can write to the bucket. The defences are the scoped token
   (ADR-172 decision 2) and the bucket locks (decision 7).

## Consequences

- Losing every private key makes every logical backup unreadable. PITR is unaffected, and losing the
  token master key remains survivable by design (PLAN §22). Both offline copies are the founder's to
  keep, and LAUNCH.md C should list the recipients and where the keys are (integration note).
- Rotating the recipients does not reach back; the runbook says so.
- The drill uses throwaway classic keys it generates itself, so it never needs a real key.

## Rejected alternatives

- Encrypting to an SSH public key: embeds a tag that makes files linkable to the key, and there is
  nothing to gain over a native age key.
- A passphrase (`age -p`): one shared secret, typed in an emergency; it also cannot be held out of CI as
  a public value.
- Post-quantum recipients by default now: sound for long-lived data, but a restore with an older `age`
  fails, and a mixed recipient list is refused; left to the founder (decision 3).
- Encrypting inside PostgreSQL (`pgcrypto`) or with the token master key: ties the backups' readability
  to the key whose loss PLAN §22 treats as survivable.
- Letting the job generate a key and keep the private half: the point is that CI never holds it.
