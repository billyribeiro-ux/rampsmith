-- The GitHub pull-request channel (PLAN §15, ADR-141, ADR-290 to ADR-294): which GitHub
-- installation belongs to which store, which repository is the store's theme, the pull requests
-- Rampsmith opened, and the webhook deliveries it received.
--
-- Expand only: new tables, one new function pair, nothing existing changes. Every table is
-- tenant-owned: row-level security on `tenant_id` and composite foreign keys, like the core
-- tables (ADR-006, ADR-017).

-- ---------------------------------------------------------------------------------------
-- github_install_states: the one-time `state` of an install flow (audit L7, ADR-291).
-- ---------------------------------------------------------------------------------------
-- A merchant who presses "Connect GitHub" in the embedded app gets a random state, bound to
-- their tenant and site. Only its SHA-256 is stored. The callback that GitHub sends the browser
-- to carries no Shopify session, so the state is what says which store the installation is
-- for: it is single-use and expires.
create table github_install_states (
  state_sha256 bytea primary key check (octet_length(state_sha256) = 32),
  tenant_id uuid not null references tenants (id),
  site_id uuid not null,
  created_by_ref text check (char_length(created_by_ref) between 1 and 100),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  foreign key (site_id, tenant_id) references sites (id, tenant_id),
  check (expires_at > created_at)
);
create index github_install_states_tenant on github_install_states (tenant_id);

-- ---------------------------------------------------------------------------------------
-- github_installations
-- ---------------------------------------------------------------------------------------
create table github_installations (
  id uuid primary key,
  tenant_id uuid not null references tenants (id),
  site_id uuid not null,
  installation_id bigint not null check (installation_id > 0),
  account_login text not null check (char_length(account_login) between 1 and 100),
  account_type text not null check (account_type in ('User', 'Organization', 'Enterprise')),
  repository_selection text not null check (repository_selection in ('all', 'selected')),
  status text not null check (status in ('active', 'suspended', 'deleted')),
  -- Who connected it: the Shopify staff member (`shopify:<sub>`) and the GitHub login that
  -- authorised the App, which the callback verified (ADR-291).
  connected_by_ref text check (char_length(connected_by_ref) between 1 and 100),
  connected_by_github text check (char_length(connected_by_github) between 1 and 100),
  linked_at timestamptz not null default now(),
  -- When the state above was last read from the GitHub API (audit M1): webhooks announce
  -- changes, the API is believed.
  state_read_at timestamptz,
  unique (id, tenant_id),
  foreign key (site_id, tenant_id) references sites (id, tenant_id)
);
-- One live link per GitHub installation across all stores. A deleted link frees the id.
create unique index github_installations_live on github_installations (installation_id)
  where status <> 'deleted';
-- And at most one live installation per store: a store has one theme repository.
create unique index github_installations_one_per_tenant on github_installations (tenant_id)
  where status <> 'deleted';

-- ---------------------------------------------------------------------------------------
-- github_repos
-- ---------------------------------------------------------------------------------------
create table github_repos (
  id uuid primary key,
  tenant_id uuid not null references tenants (id),
  installation_row uuid not null,
  -- GitHub's repository id survives renames and transfers; pull requests and events are
  -- matched on it, never on the name (audit L8).
  repo_id bigint not null check (repo_id > 0),
  full_name text not null check (full_name ~ '^[A-Za-z0-9._-]{1,100}/[A-Za-z0-9._-]{1,100}$'),
  default_branch text not null check (char_length(default_branch) between 1 and 200),
  is_private boolean not null default true,
  archived boolean not null default false,
  -- The installer could push to it when they connected (audit L7). Only such a repository can
  -- be chosen as the store's theme repository.
  user_can_push boolean not null default false,
  status text not null default 'available' check (status in ('available', 'removed')),
  selected boolean not null default false,
  -- The branch Shopify syncs to the live theme.
  connected_branch text check (char_length(connected_branch) between 1 and 200),
  theme_state text not null default 'unchecked' check (theme_state in ('unchecked', 'ok', 'not_a_theme')),
  theme_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, tenant_id),
  unique (installation_row, repo_id),
  foreign key (installation_row, tenant_id) references github_installations (id, tenant_id),
  check (not selected or connected_branch is not null)
);
create unique index github_repos_one_selected on github_repos (tenant_id) where selected;
create index github_repos_tenant on github_repos (tenant_id);
create index github_repos_repo on github_repos (tenant_id, repo_id);

