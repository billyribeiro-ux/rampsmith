# Rotate the GitHub App private key (and the webhook secret)

| | |
| --- | --- |
| Answers | PLAN §21 pages that a bad GitHub credential causes: any dead job in `github.*` queues and "Webhook signature failures above baseline"; PLAN §22 "Secrets" |
| Severity | Planned change: SEV4. A leaked key: SEV1 (the key lets its holder act as the App) |
| Use it when | A person with access to the key leaves; the key may have leaked; on a schedule the founder sets (GitHub keys never expire, so nothing forces one). The webhook secret rotates with it |
| Decisions behind it | ADR-122 and ADR-126 (the GitHub App crate, `ws/github-app`), ADR-177 |
| Verified | 2026-10-19 against GitHub's documentation (Managing private keys for GitHub Apps; Redelivering webhooks; Handling failed webhook deliveries) and ADR-122/ADR-126. **Not run against a live GitHub App**: it needs LAUNCH.md C row 4. Section E row |

## What exists, and what does not

| Piece | State |
| --- | --- |
| The key in `GITHUB_APP_PRIVATE_KEY`, read by `ctl` | Declared by the deploy stream (ADR-182: `ctl` only). The R0 `ctl` (`crates/ctl/src/config.rs`) does not read it yet: the pull-request channel is R2. Until then the rotation changes GitHub's key list and the stored secret, and `rsctl doctor` proves the key; no running service signs with it |
| `rsctl doctor --row 4` | Built on `ws/rsctl`: signs a JWT with the key and calls `GET /app`; passes when the id and client id match |
| Installation-token cache and JWT signing | Built on `ws/github-app`: a JWT is signed fresh for every App call (valid 10 minutes at most) and installation tokens (1 hour) live in memory, so **no overlap logic exists or is needed** |
| `WebhookVerifier::with_previous` (accepts the old webhook secret during a rotation) | Built in the crate, **not wired**: no environment variable feeds it and the `/webhooks/github` route is **not built** |
| A tool that lists and redelivers failed GitHub deliveries | **Not built**: use the GitHub web interface (below) |

GitHub (docs): an app can have up to 25 private keys "so you can rotate keys without downtime"; keys never expire and are revoked only by deleting them; GitHub keeps only the public half and shows a fingerprint next to each key; the last remaining key cannot be deleted.

## Part 1: the private key

