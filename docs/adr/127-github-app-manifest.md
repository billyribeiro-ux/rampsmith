# ADR-127: GitHub App manifest and its placeholders

- Status: Accepted
- Date: 2026-10-17
- Stream: WS-3 (`infra/github-app-manifest.json`)

## Context

LAUNCH.md C row 4 has the founder register the GitHub App from `infra/github-app-manifest.json`.
The founder has not chosen the domain (LAUNCH C row 10), so the URLs cannot be real yet. PLAN §15
fixes the permissions (metadata read, contents write, pull requests write, checks write,
workflows not requested) and lists four webhooks.

Checked on docs.github.com on 2026-10-17:

- [Registering from a manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest):
  parameters `name`, `url` (required), `hook_attributes` (`url` required, `active`),
  `redirect_url`, `callback_urls` (up to 10), `setup_url`, `description`, `public`,
  `default_events`, `default_permissions`, `request_oauth_on_install`, `setup_on_update`. The
  flow posts the manifest as a `manifest` form field (with an unguessable `state`) to
  `https://github.com/settings/apps/new` or `…/organizations/ORG/settings/apps/new`; GitHub
  redirects to `redirect_url` with a `code`, which `POST /app-manifests/{code}/conversions`
  exchanges within one hour for the app ID, private key (`pem`) and webhook secret.
- [Events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads):
  `installation` and `installation_repositories`: "All GitHub Apps receive this event by default.
  You cannot manually subscribe to this event." `push` needs Contents read; `pull_request` needs
  Pull requests read.
- [About the setup URL](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url):
  "Bad actors can hit this URL with a spoofed `installation_id`"; verify with a user access token
  that the installation belongs to the user.
  [Registering a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app):
  requesting user authorization during installation removes the Setup URL and sends users to the
  callback URL instead.
- [Apps REST permissions](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app):
  the permission keys are `checks`, `contents`, `metadata`, `pull_requests`, `workflows`.

## Decision

The manifest holds:

- `default_permissions`: exactly `metadata: read`, `contents: write`, `pull_requests: write`,
  `checks: write`. No `workflows`. A test also proves `TokenScope::fix_pull_requests` asks for
  exactly this set, never more.
- `default_events`: `pull_request` and `push` only, because the two installation events arrive
  without a subscription and cannot be listed.
- `public: false`, as the stream brief requires while the domain and URLs are placeholders. A
  private App can be installed only on the account that owns it, so **before merchants can
  install it the founder switches it to public** in the App's settings (GitHub's "Making a
  GitHub App public or private"), at the same time as the real URLs go in.
- `request_oauth_on_install: true` with one `callback_urls` entry and no `setup_url`, so the
  `api` can confirm with the installer's user token that the installation is theirs before
  linking it to a store, instead of trusting a spoofable `installation_id`.
- `hook_attributes.active: true`. The webhook secret cannot be set in a manifest; the conversion
  response returns one, which the founder stores as `GITHUB_APP_WEBHOOK_SECRET`.
- `name: Rampsmith` and a plain description without outcome claims. App names are unique on
  GitHub; if it is taken, the founder edits `name` before registering.

### Placeholders and how to replace them

Every URL uses the host `replace-with-app-domain.example`. `.example` is reserved (RFC 2606), so
a placeholder can never resolve or be registered by someone else.

| Field | Placeholder | Replace with |
| --- | --- | --- |
| `url` | `https://replace-with-app-domain.example` | The marketing site's root |
| `hook_attributes.url` | `…/webhooks/github` | The `api` webhook route, once its owner fixes the path |
| `redirect_url` | `…/github/manifest/callback` | The page that exchanges the manifest `code` |
| `callback_urls[0]` | `…/github/callback` | The OAuth callback that verifies the installer |

Steps, once the domain exists (LAUNCH C row 10): replace the host in all four URLs (and any path
the `api` owner changed); run `cargo test -p rampsmith-github --test manifest`, which checks that
every URL is `https` on one host and that any remaining `.example` host is exactly the
placeholder; register the App from the manifest (LAUNCH C row 4); store the app ID, client ID,
private key and webhook secret as Railway variables and GitHub Actions secrets; then make the App
public.

## Consequences

- LAUNCH C row 4's variables should include `GITHUB_APP_CLIENT_ID` (ADR-122); proposed to the
  architect.
- The `api` owner implements the manifest `code` exchange and the OAuth callback; neither is in
  this crate.

## Plan correction

PLAN §15, the line after the permissions table — replace with:

```
Webhooks: `pull_request` and `push`, subscribed in the manifest; `installation` and `installation_repositories` reach every GitHub App by default and cannot be subscribed to (ADR-127). The merchant chooses repositories at install; "all repositories" is never suggested.
```

PLAN §15 "Connecting a theme repository", step 1 — replace with:

```
1. The merchant installs the app on the theme repository and authorizes it during installation, so Rampsmith confirms with the merchant's user token that the installation is theirs before linking it to the store (ADR-127).
```

## Rejected alternatives

- Listing all four events in `default_events`: GitHub delivers the installation events anyway
  and documents that Apps cannot subscribe to them.
- A setup URL that trusts `installation_id`: spoofable, per GitHub's own warning.
- Real-looking placeholder domains: they could resolve, or be registered by someone else.
