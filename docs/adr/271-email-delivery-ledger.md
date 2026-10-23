# ADR-271: The delivery ledger and retries

- Status: Accepted
- Date: 2026-10-22
- Stream: R1 email sender (`crates/db`, `packages/engine`)

## Context

SES cannot de-duplicate, and the queue is at least once. A job that sends and then crashes before
acknowledging must not send again.

## Decision

- `email_deliveries(tenant_id, message_key, template, state, tries, message_id, error_code)` with
  row-level security, primary key `(tenant_id, message_key)`. The contract's `message_key`
  (`email.send:{key}` is the queue idempotency key) names a message once.
- `begin` inserts a `sending` row or bumps `tries` for a row in `sending` or `failed`; a `sent` or
  `suppressed` row makes the job a no-op. A crash between SES accepting and `sent` being written
  can still repeat one send (a window of one statement); it is recorded as the known limit.
- Transient SES errors become `JobFailure('defer')`, which does not spend a queue attempt. The delay is
  the larger of SES's `Retry-After` and `retryDelayMs(tries)`. After 24 tries the job fails
  permanently with `email_gave_up`, so a send cannot defer for ever.
- Rows hold codes, never addresses or bodies; the isolation suite asserts the columns.
