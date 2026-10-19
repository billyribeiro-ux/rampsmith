# ADR-193: Email inputs: validation, escaping, links, secrets and names other people choose

- Status: Accepted
- Date: 2026-10-18
- Stream: WS-10 (LAUNCH.md B; PLAN §16, §18, §19)

## Context

Email inputs come from Shopify (store names), from other users (agency names), from the engine
(finding titles), from operators (incident notices) and, as JSON, from jobs that Rust code
enqueues. The sign-in email carries an authentication token, the verification email a
verification token, the store-link email a one-time code that grants an agency access to a
store, and subscribed emails an unsubscribe token. A security audit of the package (two rounds,
`docs/evidence/ws-10-email.md`) tested these rules against hostile inputs.

## Decision

1. **Strict schemas** (`src/schema.ts`) validate every input: unknown fields are rejected (no
   personal data rides along), dates are RFC 3339 instants with an offset and real calendar
   fields, host names are DNS labels in ASCII form, language tags keep only language, script
   and region, and lists have maximum lengths. Errors name the field and the rule, never the
   value, and name an unknown key only when it is a plain identifier.
2. **Text hygiene** (`src/sanitize.ts`): input is made well formed and NFC; control characters,
   bidirectional overrides and invisible format characters are removed (the zero-width joiner
   and non-joiner and the direction marks stay); runs of combining marks are capped; size is
   bounded before any work. Names are one line and shortened by user-perceived characters.
3. **Escaping.** Every value is HTML-escaped by the one renderer; values are never parsed as
   catalog syntax, so `{store}` in a store name stays text. Tests tokenize every output and fail
   on any tag or attribute the renderer does not write, including for every string field of
   every email filled with hostile values and 300 fuzzed names.
4. **Links** go only to the configured app origin, the site origin or
   `https://admin.shopify.com`, per field (a sign-in link only to the app). They are absolute
   HTTP(S) URLs without credentials, whitespace, control characters or backslashes, normalised
   by the WHATWG parser and written unchanged: no tracking parameters, no redirector.
5. **Secrets.** The sign-in and verification tokens appear only inside their link (the button's
   `href`, and the fallback link's `href` and text); the store-link code appears once in each
   version, in its code block; the unsubscribe token only in its link and the
   `List-Unsubscribe` header. None appears in a subject, preview text, error, `toJSON`,
   `util.inspect` or `describeForLog`; the bodies, subject and headers of a `RenderedEmail` are
   non-enumerable, so a spread copy does not carry them either.
6. **Names other people choose.** An email sent to someone who did not ask for it must not carry
   another person's words as a link. Agency names in invitations and in the access notice may
   not read as a link, address, domain, IPv4 address or network path (judged on a skeleton
   form, so look-alike dots and hidden characters do not help) and stay out of subjects and
   preview text, in quotes in the body. A Shopify store name that reads like a domain (J.Crew,
   Acme.com) is common, so the store-link code email leaves such a name out ("a Shopify store")
   instead of failing. The free-scanner confirmation, which anyone can send to any address,
   carries nothing the requester typed, not even the scanned host.
7. **Operator text** (incident notices) is checked with claims-lint's own rules on a skeleton
   form with hyphenated line breaks rejoined, and refused if it carries an allow marker or mixes
   Latin with Cyrillic or Greek letters in one word.
8. **Personal data.** Recipient addresses never enter the body; approvers' names stay in the
   remediation log; shopper barrier reports stay in the app (the email says one arrived).

## Consequences

- A malformed or hostile payload fails before rendering with a path such as
  `input.fixes[3].title`, and the job that sent it can fail permanently.
- The app's own rules for agency names should match decision 6, so an invitation never fails at
  send time.

## Integration requirements (for the app, not this package)

- Single-use links (sign-in, verification, invitation, scanner confirmation, export) must not be
  consumed by a GET: mail security scanners open links first. The landing page asks for a
  click that POSTs the token.
- Tokens in these links are capability URLs: keep them out of access logs and send
  `Referrer-Policy: no-referrer` on the landing pages.

## Plan correction

- PLAN §16 "Free scanner": add "The confirmation email carries nothing the requester typed; the
  scanned host appears only in the report sent after confirmation (ADR-193)."
- PLAN §16 "Linking a Shopify store to an agency": add "Rampsmith can email the one-time code to
  an address the store owner enters; agency names may not read as links (ADR-193)."
