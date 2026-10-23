-- The code-fix pipeline of the GitHub channel (PLAN §12 and §15, ADR-295 to ADR-299): a batch is
-- one request for pull requests against the store's theme repository. `ctl` reads the theme's
-- files into it, the engine maps the open findings to those files and patches them, and `ctl`
-- opens the pull request from what the engine stored.
--
-- Expand only. Every table is tenant-owned (row-level security on `tenant_id`, composite
-- foreign keys). The theme files are the merchant's own source from their own repository; they
-- are kept only until the pull request is opened (or the batch fails), then deleted.

-- What the mapper needs to find a rendered element's source again later: the section wrapper's
-- id that held it (`shopify-section-*`), the element's ancestors up to that wrapper (tag and
-- attributes, nearest first), and, for contrast findings, what axe-core measured.
alter table finding_occurrences
  add column section_id text
    check (section_id is null or section_id ~ '^shopify-section-[A-Za-z0-9_.:-]{1,200}$'),
  add column ancestors jsonb
    check (ancestors is null or (jsonb_typeof(ancestors) = 'array'
                                 and pg_column_size(ancestors) <= 6144)),
  add column evidence jsonb check (evidence is null or pg_column_size(evidence) <= 1024);

create table code_fix_batches (
  id uuid primary key,
  tenant_id uuid not null references tenants (id),
  site_id uuid not null,
  repo_row uuid not null,
  -- Names the branch (`rampsmith/fix-<batch_id>`, audit L8 and PLAN §15).
  batch_id text not null check (batch_id ~ '^[A-Za-z0-9-]{1,64}$'),
  status text not null check (
    status in ('reading', 'patching', 'ready', 'opening', 'opened', 'nothing_to_fix', 'failed')
  ),
  base_branch text not null check (char_length(base_branch) between 1 and 200),
  -- The connected branch's head when ctl read the files: the pull request is built on it.
  base_sha text check (base_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  requested_by text check (char_length(requested_by) between 1 and 100),
  -- Which recipes the store's plan includes when the batch is requested (`core_recipes` or
  -- `every_recipe`, ADR-141); the engine plans no others.
  recipes text not null check (recipes in ('core', 'every')),
  -- What the person brought for the findings that need judgement: an accessible name (a
  -- translation key and its text) or a decorative reason, by finding id.
  judgements jsonb not null default '[]'::jsonb check (pg_column_size(judgements) <= 32768),
  -- Counts and, for each finding not fixed, why. Plain codes and numbers, no finding text.
  outcome jsonb check (outcome is null or pg_column_size(outcome) <= 65536),
  failure_code text check (failure_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, tenant_id),
  unique (tenant_id, batch_id),
  foreign key (site_id, tenant_id) references sites (id, tenant_id),
  foreign key (repo_row, tenant_id) references github_repos (id, tenant_id)
);
create index code_fix_batches_tenant on code_fix_batches (tenant_id, created_at desc);
-- One batch in flight per store: a second request waits for the first.
create unique index code_fix_batches_one_in_flight on code_fix_batches (tenant_id)
  where status in ('reading', 'patching', 'ready', 'opening');

-- The theme's files. Ordinal 0 is the file as read from the repository; ordinal N is the file
-- after the batch's Nth fix, stored only for the files that fix changed.
create table code_fix_files (
  batch_row uuid not null,
  tenant_id uuid not null,
  path text not null check (char_length(path) between 1 and 512),
  ordinal int not null check (ordinal >= 0),
  content text not null check (octet_length(content) <= 1048576),
  -- The repository blob the source was read from (ordinal 0).
  blob_sha text check (blob_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  primary key (batch_row, path, ordinal),
  foreign key (batch_row, tenant_id) references code_fix_batches (id, tenant_id)
    on delete cascade,
  check ((ordinal = 0) = (blob_sha is not null))
);
create index code_fix_files_tenant on code_fix_files (tenant_id);

-- The fixes of a batch, in commit order. The text columns are Rampsmith's own wording (a checked
-- summary, the rule's help text); a finding's page text never lands here.
create table code_fix_batch_fixes (
  batch_row uuid not null,
  tenant_id uuid not null,
  fix_id uuid not null,
  ordinal int not null check (ordinal >= 1),
  rule_id text not null check (rule_id ~ '^[a-z][a-z0-9-]*$'),
  criterion text not null check (criterion ~ '^[1-4]\.[0-9]{1,2}\.[0-9]{1,2}$'),
  summary text not null check (char_length(summary) between 1 and 100),
  finding text not null check (char_length(finding) between 1 and 300),
  primary key (batch_row, fix_id),
  unique (batch_row, ordinal),
  foreign key (batch_row, tenant_id) references code_fix_batches (id, tenant_id)
    on delete cascade,
  foreign key (fix_id, tenant_id) references fixes (id, tenant_id)
);
create index code_fix_batch_fixes_tenant on code_fix_batch_fixes (tenant_id);

do $$
declare
  t text;
begin
  foreach t in array array['code_fix_batches', 'code_fix_files', 'code_fix_batch_fixes'] loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy tenant_isolation on %I
         using (tenant_id = (select app_current_tenant()))
         with check (tenant_id = (select app_current_tenant()))',
      t
    );
  end loop;
end
$$;

-- The api records the request and answers the screen; ctl reads the files and opens the pull
-- request; the engine patches (it connects as the worker role).
grant select, insert, update on code_fix_batches to rampsmith_app, rampsmith_worker;
grant select, insert on code_fix_files, code_fix_batch_fixes to rampsmith_app, rampsmith_worker;
grant delete on code_fix_files, code_fix_batch_fixes, code_fix_batches to rampsmith_worker;
