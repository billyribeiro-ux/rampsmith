-- Lane B of R1, the scan pipeline (ADR-070 to ADR-073). Expand only, like ADR-037: columns
-- that are nullable or carry a default, one constraint swapped for a wider one.

-- A page is loaded at two viewports (PLAN §11 step 3), so the viewport joins the unique key that
-- makes recording a page idempotent. The old key is a subset of the new one, so every row that
-- satisfied it satisfies the new one.
alter table scan_pages drop constraint scan_pages_scan_id_url_page_state_key;
alter table scan_pages
  add constraint scan_pages_scan_id_url_page_state_viewport_key
    unique (scan_id, url, page_state, viewport);

-- A password-protected storefront the engine could not open is reported as blocked (ADR-071).
alter table scan_pages drop constraint scan_pages_blocked_reason_check;
alter table scan_pages
  add constraint scan_pages_blocked_reason_check
    check (blocked_reason in ('cloudflare', 'captcha', 'rate_limited', 'storefront_password'));

-- What each loaded page-state checked, for the scan's checks_run, checks_passed and coverage
-- disclosure (PLAN §11; ADR-225): the rules that ran there and how many of them passed.
alter table scan_pages
  add column rules_run text[] not null default '{}',
  add column checks_run int not null default 0 check (checks_run >= 0),
  add column checks_passed int not null default 0 check (checks_passed >= 0),
  add constraint scan_pages_checks_passed_within check (checks_passed <= checks_run);

-- Findings: best-practice results are stored apart and never counted as WCAG failures (PLAN §11
-- step 4), and each finding says how it can be fixed (ADR-072).
alter table findings
  add column best_practice boolean not null default false,
  add column fix_kind text check (fix_kind in ('data', 'code', 'manual')),
  add column fix_recipe text check (fix_recipe ~ '^[a-z][a-z0-9-]*$');

-- Where an occurrence was seen, so templates affected can be counted without guessing from URLs.
alter table finding_occurrences
  add column page_type text
    check (page_type in ('home', 'collection', 'product', 'cart', 'search', 'login', 'page', 'article')),
  add column viewport text check (viewport in ('desktop', 'mobile'));
