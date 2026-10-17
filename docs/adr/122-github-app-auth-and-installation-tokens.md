# ADR-122: GitHub App JWTs and installation tokens

- Status: Accepted
- Date: 2026-10-17
- Stream: WS-3 (`crates/github`)

## Context

PLAN §15 "Authentication": RS256 JWT issued 60 seconds in the past, expiring within 10
minutes, exchanged for a one-hour installation token held in memory only; the private key
lives in the environment and rotates with an overlap window. PLAN §18 adds that `secrecy` keeps
values out of logs.

Checked on docs.github.com on 2026-10-17:

- [Generating a JWT](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app):
  RS256; `iat` "60 seconds in the past" recommended against drift; `exp` "no more than 10
  minutes into the future"; `iss` "the client ID or application ID … Use of the client ID is
  recommended"; sent as `Authorization: Bearer`.
- [Managing private keys](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps):
  the download is PEM in "PKCS#1 RSAPrivateKey format"; up to 25 keys per app, for rotation
  without downtime; keys never expire.
- [Create an installation access token](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app):
  `POST /app/installations/{installation_id}/access_tokens`, JWT only; optional `repositories`
  or `repository_ids` (up to 500) and `permissions`; `201` with `token` and `expires_at`; 401,
  403, 404, 422 documented; tokens expire one hour after creation; since 27 April 2026 tokens may
  use a stateless format, so code must not assume a fixed length.

## Decision

1. **JWT.** `AppCredentials::jwt(now)` signs `{"alg":"RS256","typ":"JWT"}` and
   `{"iat": now-60, "exp": now+540, "iss": <issuer>}`. Nine minutes ahead leaves the same 60
   seconds of drift tolerance on our side that `iat` leaves on the other, and the token spans
   exactly 10 minutes. A fresh JWT is signed for each App call; none is cached. The issuer is
   the client ID (`AppIssuer::client_id`); the numeric app ID is accepted (`AppIssuer::app_id`).
2. **Key.** `AppPrivateKey::from_pem(&SecretString)` accepts PKCS#1 (`RSA PRIVATE KEY`, what
   GitHub issues) and PKCS#8 (`PRIVATE KEY`), CRLF and indentation, and environment values with
   literal `\n`. Encrypted keys and other labels are refused. The PEM text and decoded DER are
   held in `Zeroizing` buffers and wiped. Key types have no `Display`, a placeholder `Debug`, and
   errors are fixed strings.
3. **Token scope.** `TokenScope` serializes to the documented body: `repository_ids` and
   `permissions` from an enum of exactly the App's four permissions, so `workflows` cannot be
   requested. `TokenScope::fix_pull_requests(repo)` (contents, pull requests and checks write;
   metadata read) and `TokenScope::read_theme(repo)` narrow every job to one repository. More
   than 500 repositories is refused before any request.
4. **Cache.** Tokens are cached in memory per `(installation, scope)` behind one async mutex,
   so concurrent callers wait for a single refresh. A token is reused while
   `now + 5 minutes < expires_at`. Each API call asks the cache, so the margin only has to cover
   one call: the 30-second request timeout, GitHub's 60 seconds of drift, and room for a queue
   retry. Five minutes covers that several times over and costs at most one extra token an hour
   per scope. Expired entries are dropped on every refresh. A 401 on an installation call evicts
   that token, so the queue's retry mints a new one.
5. **Never serialized or logged.** `InstallationToken` has no `Serialize` (a test proves it with
   autoref specialisation), a redacting `Debug`, and exposes its value only crate-internally as an
   `Authorization` header marked sensitive. Response bodies are held in `Zeroizing` buffers.
6. **Rotation.** Key rotation is an environment change: the operator adds a new key in GitHub,
   deploys it, then deletes the old key. Because a JWT lives at most 10 minutes and tokens are
   minted from the current key, no overlap logic is needed in the client.

## Consequences

- The App needs its client ID at run time. LAUNCH.md C row 4 lists `GITHUB_APP_ID`; it should
  also list `GITHUB_APP_CLIENT_ID` (proposed to the architect; this stream does not edit
  LAUNCH.md). `GITHUB_APP_ID` still works as the issuer.
- `GitHub::app()` (`GET /app` with the JWT) is the live check LAUNCH C row 4 describes; it is
  tested only against the fake, as tests never call github.com.
- The cache mutex is held while a token is minted, so a slow mint (bounded by the 30-second
  timeout) also delays cache hits for other installations in the same process. Mints happen
  about once an hour per scope; if `ctl` ever runs enough installations for this to matter, the
  fix is a per-key single flight, with the same tests.

## Plan correction

PLAN §15 "Authentication", first bullet — replace with:

```
- The app signs a JWT with RS256 whose `iss` is the App's client ID, issued 60 seconds in the past to absorb clock drift and expiring 9 minutes ahead, so it is valid for exactly 10 minutes (GitHub's maximum) (ADR-122).
```

PLAN §15 "Authentication", second bullet — replace with:

```
- It exchanges that JWT for an installation token narrowed to one repository and the permissions the job needs. The token lasts one hour, is held in memory only, and is refreshed five minutes before it expires (ADR-122).
```

## Rejected alternatives

- Caching the JWT: saves one RSA signature (about a millisecond) per token mint and adds a
  second credential to expire correctly.
- A one-minute refresh margin: too close to the request timeout plus drift.
- Persisting tokens (even encrypted): PLAN §15 says memory only, and a lost token costs one
  request to replace.
