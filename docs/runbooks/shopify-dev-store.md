# Runbook: wire a Shopify development store

R0 step 7 is built and tested against a mock of Shopify's token endpoint. These steps need the
founder's accounts, so they are the only part left; each takes minutes.

## 1. Partner account and app (founder)

1. Create or sign in to a Shopify Partner account (hardware security key on, PLAN §18).
2. Install Shopify CLI 4.9.4 (`npm i -g @shopify/cli@4.9.4`) and, from the repository root, run
   `shopify app config link`. Choose "Create a new app" named Rampsmith. The CLI writes
   `client_id` into `shopify.app.toml`; commit that change (the client id is public).
3. In the Partner dashboard, copy the app's client secret into the password manager and into
   the environment as `SHOPIFY_API_SECRET`, with `SHOPIFY_API_KEY` beside it. Never commit it.
4. Generate the first master key: `head -c 32 /dev/urandom | base64`, store it as
   `RAMPSMITH_MASTER_KEYS=k2026a:<key>` in the same places.

## 2. Development store (founder)

1. In the Partner dashboard, create a development store and note its `*.myshopify.com` domain.
2. Run `shopify app deploy` to push `shopify.app.toml` (scopes, App Home URL).
3. Set `application_url` to the deployed `web` URL (Railway) or let `shopify app dev` tunnel to a
   local `web` (it rewrites the URLs while `automatically_update_urls_on_dev = true`).

## 3. Live check against the store (either of us, no install)

This proves the store's domain, Shopify's token endpoint, the form Rampsmith sends and the error
mapping, without installing anything (ADR-031). It does not prove the client secret: a wrong
secret can get the same 400 answer, so the first install (section 2) is what confirms it. With the app from section 1 and store A from section 2, set three variables
in your shell (never in a file that is committed) and run one test:

```sh
export SHOPIFY_API_KEY=...             # the app's client id
read -rs SHOPIFY_API_SECRET && export SHOPIFY_API_SECRET   # paste the client secret; not echoed, not in history
export SHOPIFY_DEV_STORE_DOMAIN=...    # store A, a bare *.myshopify.com host
cargo nextest run -p rampsmith-shopify --test live_dev_store
unset SHOPIFY_API_SECRET
```

The test signs an ID token for the store with the client secret, already expired, and sends a
token exchange for it through the crate's real code to
`https://<store>/admin/oauth/access_token`. Shopify's documented answer to an expired ID token
is 400 Bad Request, which the crate reports as `InvalidSubjectToken`; nothing is installed and
no token is issued. It passes on that answer. When it fails, the message says which class
Shopify's answer fell into and never prints a secret, a token or a response body:

| Message | Meaning |
| --- | --- |
| `Shopify rejected the client credentials` | Shopify answered 403: the id and secret do not match an app it knows. Recheck both in the Partner dashboard. |
| `expected the stale-ID-token class ... got Rejected { status: 404 }` | Shopify answered with another client error, shown as the status. Check that the domain is store A's permanent `*.myshopify.com` host. |
| `... got RateLimited`, `Upstream` or `Transport` | Shopify or the network failed. Run it again. |
| `Shopify exchanged an expired ID token` | Shopify issued a token for an expired ID token. Stop and tell the architect: the probe's assumption is wrong. |

Without the three variables the test passes and prints
`Shopify dev-store live check skipped: needs LAUNCH.md section C rows 1 and 3 ...`; in GitHub
Actions that line is a notice annotation on the run. LAUNCH.md section E lists the check until it has
passed against the founder's store.

## 4. First install (either of us, with the credentials in place)

1. Start `api` and `ctl` with the variables in `.env.example`, and `web` (R0 step 8).
2. Install the app on the development store from the Partner dashboard and open it.
3. Check: `shopify_shops` has one `installed` row for the store, `shopify_tokens` holds two
   ciphertexts and `access_expires_at` about an hour ahead, `jobs` has one
   `shopify.token_refresh` row a week ahead, and `audit_log` records `shopify.installed`.
4. Complete spike S-4's "Still to observe" list in `docs/spikes/S-4-initial-document-token.md`.
