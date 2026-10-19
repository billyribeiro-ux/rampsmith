# ADR-151: `rsctl` command-line design and secret handling

- Status: Accepted
- Date: 2026-10-19

## Context

LAUNCH.md B5 asks for `rsctl doctor`: one probe per founder input in section C, PASS or FAIL
per input, never a secret in any output. Section C row 12 asks for `rsctl keys generate`.
Section E says a live check counts only when a substitute test passes now, the live test skips
with a notice naming the C row, and the live command has a row in that table. CLAUDE.md adds:
never log a token, a storefront password or personal data; no `unwrap`, `expect` or `panic`
outside tests; `thiserror` in libraries, `anyhow` only in a binary's `main`.

PLAN §6 and §15 give `rsctl` a wider remit later (`rsctl jobs retry`, `rsctl bench`, audited
cross-tenant reads). This stream builds only `doctor` and `keys`; the crate is laid out so the
other commands are new variants of `cli::Command`, not a rewrite.

The tool handles every credential the founder owns. The design is therefore about what can
never leave the process, and what each probe may read and call.

## Decision

### Shape

1. `crates/rsctl` is the package `rampsmith-rsctl`: a library `rsctl` (all logic, so tests can
   drive it) and a binary `rsctl` (`main.rs`: parse arguments, install the panic hook, build a
   multi-thread Tokio runtime, call `app::run`, map the result to an exit code; `anyhow` only
   there). `app::run(cli, Runtime { env, endpoints, clock }, &mut Io { stdin, stdout, stderr })`
   takes its environment, vendor origins, clock and streams as arguments, which is how the
   substitute tests run the whole CLI against fakes.
2. Commands:
   - `rsctl doctor [--environment production|staging] [--row N]... [--json] [--strict]
     [--timeout SECONDS] [--production-shopify-api-key ID] [--production-github-app-id ID]`
   - `rsctl keys generate [--id ID] [--output FILE]`
   - `rsctl keys rotate [--id ID] [--stdin] [--output FILE]`
   - `rsctl keys drop --id ID... [--stdin] [--output FILE]`
   - `rsctl keys ids [--stdin]`

   The key commands are specified in ADR-153.

### Doctor outcomes

3. Every check yields PASS, FAIL with a reason, or SKIP. `doctor` prints one line per check,
   `PASS|FAIL|SKIP  C<row> <check id> <detail>`, then a count line. `--json` prints one JSON
   document with the same facts (`environment`, `checks[]` with `id`, `row`, `status`, `detail`,
   `required`, `skip_kind`, then `summary` and `ok`).
