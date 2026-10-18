# ADR-194: The sending boundary: `EmailSender`, `guardSender`, and where `email.send` runs

- Status: Accepted
- Date: 2026-10-18
- Stream: WS-10 (LAUNCH.md B, C row 7, E)

## Context

PLAN §10 gives the `email.send` queue to `ctl` (Rust), and PLAN §6 lists Amazon SES as the
provider. The templates are a TypeScript package (this stream's brief). The brief also says to
export a sender interface that a later SES adapter implements, and not to call SES. Live
delivery needs LAUNCH.md C row 7 (`SES_REGION`, `SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY`,
`EMAIL_FROM`), which the founder adds last.

## Decision

1. **`EmailSender`** is the provider boundary: `send({ to, idempotencyKey, email })` returns
   `sent` with a provider message id or `duplicate`. Its documented contract: send
   `multipart/alternative` with a transfer encoding (a long paragraph can pass SMTP's 998-octet
   line limit), use the subject and add every header unchanged, have DKIM cover
   `List-Unsubscribe` and `List-Unsubscribe-Post`, send from `EMAIL_FROM`, turn off open and
   click tracking, record the idempotency key durably and return `duplicate` instead of sending
   twice, and never log the recipient, subject, bodies or headers (including provider error
   messages, which can quote addresses).
2. **`guardSender(inner)`** wraps any sender. It reads the message once into a frozen copy,
   refuses anything `render` did not produce, a recipient that is not one plain address, a
   malformed idempotency key, a line break in any header, and any `problems` the render
   reported (`postal-address-missing`, `unsubscribe-not-https`), and forwards only the copy it
   checked. `MemorySender` implements the contract in memory for tests and local development.
3. **`email.send` runs in the Node engine**, which renders with this package and sends through
   the SES adapter. Rust code (`ctl`, `api`) enqueues `email.send` with `{ kind, input }` in
   the payload and the job's idempotency key; the worker calls
   `renderUnknown(kind, input)`, so a payload that does not validate fails permanently with
   the field path. This keeps one renderer and avoids a cross-language template system.
4. **Live check** (LAUNCH.md E): `packages/email/test/live.test.ts` renders the
   `delivery_test` email and sends it through the SES adapter to `EMAIL_TEST_RECIPIENT`
   (default `EMAIL_FROM`). Without row 7 it skips with a notice naming the row; with row 7 set
   and no adapter wired in yet it fails, so it never passes silently. The substitute that
   passes now: the render, guard and `MemorySender` suites.
5. **Browser tests in CI.** This stream cannot add a workflow, so the axe tests run in
   `ci.yml`'s `node` job, which installs no browser. The launcher uses, in order,
   `RAMPSMITH_CHROMIUM_PATH`, the Chromium that the locked `playwright-core` installs when it
   is present (as in the `e2e` job), and otherwise `@sparticuz/chromium` 153.0.0, whose npm
   package ships a Chromium 153 build that needs no download. It runs with every network
   request blocked, on fixture HTML only.

## Consequences

- The SES adapter is a small module: build the MIME message from a `RenderedEmail`, call SES,
  store the idempotency key; every policy check is already in `guardSender`.
- `ctl` needs no email code.

## Integration steps

1. Move `email.send` to the engine (plan correction below) and give its payload schema
   `{ kind: string, input: object }` in `crates/contracts`.
2. Build the unsubscribe endpoint (one-click POST without cookies, 60-day validity, effect
   within 48 hours, ADR-191) and the email preferences page; store suppressions so the worker
   skips unsubscribed recipients before rendering.
3. Write the SES adapter against `EmailSender` (checking the SES API in its official documentation
   at that time), wrap it in `guardSender`, and return it from `liveSender()` in
   `packages/email/test/live.test.ts`.
4. Add the LAUNCH.md E row below.

## Plan correction

- PLAN §10 "Queues": move `email.send` from `ctl` to the engine ("rendered by
  `packages/email`, sent through the SES adapter; ADR-194"); PLAN §6 components table: remove
  "email" from `ctl`'s duties and add it to `engine`'s.
- LAUNCH.md E, new row: "Test email delivered through Amazon SES | 7 | `packages/email`
  render, guard and MemorySender suites (`pnpm --filter @rampsmith/email test`) | with row 7
  set: `pnpm --filter @rampsmith/email exec vitest run test/live.test.ts`".
