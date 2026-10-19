# ADR-154: `rsctl` dependencies, and `SigV4` written by hand

- Status: Accepted
- Date: 2026-10-19

## Context

CLAUDE.md: check every dependency's current version and peer ranges on the live registry before
adding it; never use a version from memory. `deny.toml` denies multiple versions of a crate
(`multiple-versions = deny`), CI runs `cargo machete`, and PLAN §7 pins `aws-sdk-s3` 1.152.0 for
Cloudflare R2 through the S3 API.

`rsctl doctor` calls two AWS-signed APIs: R2's S3 endpoint (row 6) and SES v2 (row 7). Together
that is four request shapes: R2 `PUT`, `GET` and `DELETE` on one object, and SES `GET`.

## Decision

### Dependencies

Checked with `cargo search` and `cargo info` against crates.io on 2026-10-19. Where the
workspace already pins a crate (`[workspace.dependencies]`), `rsctl` uses that pin.

| Crate | Version | Used for | Notes |
| --- | --- | --- | --- |
| `clap` | 4.6.7 (latest; rust-version 1.85, toolchain is 1.99.1) | command line | `derive` with default features off (`std`, `help`, `usage`, `error-context`, `suggestions`): no colour output, so no terminal escape codes reach a log |
| `jsonwebtoken` | 11.1.0 (workspace pin; latest) | the GitHub App JWT | adds the `use_pem` feature to the workspace pin for RSA PEM keys; the feature brings `pem` 3.0.6 and `simple_asn1` 0.6.4 |
| `reqwest` | 0.13.5 (workspace pin; latest line) | HTTP | the workspace's rustls feature set; redirects off in code |
| `hmac`, `sha2` | workspace pins | `SigV4`, hashes | |
| `time` | 0.3.55 (workspace) plus `parsing` | dates, RFC 2822 `Date` header | |
| `secrecy`, `zeroize`, `url`, `serde`, `serde_json`, `thiserror`, `anyhow`, `tokio` | workspace pins | | `anyhow` only in `main.rs` |
| `crypto`, `shopify` | workspace crates | key ring format; `ShopDomain` and `API_VERSION` | no new copy of either |
| `libtest-mimic` (dev) | 0.8.2 (latest; rust-version 1.65) | the `live` test binary (ADR-155) | adds `anstream`, `anstyle*`, `colorchoice`, `escape8259`, `utf8parse` and friends, all single-version |
| `aws-lc-rs` (dev) | 1.18.2 (latest; rust-version 1.71) | RSA test keys for the GitHub JWT fake | already in the tree through `jsonwebtoken` and `rustls`; no new crate |
| `wiremock`, `base64` (dev) | workspace pins | local fake servers | |

`cargo deny --locked check` (advisories, bans, licences, sources) and `cargo machete` pass with
these. The change to `Cargo.lock` adds 19 packages: `clap` (4 crates) and `libtest-mimic` with
its terminal-colour dependencies, `pem`, `simple_asn1`, `strsim`, and `rampsmith-rsctl` itself.

### `SigV4` by hand, for `rsctl` only

`crates/rsctl/src/sigv4.rs` implements AWS Signature Version 4 header signing (about 240 lines:
canonical request, string to sign, derived key, `Authorization` header) instead of depending on
`aws-sdk-s3` and `aws-sdk-sesv2`.

- Size: `aws-sdk-s3` 1.152.0 resolves to 180 packages in its default normal-dependency tree
  (`cargo tree --prefix none -e normal`, measured on 2026-10-19), 58 of them not in this
  repository's `Cargo.lock` at the same version, before `aws-sdk-sesv2`. For four requests.
- Correctness is checked against AWS's own vectors, not against itself (`tests/sigv4.rs`): the
  ten cases of `aws-signing-test-suite/v4` that apply to header signing (vanilla `GET` and
  `POST`, duplicate header names, header value trimming, unreserved and UTF-8 paths, empty and
  reordered query keys, form body), plus the two worked examples in the Amazon S3 API reference
  ("Authenticating Requests: Using the Authorization Header", the `GET` with a `Range` header and
  the `PUT` with a `$` in the key). The substitute fakes for R2 and SES also recompute the
  signature from each request they receive and reject a mismatch.
- One rule the AWS page leaves out and `botocore`'s `auth.py` states: every service except S3
  URI-encodes the already-encoded request path a second time. `PathMode::S3` and
  `PathMode::Standard` carry it, and a test covers both.
- Scope: header-based signing of requests with an in-memory body and no session token. No
  presigned URLs, streaming or chunked bodies, `UNSIGNED-PAYLOAD`, or `x-amz-security-token`;
  none of the four requests needs them. R2 uses region `auto`, service `s3` and a signed
  `x-amz-content-sha256`; SES uses the account's region, service `ses`.
- Docs: <https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html>;
  <https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html>;
  <https://github.com/awslabs/aws-c-auth/tree/main/tests/aws-signing-test-suite/v4>;
  <https://github.com/boto/botocore/blob/develop/botocore/auth.py>.

### Plan correction

PLAN §7 lists `aws-sdk-s3` 1.152.0 for "Cloudflare R2 through the S3 API". That row stands for the
product code that writes evidence and backups. It does not apply to `rsctl`, which signs its own
four requests. Add "(not used by `rsctl`: ADR-154)" to that row when the plan is next edited
(PLAN.md is outside this stream's paths; recorded as an integration note).

## Consequences

- `rsctl` builds without the AWS SDK, so `cargo deny` needs no exceptions for it.
- The signer is security-relevant code that the repository now owns. It is small, vector-tested,
  and used only for read-mostly probes; the `security-auditor` review owed for this stream covers
  it.
- If a later probe needs presigned URLs or streaming, it should adopt the SDK for that case
  rather than extending the signer.

## Rejected alternatives

- `aws-sdk-s3` and `aws-sdk-sesv2`: see Size above.
- `aws-sigv4` (the SDK's signing crate alone): it is the same family of dependencies
  (`aws-smithy-*`, `aws-credential-types`), and its API wants SDK types.
- Shelling out to `aws` or `curl --aws-sigv4`: a new runtime dependency on the operator's machine,
  and the secret key would appear in the process arguments.
