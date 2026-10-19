# ADR-033: WebAuthn origin and relying-party validation at boot

- Status: Accepted
- Date: 2026-10-19

## Context

ADR-024 has the dashboard use passkeys with `WEBAUTHN_RP_ID` (the relying-party id, a
registrable domain) and `WEBAUTHN_RP_ORIGIN` (the origin that serves the dashboard). The api
checked the origin with string prefixes. Audit finding L9
(`docs/evidence/r0-security-audit-2026-10-19.md`): `http://localhost.<rp_id>` passed, because the
prefix `http://localhost` was stripped and the remainder `.<rp_id>` then satisfied the
subdomain test. Plain http would have been accepted for a host that is a subdomain of the
production relying party.

## Decision

`crates/api/src/config.rs` parses the origin with the `url` crate (the parser the identity crate
hands the origin to) and applies these rules at boot. A violation stops the process with an error
that names the variable and the rule, never the value.

1. The scheme is `https`, or `http` when the host is exactly `localhost`.
2. The host is a domain name, not an IP address.
3. The URL is an origin: no user info, no query, no fragment, and no path beyond `/`.
4. The host equals the relying-party id or ends with `.` plus the id (whole labels, so
   `evilrampsmith.test` is not under `rampsmith.test`).
5. The api keeps the canonical origin (`scheme://host[:port]`, lowercase, default port omitted).
6. `WEBAUTHN_RP_ID` must be a lowercase host name: dot-separated labels of letters, digits and
   hyphens, none empty or starting or ending with a hyphen. A scheme, port, path, upper-case
   letter or stray dot is refused, because those would make the comparison in rule 4 meaningless.

## Consequences

- The unit tests in `config.rs` cover the accepted origins (including a mixed-case host, a
  trailing slash, a port, and localhost on http and https) and 25 refused ones, including
  `http://localhost.rampsmith.test`, user-info tricks, a path, a query, a fragment, an IP address
  and non-web schemes.
- `crates/api` gains a direct dependency on `url`, already in the workspace and the lockfile.
- The Playwright dashboard server (`http://localhost:3996` with id `localhost`) and the
  `.env.example` default (`http://localhost:5173`) still pass.
- Public-suffix awareness is not added: an id of `com` would still be accepted. The founder sets
  the id from LAUNCH.md section C row 10, and the browser rejects an id that is not a registrable
  domain suffix of the page's origin when a ceremony starts.

## Rejected alternatives

- Allowing `http` for any `*.localhost` host: the audit asked for the exact host `localhost`,
  and one development host is enough.
- Validating only in `identity::new`: the failure would surface as a generic configuration error
  from deep in a constructor, after the api had read the rest of its environment.