4. A check whose inputs are all unset is `SKIP` and its detail names the variables and
   `C row N`. A check with some of its inputs set but not all is `FAIL` ("C row N is incomplete:
   ... not set"), because a half-filled input never works. Some inputs the vendor gives no way to
   check without using them (the App Automation Token, the storefront passwords, the webhook
   secrets, the Turnstile site key): when set they report `SKIP`, `skip_kind` `not_verifiable`,
   saying so. Nothing is ever reported PASS that was not exercised.
5. Exit code 0: no check failed. Exit 1: a present input failed, a key operation was refused, or
   (with `--strict`) a required input is missing. Exit 2: the command could not run (a usage
   error, no key ring to read, an unusable output file). `--strict` treats a missing input as a
   failure only for required checks; the Cloudflare DNS token, the Railway workspace token and
   Stripe (R3 only) are optional (LAUNCH.md rows 8, 10, 11).
6. Checks run concurrently (one Tokio task each) and are reported in LAUNCH.md order. A check
   that panics is reported as `FAIL ... the probe crashed (internal error)` and the panic
   payload is discarded. Every request has a timeout (default 15 s, 1 to 120 via `--timeout`).
7. Standard output carries only the result: the doctor report, a key ring, or key ids. Notes and
   errors go to standard error.

### Inputs

8. The only environment access is the `vars::Var` enum: the 36 variables in LAUNCH.md section C
   rows 1 to 12, by name. A probe asks for a `Var`, never a string, and declares the set it may
   read in `CheckDef::reads`. A blank value counts as unset, as in `crates/ctl`. Two tests keep
   this honest: the substitute suite records every read and fails if a probe reads outside its
   declared set, or outside its own row apart from three documented exceptions (the row 1
   probe reads the development store domain of row 3 as the exchange target, the row 2
   Partner API probe reads `SHOPIFY_API_KEY` of row 1 to compare the app's key, and the row 15
   probe reads the row 1 and row 4 identifiers); and a drift test parses LAUNCH.md section C
   and fails when the table and `Var::ALL` disagree.
9. Row 15 (staging copies of the apps) is checked only for `--environment staging`: it compares
   the staging `SHOPIFY_API_KEY` and `GITHUB_APP_ID` (the same names as rows 1 and 4, read from
   the staging environment) with the production identifiers given as flags. Both are public
   identifiers.

### Secret handling

10. `secret::Secret` wraps a value (`secrecy::SecretString`, wiped on drop). `Debug` prints
    `Secret([REDACTED])` and `Display` prints `[REDACTED]`. The value leaves only through
    `Secret::expose`, which a probe calls while it builds a request. Every value read from the
    environment is held in a `Secret` (`vars::Gathered`).
11. `secret::Redactor` is the last line of defence. Every variable marked secret (20 of the 36)
    is registered before any probe runs, and so is every token a probe mints (the Shopify
    client-credentials token, the GitHub App JWT). The redactor replaces each registered value,
    its trimmed and percent-encoded forms, and every line of at least 16 characters of a
    multi-line value such as a PEM key, with `[REDACTED]`. Values shorter than four characters are not replaced, since they are not
    credentials and would mangle ordinary words. Every line the CLI prints (report text, JSON
    details, notes, errors) passes through `Redactor::scrub`.
12. The redactor is a backstop, not the mechanism. Probes print vendor error *codes*, never
    vendor free text, and `util::safe_token` returns a code only when it is a plain identifier
    (`A-Za-z0-9_-.`, 1 to 64 characters), otherwise the fixed text `(unrecognised)`. It never
    truncates or cleans a string: the hostile-echo test found that a truncated echo of a request
    could leave the front half of a secret that the redactor then could not match.
13. `http::Http` is the only HTTP client. It sends credentials over HTTPS only (plain HTTP is
    accepted for a loopback host, which is how tests reach their fakes), follows no redirect
    (a custom credential header would travel with it), reads at most 1 MiB of a body, and fails
    with a closed set of `HttpError` values whose messages are fixed text, because the text of a
    transport error can contain the URL.
14. A panic hook replaces the default message, which prints the payload, with the place only:
    `rsctl: internal error at <file>:<line>; the details are withheld because they could contain
    a secret`.
15. Key rings are held in `Zeroizing<String>` while in memory; a ring goes to standard output or
    to a new file (mode 0600, created with `create_new`, so it is never overwritten). Messages
    about a ring never contain key bytes (ADR-153).
16. `doctor` makes the least-privileged call each vendor documents for the purpose
    (ADR-152). The only writes are the R2 object (written, read back and deleted) and the Shopify
    client-credentials grant, which mints a 24-hour token that is registered with the redactor
    and never printed.

## Consequences

- The founder can paste `rsctl doctor` output into a chat or an issue. The tests in
  `tests/redaction.rs` and `tests/doctor/hostile.rs` prove it for `Debug`, `Display`, every error
  type, re-encodings of a secret, and a server that echoes the whole request in every response
  shape.
- Adding a founder input is three edits: a `Var`, the LAUNCH.md row (the drift test fails until
  both agree), and a probe.
- The vendor's message text is never shown, so a failure says what the vendor's code was
  (`HTTP 401 authentication_error`) and what the founder should check, not the vendor's prose.
  Debugging an odd response needs a packet capture or the vendor dashboard.
- A probe that needs another row's input (the dev store for the Shopify exchange) reports SKIP
  naming that row, so the gap is visible.

## Rejected alternatives

- Reading arbitrary environment variables by name: a typo would silently skip a probe, and the
  drift test could not exist.
- Printing vendor error messages, scrubbed by the redactor: scrubbing cannot catch a secret that
  a vendor reformats, truncates or splits across lines.
- A `tracing` subscriber with a redaction layer: the CLI has no long-running work, and a
  subscriber is one more path to the terminal.
- Following redirects with the header dropped: no probe needs a redirect, so refusing is
  simpler to audit.
