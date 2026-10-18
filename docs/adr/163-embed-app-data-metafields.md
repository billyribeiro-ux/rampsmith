# ADR-163: What the app tells the embed: app-data metafields and the activation deep link

- Status: Accepted (interface); the api writes the metafields and App Home shows the link
- Date: 2026-10-18
- Stream: WS-7

## Context

The embed (ADR-161) needs two facts it cannot know by itself: where the merchant's published
accessibility statement is, and where the app proxy lives if the merchant moved it. It must
not read either from the theme, and it cannot call the api at render time.

Checked on shopify.dev on 17 and 18 October 2026:

- [App-data metafields](https://shopify.dev/docs/apps/build/custom-data/ownership): stored on
  the `AppInstallation`; created with `metafieldsSet` using the id from `currentAppInstallation`
  as `ownerId`; "completely hidden from the Shopify admin"; only the owning app can read them,
  through GraphQL or the Liquid `app` object; the `$app` namespace is not needed because the
  owner already isolates them; they cannot be created from `shopify.app.toml`.
- [Liquid `app`](https://shopify.dev/docs/api/liquid/objects/app): `app.metafields`, "the
  metafields that are owned by the app", used with theme app extensions; the configuration page
  reads one as `app.metafields.<namespace>.<key>`.
- [Theme app extension configuration](https://shopify.dev/docs/apps/build/online-store/theme-app-extensions/configuration):
  the activation deep link
  `https://<myshopifyDomain>/admin/themes/current/editor?context=apps&template=${template}&activateAppId={api_key}/{handle}`,
  where `api_key` is the app's client id and `handle` the block's file name; `context` must be
  `apps`; without `template` the index template opens.
- [About app proxies](https://shopify.dev/docs/apps/build/online-store/app-proxies): merchants
  can move the proxy per store, and every proxied request carries `path_prefix`.

## Decision

1. **Namespace `rampsmith`**, two keys, both written by the api with `metafieldsSet` on the
   current app installation and removed with `metafieldsDelete`:

   | Key | Type | Value | Written when |
   | --- | --- | --- | --- |
   | `statement_url` | `url` | The published statement's URL, absolute or root-relative | The merchant publishes a statement; deleted when it is unpublished |
   | `proxy_path` | `single_line_text_field` | The proxy's storefront path, matching `^/(a\|apps\|community\|tools)/[A-Za-z0-9_-]{1,30}$` | A verified proxied request's `path_prefix` differs from `/apps/rampsmith`; deleted when it returns to the default |

2. **The embed reads them** as `app.metafields.rampsmith.statement_url.value` and
   `app.metafields.rampsmith.proxy_path.value`, falling back to the embed's own URL setting and
   to `/apps/rampsmith`. Both are escaped where they are output.
3. **Activation.** App Home's onboarding (requirement 5.1.3) shows the deep link
   `https://<shop>/admin/themes/current/editor?context=apps&activateAppId=<client id>/accessibility`
   and says the embed starts off and that the form is a separate setting.
4. **No `available_if`.** The embed stays visible in the editor before a statement exists, so
   the merchant can enable it and the form first; the editor notice explains the missing link.

## Consequences

- Where the statement is published (an Online Store page through `write_content`, or a page the
  api serves through the proxy) is the statement generator's decision (WS-13 and the main
  builder); the embed only needs its URL in `statement_url`.
- If a merchant moves the proxy before any request reaches the api, the form posts to the
  default path and fails with the "could not be sent" message until `proxy_path` is set; App
  Home can set it from the merchant's input as well.
- Live check (LAUNCH.md section E, rows 1 and 3): `metafieldsSet` on the app installation with
  the app's scopes, then the link on development store A.

## Plan correction

PLAN §14 "Theme app extension", add: "The app tells the embed where the statement is, and where
the proxy is if the merchant moved it, through the app-data metafields
`rampsmith.statement_url` and `rampsmith.proxy_path` (ADR-163). App Home's onboarding links
straight to the embed's activation in the theme editor."
