# ADR-274: Signed email links, and where RFC 8058 one-click lands

- Status: Accepted
- Date: 2026-10-23
- Stream: R1 email features (`packages/email`, `packages/engine`, `crates/api`, `apps/web`)

## Context

ADR-191 requires a visible unsubscribe link and RFC 8058 one-click headers on notification and
marketing mail, working without login or cookies, for at least 60 days, taking effect within 48
hours. RFC 8058 (quoted in ADR-191) says `List-Unsubscribe` "MUST contain one HTTPS URI", the
`List-Unsubscribe-Post` header is exactly `List-Unsubscribe=One-Click`, and the POST "MUST NOT
include cookies, HTTP authorization, or any other context information", so the address alone must
say whose mail it is and what to switch off.

SvelteKit 3 removed `csrf.checkOrigin` and always refuses a form-type POST that carries no `Origin`
header (verified against the running build: `403 Cross-site POST form submissions are forbidden`).
A mail provider's one-click POST carries none. A SvelteKit route in `apps/web` therefore cannot
receive it. Separately, a page with `Referrer-Policy: no-referrer` makes browsers send
`Origin: null` on its own form posts, which Kit also refuses, so the link pages use `same-origin`.

## Decision

1. **Token.** A binary, base64url string: `version(1) | purpose(1) | category(1) | expiry u32 BE |
   tenant uuid | shop uuid | address hash(32) | key id length(1) | key id | HMAC-SHA256`. The MAC
   covers `"rampsmith/email-link/v1\0"` plus everything before it, so a token cannot be replayed as
   another purpose or category, and the signature is checked before any claim is read. It holds the
   tenant-salted hash of the address (ADR-273), not the address. Expiry is 180 days after sending
   (ADR-191 needs 60); an expired link says so and tells the person where to change the setting.
2. **Key.** A new ring, `EMAIL_LINK_KEYS` (`id:base64key[,...]`, newest first, at least 32 bytes
   each), LAUNCH.md C row 12. The engine mints, the api verifies, nothing else holds it; it may not
   equal the master or scan ring (`rsctl doctor --row 12` checks). Rotation adds a key at the front.
   TypeScript and Rust share test vectors (`packages/email/test/fixtures/link-vectors.json`).
3. **Three links per message.** The visible footer link and the preferences link go to the app
   origin (`/email/unsubscribe?t=`, `/email/preferences?t=`), pages in `apps/web` that read the token
   through the api and change nothing until a button is pressed (so a link scanner's GET is
   harmless). The `List-Unsubscribe` URI is on the api's public webhook host,
   `https://<webhook host>/webhooks/email/unsubscribe?t=`, which accepts the RFC 8058 POST (body
   must contain `List-Unsubscribe=One-Click`), switches the category off and answers 200 with no
   redirect. A GET of that address answers 303 to the app page. The webhook listener serves only
   `/webhooks/*` (ADR-182), so no private route is exposed.
4. **Effect.** The opt-out is a row in `email_opt_outs(tenant, address hash, category)` (RLS, app
   role inserts and deletes, workers read). The engine checks it per send, next to the suppression
   list, so it applies to the very next message. The change writes an audit entry
   (`email.opted_out` / `email.opted_in`, category and channel, never the address).
5. **Privacy of the pages.** `/email/*` responses are `Cache-Control: private, no-store`, `X-Robots-Tag:
   noindex, nofollow`, `Referrer-Policy: same-origin`, so the token does not leave the origin.
6. **Settings.** `EMAIL_ONE_CLICK_ORIGIN` (the webhook host, set by `railway.py`) is used by the
   engine; without `EMAIL_LINK_KEYS` the send job waits and retries with `email_not_configured`
   rather than send mail without a working unsubscribe.

## Consequences

- One more secret ring for the founder to generate (C row 12), and DKIM must cover the two
  headers (RFC 8058 section 3.1); SES Easy DKIM signs headers it is given, to be confirmed on the
  first real message (LAUNCH.md section E).
- RFC 8058 text could not be re-fetched from rfc-editor.org in this environment (the egress proxy
  refuses it); the requirements above are the ones ADR-191 quoted from the RFC and from Google's
  and Yahoo's pages when it was written.
- The api's two page endpoints (`/v1/email/links/*`) are on the private listener and take no
  session: the token is the credential, as with any unsubscribe link. They are not reachable from
  the internet.

## Rejected alternatives

- A SvelteKit endpoint for the one-click POST: refused by Kit's CSRF check (above).
- Storing tokens in a table: needs a write at send time and a lookup; an HMAC needs neither.
- Encrypting the address into the token: the hash identifies the row to change and nothing more.
