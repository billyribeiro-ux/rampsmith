# Evidence: the transactional email sender (2026-10-22)

Branch `r1-email`. ADRs 270 to 273.

## SigV4 against two independent references

- AWS's test-suite vector `get-vanilla`: signature
  `5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31`
  (`packages/email/test/sigv4.test.ts`).
- botocore 1.43.118 `SigV4Auth` on the real `SendEmail` request, with `get_current_datetime` patched to
  a fixed time (botocore ignores `context['timestamp']`); the expected signatures in the same test file
  come from that run. The fake SES in `packages/email/src/testing/fake-ses.ts` recomputes the
  signature itself, so a signer change that drifts fails `ses.test.ts`.

## The botocore cross-check of the signer

`packages/email/test/sigv4.test.ts` pins two signatures computed by botocore 1.43.118's `SigV4Auth`.
This is the script that produced them; re-run on 23 Oct 2026 in a fresh virtual environment it printed
`053b4915...69a1` without a session token and `8fdb50c7...6678` with `SESSIONTOKEN`, which are the
values the test file holds.

```python
"""Recomputes the two SES SigV4 signatures in packages/email/test/sigv4.test.ts with botocore.

Run: python -I -m venv v && v/bin/pip install botocore==1.43.118 && v/bin/python sigv4_check.py
Expected output: the two Signature= values the test file pins.
"""
from datetime import datetime, timezone
from unittest import mock

from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from botocore.credentials import Credentials

BODY = '{"Content":{"Simple":{"Body":{"Text":{"Data":"hi"}},"Subject":{"Data":"s"}}}}'
WHEN = datetime(2015, 8, 30, 12, 36, 0, tzinfo=timezone.utc)
SECRET = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY"


def signature(token):
    request = AWSRequest(
        method="POST",
        url="https://email.eu-west-1.amazonaws.com/v2/email/outbound-emails",
        data=BODY,
        headers={"Content-Type": "application/json"},
    )
    signer = SigV4Auth(Credentials("AKIDEXAMPLE", SECRET, token), "ses", "eu-west-1")
    with mock.patch("botocore.auth.get_current_datetime", return_value=WHEN):
        signer.add_auth(request)
    return request.headers["Authorization"].split("Signature=")[1]


print("without a session token:", signature(None))
print("with SESSIONTOKEN      :", signature("SESSIONTOKEN"))
```

## API facts and sources

- SES v2 `SendEmail`: botocore `service-2.json` (raw.githubusercontent.com) and the AWS API reference
  page returned by search. Errors, header limits, tracking override and subject encoding are in ADR-270.
- Not reachable: `docs.aws.amazon.com/ses/latest/dg/send-email-concepts-email-format.html`. DKIM
  coverage of `List-Unsubscribe` is therefore a live check (LAUNCH.md section E).
- Shopify Admin API 2026-10 `Shop.email` (shopify.dev): a `String!`, the shop owner's address.
- npm: `@aws-sdk/client-sesv2` 3.1156.0, Apache-2.0, nine direct dependencies (not adopted).

## Tests run locally (PostgreSQL 18.4, fresh databases)

| Suite | Command | Result |
| --- | --- | --- |
| `packages/email` | `pnpm --filter @rampsmith/email exec vitest run` | 819 passed, 1 skipped (the live SES test, C row 7) |
| `packages/engine` | `npx vitest run` | 264 passed before `email-send.test.ts` was added; `test/email-send.test.ts` 24 passed |
| `crates/ctl` | `cargo test -p rampsmith-ctl --test email` | 8 passed |
| `crates/db` | `cargo test -p rampsmith-db --test tenancy` | 31 passed (7 email rows) |
| `infra/railway` | `python -m unittest discover -s tests` | 88 passed |

The live test's skip notice: `email live check skipped: needs LAUNCH.md section C row 7 (SES_REGION,
SES_ACCESS_KEY_ID, SES_SECRET_ACCESS_KEY, EMAIL_FROM)`.

## What sends today

Only the uninstall export mail has a trigger (`app/uninstalled` in `crates/ctl/src/jobs/webhook.rs`).
The other 20 kinds render and can be sent by queueing `email.send@1`; their triggers are listed in
ADR-272.
