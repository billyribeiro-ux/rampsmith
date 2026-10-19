# ADR-224: Remediation log export: CSV and versioned JSON

- Status: Accepted
- Date: 2026-10-18
- Stream: WS-13 (reports and statement generator)

## Context

PLAN §16: "Remediation log export: every fix, its finding, criterion, approver, date and
verification result." PLAN §5 lists what each fix carries (the finding and its criterion, before
and after evidence, the exact change, who approved it and when, the undo, the verification
scan), and PLAN §19 keeps the record for the life of the account and exportable at any time.
Merchants open CSV in Excel, LibreOffice or Google Sheets, where a cell starting with `=` runs as
a formula; product titles and alt text are merchant- and AI-written, so they can start with one.
OWASP's CSV injection page (https://owasp.org/www-community/attacks/CSV_Injection) redirects to
community.owasp.org, which this environment could not fetch on 18 October 2026. Its remediation,
as summarized with a link to it by
https://www.bennadel.com/blog/4330-remediating-csv-injection-attacks-in-coldfusion.htm (read the
same day): quote fields, escape embedded quotes, and prepend a single quote when a field starts
with `=`, `+`, `-`, `@`, tab (0x09) or carriage return (0x0D). The security-auditor reviews the
guard against that list.

## Decision

1. **CSV**: RFC 4180, every field double-quoted with quotes doubled, CRLF row endings, a UTF-8
   byte-order mark so Excel reads the encoding. A field whose first non-blank character is `=`,
   `+`, `-`, `@`, tab, carriage return, line feed, or the full-width `＝ ＋ － ＠` gets a leading
   apostrophe. The same characters after a comma, semicolon, tab or line break inside a field
   get one too, because Excel in many EU locales splits on `;` and a parser that ignores quotes
   would start a new cell there (security audit; LibreOffice 24.2.7 keeps quote state and is
   not affected). Values longer than 32,000 characters are cut with "…" (a cell holds 32,767);
   JSON keeps every value exactly.
2. One CSV row per finding a fix resolves, oldest fix first (ties by fix id), 22 columns:
   fix id, type, channel, written by, AI model, fix status, rule, finding id, WCAG criteria,
   impact, finding, what changed, before, after, proposed, approved by, approved, applied,
   verification result, verification scan, verified, undoes fix. Headers and enum labels are
   translated; timestamps are ISO 8601 in UTC to the second, so every spreadsheet reads them
   alike.
3. **JSON**: `{"format": "rampsmith.remediation-log", "version": 1, ...}` with one entry per fix
   and its findings nested, enum values as stored (PLAN §9), and `<`, `>`, `&`, U+2028 and U+2029
   written as `\u` escapes so the file is safe to embed in HTML or a script.
4. **Verification result** from the fix status: verified → `passed`, failed → `failed`,
   applied → `pending`, proposed/approved/applying → `not_applied`, reverted → `reverted`,
   rejected → `rejected`. A verified fix must name its verification scan and time.
5. The approver is `{kind: "user", name}` or `{kind: "system"}`, rebuilt field by field so no
   other property the caller attached reaches the export; the caller supplies the display
   name. The export is the merchant's own record, so it carries the name, which is personal data
   of the merchant's staff; it is never logged.

## Plan correction

- PLAN §16 "Reports", remediation log bullet, append: "as CSV (RFC 4180, formula-injection guard)
  and versioned JSON, one CSV row per finding a fix resolves (ADR-224)".
- PLAN §9 / `crates/db`: the export needs, per fix, `verified_scan` with the scan's
  `finished_at`, `reverts`, and the approver's display name from `users`. `db::repo::fixes::Fix`
  does not return `verified_scan` or `reverts` yet; the main builder adds them to the repository
  (no migration: the columns exist).

## Consequences

- An apostrophe-prefixed cell shows the apostrophe in some tools; the JSON keeps the exact
  value.
- A future column is appended, never inserted, so spreadsheets built on the export keep working;
  a breaking JSON change bumps `version`.

## Rejected alternatives

- XLSX: a binary format and a dependency for what CSV and JSON already serve.
- One CSV row per fix with findings joined: harder to filter by criterion, which is how
  merchants and their lawyers read the record.
