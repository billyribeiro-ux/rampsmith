# ADR-125: GitHub REST client conventions

- Status: Accepted
- Date: 2026-10-17
- Stream: WS-3 (`crates/github`)

## Context

The fix channel needs blobs, trees, commits, refs, pull requests and check runs through the REST
API (PLAN §15), spans and metrics per PLAN §21 and ADR-019, and typed errors the queue can retry
or give up on (PLAN §10). Checked on docs.github.com on 2026-10-17:

- [API versions](https://docs.github.com/en/rest/about-the-rest-api/api-versions): supported
  `2026-03-10` and `2022-11-28` (until 10 March 2028); without `X-GitHub-Api-Version` requests
  get 2022-11-28; an unsupported version answers 410. The
  [2026-03-10 breaking changes](https://docs.github.com/en/rest/about-the-rest-api/breaking-changes)
  touch none of the Git database or check-run endpoints used here; pull request responses lose
  `merge_commit_sha`, which this crate does not read.
- [Git database](https://docs.github.com/en/rest/git): create blob (`content`, `encoding`
  utf-8 or base64, 201 `sha`), create tree (`base_tree`, `tree[]` of `path`, `mode`, `type`,
  `sha`; 201), create commit (`message`, `tree`, `parents`; author defaults to the authenticated
  identity; 201), get ref (`heads/<branch>`, 404 when absent), create ref (`refs/heads/…`, 201,
  422 when it exists), update ref (`sha`, `force` default false; 422 when not a fast-forward),
  get tree (`recursive`, `truncated`), get blob (raw with `application/vnd.github.raw+json`).
- [Pulls](https://docs.github.com/en/rest/pulls/pulls): list with `head=owner:branch`, `base`
  and `state`; create (`title`, `head`, `base`, `body`; 201); update (`title`, `body`; 200).
- [Check runs](https://docs.github.com/en/rest/checks/runs): only GitHub Apps create them; the
  update endpoint takes `name`, `details_url`, `external_id`, `status`, `conclusion`,
  `completed_at` and `output` (no `head_sha`); `conclusion` is required when `status` is
  completed.
- [Rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api):
  installations get 5,000 to 12,500 requests an hour; limits answer 403 or 429; primary limits
  set `x-ratelimit-remaining: 0` and `x-ratelimit-reset` (epoch seconds); secondary limits may set
  `retry-after`, and otherwise clients wait at least a minute; at most 80 content-creating
  requests a minute.
- [Permissions](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps):
  Git database writes need Contents write; check runs need Checks write.

## Decision

1. **Headers.** Every request sends `Accept: application/vnd.github+json` (raw for blob
   reads), `X-GitHub-Api-Version: 2026-03-10`, `User-Agent: rampsmith` and `Authorization:
   Bearer`, the last marked sensitive.
2. **Transport.** `reqwest` with rustls, a 30-second timeout, **no redirects** (a redirect could
   carry the `Authorization` header elsewhere; a 3xx becomes `UnexpectedStatus`), no proxy, and a
   16 MiB response cap read chunk by chunk. The base URL must be `https`; plain `http` is allowed
   only on loopback for tests, and URLs with credentials, a query or a fragment are refused.
3. **Paths** are built only from validated identifiers (`RepoRef`, `Sha`, `BranchName`,
   `ThemePath`, numeric ids), whose character sets need no encoding; queries go through `url`.
4. **Errors.** 401 `Unauthorized` (evicts the cached token), 403 `Forbidden { message }`, 404
   `NotFound`, 409 `Conflict { message }`, 422 `Validation { message }`, 5xx `Server`, anything
   else `UnexpectedStatus`. A 403 or 429 is `RateLimited { kind, retry_after }` when
   `retry-after` is present (that many seconds), when `x-ratelimit-remaining` is `0` (until
   `x-ratelimit-reset`), or when it is a 429 or its message mentions a rate limit (one minute);
   waits are clamped to 1 second to 1 hour. GitHub's `message` is kept as one line of at most 300
   characters. JSON errors keep only category, line and column, because `serde_json` messages can
   quote the offending value (a test feeds a token-shaped value). `is_retryable` is true for rate
   limits, 5xx and transport failures; `retry_after` hands the queue the wait.
5. **Fix flow.** `Repository::push(plan, base, update)`: base commit's tree, then per fix the
   blobs (base64, so bytes arrive exactly), a tree on the previous tree, and a commit on the
   previous commit; then `set_branch` creates the ref, leaves it if already there, or moves it
   with `force` only for `RefUpdate::Rederive`. Requests are sequential, which keeps a 20-file
   batch well under the content-creation limit. `open_or_update_pull_request` lists open pull
   requests for the head and base and updates the first, or creates one. `upsert_check_run`
   creates or updates the check run.
6. **Spans and metrics** (PLAN §21, ADR-019). Each request runs in a `github.request` span
   with `otel.kind = client`, `github.operation` (such as `github.git.create_blob`),
   `http.request.method`, `url.template` (the documented path with placeholders), and
   `github.installation_id`; then `http.response.status_code`, `github.request_id` (GitHub's
   `x-github-request-id`) and `error.type`. No concrete path, repository name, file name, header,
   token or body is recorded; a test captures every span field and event and checks. Metrics:
   `rampsmith.github.requests` (counter, by `operation` and `outcome`) and
   `rampsmith.github.request.duration` (histogram, seconds, by `operation`).

## Consequences

- Rate-limit waiting is the queue's job: the client fails fast with the wait instead of
  sleeping inside a job's lease.
- A renamed repository's 301 surfaces as `UnexpectedStatus { 301 }`; the installation events
  carry the new name.
- Owner and repository names stay out of telemetry because a user-owned repository's owner is a
  person's login (PLAN §8 "no personal data").

## Rejected alternatives

- Following redirects with header stripping: depends on the HTTP client's policy and buys
  nothing for API calls.
- Retrying inside the client: hides rate limits from the queue's backoff and lease accounting.
- Recording the concrete URL in spans: leaks repository and file names.
