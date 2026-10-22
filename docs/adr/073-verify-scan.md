# ADR-073: Verification scan semantics

- Status: Accepted
- Date: 2026-10-22
- Source: R1 lane B

## Decision

`verify.scan@1` proves "the finding is gone and nothing new appeared". It re-audits the `verify` input (data fixes) and rescans the affected URLs with the same rules. Success requires that the finding's fingerprint is absent and that no fingerprint exists that the prior scan did not know. On success it sets `fixes.verified_scan`, `verified_at` and status `verified`; otherwise the scan ends with `error_code` `verify_finding_remains`, `verify_new_findings` or `verify_unreadable`, and the finding is reopened. A verification scan is finalized by the handler itself, never by `scan.finalize@1`.

For an alt text fix, the after-evidence crop is taken from `img[alt="<new alt>"]`.