Do staging first (the staging App is separate from production's, LAUNCH.md C row 15), then production.

### 1. Generate the new key while the old one stays valid

GitHub: Settings > Developer settings > GitHub Apps > the App > Edit > Credentials > Key pairs > **New key** (older layout: "Generate a private key"). A PEM file downloads (PKCS#1, `-----BEGIN RSA PRIVATE KEY-----`). GitHub cannot show it again.

Move it at once into a private directory and name it by date:

```sh
umask 077
mkdir -p /dev/shm/gh-key-<ticket> && mv ~/Downloads/<app-name>.<date>.private-key.pem /dev/shm/gh-key-<ticket>/new.pem
cd /dev/shm/gh-key-<ticket>
```

### 2. Check the fingerprint, then the vault

GitHub shows a fingerprint for each key. Compute the key's and compare them:

```sh
openssl rsa -in new.pem -pubout -outform DER | openssl sha256 -binary | openssl base64
```

Store `new.pem` in the offline vault as the current entry for the environment, and relabel the old one "previous (delete at GitHub after <date>)". PLAN §22 keeps current and previous.

### 3. Prove the key signs and GitHub accepts it

From a trusted machine, with `rsctl` built from `ws/rsctl` (`cargo build --release -p rampsmith-rsctl`) and the App's id and client id from the vault (they are not secret):

```sh
GITHUB_APP_ID=<id> GITHUB_APP_CLIENT_ID=<client id> GITHUB_APP_PRIVATE_KEY="$(cat new.pem)" \
  rsctl doctor --row 4
```

Expected `PASS  C4  github.app …` and `1 passed, 0 failed, 0 skipped`. A 401 with a clock-skew hint means the machine's clock is off by more than a minute. Do not go on if it fails.

### 4. Set it in Railway and deploy

Railway dashboard > the environment > Project Settings > Shared Variables > `GITHUB_APP_PRIVATE_KEY` (sealed; edit from its menu). The crate accepts the PEM with real newlines, CRLF, indentation, or one line with literal `\n`. If the editor mangles line breaks, paste the one-line form:

```sh
awk 'NF { sub(/\r$/, ""); printf "%s\\n", $0 }' new.pem; echo
```

The edit is staged: open the changeset's Details, check that only this variable changed, and Deploy (not Alt+Deploy). `ctl` is the only consumer; its health check gates the cutover and the old deployment keeps serving if the new one fails. (Railway's own guide for this exact pattern: issue the new key, update the variable, deploy, verify, revoke the old key. <https://docs.railway.com/guides/rotate-credentials-zero-downtime>.)

### 5. Verify the deployment uses it

- `railway logs --service ctl --environment <env> --since 10m --filter "@level:error"` shows no new errors.
- **When a `github.*` job exists** (R2): wait for, or provoke, one job that mints an installation token and check that it succeeded after the deploy. Until then there is nothing in the running system that signs with the key; say so in the ticket and treat step 3 as the proof.

### 6. Delete the old key at GitHub

Only after steps 3 to 5. GitHub: Credentials > Key pairs > **Delete** beside the old key, matched by fingerprint. Deleting revokes the key (GitHub: keys "need to be manually revoked"; a lost or compromised key is removed by deleting it). Then relabel the vault's previous entry "deleted at GitHub on <date>". If a `ctl` that still holds the old key restarts later (a rollback), it will fail to mint tokens: that is why the delete waits for the verification.

### Rollback (key)

Before step 6 the old key is valid: put it back in the variable from the vault, Deploy, and delete the *new* key at GitHub if it is suspect. After step 6 the old key is gone: generate another new key (up to 25 exist) and repeat from step 1; there is no way back to the deleted one.

### If the key may have leaked (SEV1)

1. Generate the new key, set it and deploy (steps 1 to 4), and **delete the leaked key immediately** after step 3 passes: do not wait for step 5.
2. Whether deleting a key invalidates installation tokens it already minted is **not documented**. Assume tokens minted before the deletion live for up to an hour (ADR-122).
3. Open the incident ([incident response](incident-response-and-postmortem.md)). The key's power is what the App was granted: contents, pull requests and checks write on the repositories each merchant selected (ADR-122, `TokenScope`). Ask each affected merchant to review their repository's recent pull requests, and say so in the notice.

## Part 2: the webhook secret (`GITHUB_APP_WEBHOOK_SECRET`)

The secret has no overlap at GitHub's end: it holds one value. The crate can accept two (`with_previous`) but nothing feeds it yet, so today a rotation has a short window in which deliveries fail verification. GitHub **does not redeliver failed deliveries automatically**, but allows redelivery for 3 days after the original (Redelivering webhooks).

1. Pick a quiet time. Generate the new secret: `openssl rand -hex 32`. Store it in the vault.
2. GitHub: the App > Edit > Webhook > Secret: paste the new value, save. From now on GitHub signs with it and `api` (still holding the old one) answers 401 to every delivery: the window opens.
3. Immediately set `GITHUB_APP_WEBHOOK_SECRET` (shared variable; `api` is the only consumer) to the same value and Deploy. The window closes when `api` is healthy.
4. Redeliver what failed in the window: GitHub > Settings > Developer settings > GitHub Apps > the App > Edit > **Advanced** > Recent deliveries; for each delivery with a failure status in the window, open it and click **Redeliver**. (The REST equivalents are `GET /app/hook/deliveries` and `POST /app/hook/deliveries/{delivery_id}/attempts`; they authenticate with an App JWT, and no tool of ours mints one for you.)
5. Check: the next deliveries return 200; the signature-failure rate (PLAN §21) is back to baseline.

When the webhook intake and the previous-secret variable exist (not built; ADR-177 describes the gap), set the old secret as the "previous" first and the window disappears. Until then: do it in a quiet period, and expect missed events only for the seconds between 2 and 3.

## Verify (done means)

- `rsctl doctor --row 4` passes with the new key.
- The old key is deleted at GitHub (or, before step 6, the ticket says why not yet).
- The vault holds the new key as current; the previous is labelled.
- No dead `github.*` job and no signature-failure alert after the rollout.

## Escalation

GitHub's status page and support for App problems; the founder holds the App (LAUNCH.md C row 4). A key or secret that cannot be found anywhere: generate new ones (this runbook) — nothing else depends on the old values.
