# ADR-298: Which theme files are read, and how long they are kept

- Status: Accepted
- Date: 2026-10-23
- Relates to: ADR-294 (read guards), ADR-296

## Decision

ctl reads, from the connected branch only: Liquid in `layout/`, `sections/`, `snippets/`, `blocks/`
and `templates/`; JSON in `sections/`, `templates/`, `config/` and `locales/`; and `assets/*.css`,
`*.css.liquid`, `*.scss.liquid`. The JSON and CSS are needed because the mapper resolves which
section a template renders, the settings that feed an attribute, and the selectors that decide a
contrast change. Limits: 800 files, 1 MiB each, 16 MiB in all; a bigger theme is a failed batch with
a code, never a partial read.

The files are the merchant's code. They live in `code_fix_files` (row-level security, tenant owned)
for the length of one batch. They are deleted when the batch ends, with or without a pull request,
and on a final failure. The `app` role cannot delete them; the `worker` role can. Nothing from them
is logged.

## Consequences

The tables hold the theme for minutes, not for the account's life, and the redaction path needs no
special case for them beyond the tenant's rows.