-- ---------------------------------------------------------------------------------------
-- github_pull_requests
-- ---------------------------------------------------------------------------------------
create table github_pull_requests (
  id uuid primary key,
  tenant_id uuid not null references tenants (id),
  repo_row uuid not null,
  repo_id bigint not null check (repo_id > 0),
  number bigint not null check (number > 0),
  github_id bigint,
  batch_id text not null check (batch_id ~ '^[A-Za-z0-9-]{1,64}$'),
  part int not null default 1 check (part >= 1),
  head_branch text not null check (head_branch like 'rampsmith/%'),
  base_branch text not null,
  -- The head GitHub reports now, and the head Rampsmith itself last pushed: a re-derive may
  -- force the branch only while the two agree (audit L3).
  head_sha text not null check (head_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  pushed_sha text not null check (pushed_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  state text not null check (state in ('open', 'closed', 'merged')),
  html_url text not null check (html_url ~ '^https://[^\s]+$'),
  check_run_id bigint,
  fix_count int not null check (fix_count >= 1),
  files int not null check (files >= 1),
  changed_lines int not null check (changed_lines >= 0),
  opened_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz,
  unique (id, tenant_id),
  -- A pull request is identified by its repository's id and its number (audit L8).
  unique (tenant_id, repo_id, number),
  unique (tenant_id, batch_id, part),
  foreign key (repo_row, tenant_id) references github_repos (id, tenant_id)
);
create index github_pull_requests_tenant on github_pull_requests (tenant_id, opened_at desc);

create table github_pr_fixes (
  pull_request_id uuid not null,
  fix_id uuid not null,
  tenant_id uuid not null,
  primary key (pull_request_id, fix_id),
  foreign key (pull_request_id, tenant_id) references github_pull_requests (id, tenant_id),
  foreign key (fix_id, tenant_id) references fixes (id, tenant_id)
);
create index github_pr_fixes_fix on github_pr_fixes (fix_id);
create index github_pr_fixes_tenant on github_pr_fixes (tenant_id);

-- ---------------------------------------------------------------------------------------
-- github_events: verified webhook deliveries, stored once, processed from the stored copy.
-- ---------------------------------------------------------------------------------------
create table github_events (
  id uuid primary key,
  tenant_id uuid not null references tenants (id),
  delivery_id text not null check (delivery_id ~ '^[A-Za-z0-9-]{1,64}$'),
  event text not null check (event ~ '^[a-z_]{1,64}$'),
  installation_id bigint not null check (installation_id > 0),
  repository_id bigint,
  body jsonb not null,
  -- The digest of the raw body. Neither the delivery id nor the event header is covered by the
  -- signature, so the same signed body can come back under a new id (audit M1): a body is
  -- stored once per tenant, whatever it arrives as.
  body_sha256 bytea not null check (octet_length(body_sha256) = 32),
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (tenant_id, delivery_id),
  unique (tenant_id, body_sha256)
);
create index github_events_received on github_events (received_at);
create index github_events_tenant on github_events (tenant_id);

-- ---------------------------------------------------------------------------------------
-- Row-level security and privileges
-- ---------------------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'github_install_states', 'github_installations', 'github_repos', 'github_pull_requests',
    'github_pr_fixes', 'github_events'
  ] loop
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

-- The api records install states, links installations, stores deliveries and answers the app's
-- screens; ctl syncs installations, builds and updates pull requests, and sweeps old rows.
grant select, insert, update on github_install_states, github_installations, github_repos,
  github_pull_requests, github_events to rampsmith_app, rampsmith_worker;
grant select, insert on github_pr_fixes to rampsmith_app, rampsmith_worker;
grant delete on github_install_states, github_events, github_repos, github_pr_fixes,
  github_pull_requests, github_installations to rampsmith_worker;

-- ---------------------------------------------------------------------------------------
-- Lookups that start before the tenant is known (ADR-022's pattern)
-- ---------------------------------------------------------------------------------------
-- The install callback arrives from GitHub's redirect with no session: the state says which
-- store it is for. Consuming it is one atomic statement, so two requests cannot both win.
create function app_github_consume_state(state bytea)
  returns table (tenant_id uuid, site_id uuid, created_by_ref text)
  language sql
  volatile
  security definer
  set search_path = public, pg_temp
as $$
  update github_install_states s
     set used_at = now()
   where s.state_sha256 = state
     and s.used_at is null
     and s.expires_at > now()
  returning s.tenant_id, s.site_id, s.created_by_ref
$$;
revoke all on function app_github_consume_state(bytea) from public;
grant execute on function app_github_consume_state(bytea) to rampsmith_app;

-- A webhook names an installation, not a tenant. The signature has been verified before this
-- is called; it returns ids and status only.
create function app_github_installation(gh_installation bigint)
  returns table (tenant_id uuid, id uuid, status text)
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select i.tenant_id, i.id, i.status
    from github_installations i
   where i.installation_id = gh_installation
     and i.status <> 'deleted'
$$;
revoke all on function app_github_installation(bigint) from public;
grant execute on function app_github_installation(bigint) to rampsmith_app, rampsmith_worker;

-- ---------------------------------------------------------------------------------------
-- The backstop and the housekeeping, across tenants (like webhook_events_sweep, ADR-088)
-- ---------------------------------------------------------------------------------------
-- A delivery is acknowledged once it and its job are stored. If `github.process_event` is lost,
-- only this sweep brings the event back:
-- - an event unprocessed for 30 minutes with no live job gets a new job, at most one per hour,
--   for 14 days after arrival;
-- - processed events are deleted after 30 days, and spent or expired install states after a day;
-- - `stuck_24h` counts events unprocessed for 24 hours or more, which ctl reports as an alert.
create function github_events_sweep()
  returns table (requeued bigint, stuck_24h bigint, oldest_seconds bigint)
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  requeued_count bigint;
begin
  with stale as (
    select e.id, e.tenant_id
      from github_events e
     where e.processed_at is null
       and e.received_at < now() - interval '30 minutes'
       and e.received_at > now() - interval '14 days'
       and not exists (
         select 1 from jobs j
          where j.queue = 'github.process_event'
            and j.state in ('ready', 'running')
            and j.payload ->> 'event_id' = e.id::text
       )
  ), queued as (
    insert into jobs (id, queue, payload_schema, payload, tenant_id, state, max_attempts,
                      idempotency_key)
    select uuidv7(), 'github.process_event', 'github.process_event@1',
           jsonb_build_object('event_id', s.id), s.tenant_id, 'ready', 8,
           'github.process_event:' || s.id || ':sweep:' || to_char(now(), 'YYYYMMDDHH24')
      from stale s
    on conflict (idempotency_key) do nothing
    returning 1
  )
  select count(*) into requeued_count from queued;
  if requeued_count > 0 then
    perform pg_notify('jobs', 'github.process_event');
  end if;
  delete from github_events
   where processed_at is not null and received_at < now() - interval '30 days';
  delete from github_install_states
   where (used_at is not null or expires_at < now()) and created_at < now() - interval '1 day';
  return query
    select requeued_count,
           count(*) filter (where e.received_at < now() - interval '24 hours'),
           coalesce(max(extract(epoch from now() - e.received_at))::bigint, 0)
      from github_events e
     where e.processed_at is null;
end
$$;

revoke all on function github_events_sweep() from public;
grant execute on function github_events_sweep() to rampsmith_worker;
