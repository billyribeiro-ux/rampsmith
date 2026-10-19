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

## 3. First install (either of us, with the credentials in place)

1. Start `api` and `ctl` with the variables in `.env.example`, and `web` (R0 step 8).
2. Install the app on the development store from the Partner dashboard and open it.
3. Check: `shopify_shops` has one `installed` row for the store, `shopify_tokens` holds two
   ciphertexts and `access_expires_at` about an hour ahead, `jobs` has one
   `shopify.token_refresh` row a week ahead, and `audit_log` records `shopify.installed`.
4. Complete spike S-4's "Still to observe" list in `docs/spikes/S-4-initial-document-token.md`.
