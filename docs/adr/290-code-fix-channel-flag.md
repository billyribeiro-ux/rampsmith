# ADR-290: The pull-request channel is behind a server-side flag, off in the App Store build

- Status: Accepted
- Date: 2026-10-23
- Relates to: ADR-004, ADR-141

## Context

PLAN §15 makes pull requests to the merchant's own theme repository a Shopify fix channel. Shopify's
App Store review looks at what an app can do to a store, and a GitHub-connected code channel is the
part of Rampsmith that is hardest to explain in a review. The founder wants the channel built and
proven, and able to be left out of the build that is submitted (a founder decision, to be taken
with the submission, LAUNCH.md section C row 13).

The channel never writes a theme file through Shopify (ADR-004): it opens a pull request on a
branch of the merchant's own repository, and the merchant merges it.

## Decision

`CODE_FIX_CHANNEL_ENABLED` is read by `api` and `ctl` (and set by `infra/railway/railway.py` from
the deploy input `RAMPSMITH_CODE_FIX_CHANNEL`, default `false`). Only the exact values `true` and
`false` are accepted; anything else stops the process at boot, so a typo cannot silently leave the
channel in the wrong state.

While it is `false`:

- `api` has no GitHub client. `GET /v1/shopify/code-fixes` answers `enabled: false` (the screen
  explains itself); every other route of the channel answers 404 as if it did not exist, and
  `/v1/github/callback` does too.
- `/webhooks/github` acknowledges every delivery and drops it without reading the body.
- `ctl` has no GitHub client and does not serve the `github.*` queues. A `github.*` job that
  somehow exists ends with the permanent failure `code_fix_channel_off`; a stored delivery is
  marked processed and dropped.
- The App Home does not show the "Code fixes" navigation entry.
- The GitHub App's secrets can be set while the flag is off; they are not read.

The flag is a server setting, not a per-merchant one: a merchant cannot turn it on.

## Consequences

The App Store build is the same code as the channel build, with the flag off. Turning it on is a
deploy input, not a rebuild. The plan gate (`github_pull_requests`: Starter and above) applies on
top of the flag: both must allow a merchant to connect GitHub.

Tests: `crates/api/src/config.rs` (the flag and its typos), `crates/api/tests/github_channel.rs`
(`while_the_channel_is_off_...`), `crates/api/tests/github_webhook.rs`
(`while_the_channel_is_off_...`), `crates/ctl/tests/github.rs` (`while_the_channel_is_off_...`),
`infra/railway/tests/test_railway.py`.

## Rejected alternatives

- A build-time Cargo feature: a second artifact to test and to deploy, and the flag has to be
  readable at run time by the screen anyway.
- A per-shop flag in the database: a merchant-reachable switch for the part of the app a reviewer
  worries about.
