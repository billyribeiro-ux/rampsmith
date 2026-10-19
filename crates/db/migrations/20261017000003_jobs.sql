-- The cross-language job queue (PLAN §10, ADR-003, ADR-018).
--
-- Workers in Rust (ctl) and TypeScript (engine) claim jobs across tenants, so the worker role
-- sees every job. The application role only enqueues and reads jobs of the tenant its
-- transaction is scoped to. System jobs (scheduler, retention) have no tenant.

create table jobs (
  id uuid primary key,
  queue text not null check (queue ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$'),
  payload_schema text not null check (payload_schema ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+@[0-9]+$'),
  payload jsonb not null,
  tenant_id uuid references tenants (id),
  priority smallint not null default 0,
  state text not null check (state in ('ready', 'running', 'succeeded', 'failed', 'dead', 'cancelled')),
  attempts int not null default 0 check (attempts >= 0),
  max_attempts int not null default 8 check (max_attempts > 0),
  run_at timestamptz not null default now(),
  locked_by text,
  locked_until timestamptz,
  idempotency_key text unique,
  parent_id uuid references jobs (id),
  traceparent text check (traceparent ~ '^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$'),
  last_error jsonb,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  -- A running job always holds a lease; nothing else does.
  check ((state = 'running') = (locked_by is not null and locked_until is not null)),
  check ((state in ('succeeded', 'failed', 'dead', 'cancelled')) = (finished_at is not null))
);
create index jobs_ready on jobs (queue, priority desc, run_at) where state = 'ready';
create index jobs_leases on jobs (locked_until) where state = 'running';
create index jobs_tenant on jobs (tenant_id) where tenant_id is not null;
create index jobs_dead on jobs (queue, finished_at desc) where state = 'dead';

alter table jobs enable row level security;
create policy workers_see_every_job on jobs
  to rampsmith_worker
  using (true)
  with check (true);
create policy tenants_see_their_own_jobs on jobs
  to rampsmith_app
  using (tenant_id = (select app_current_tenant()))
  with check (tenant_id = (select app_current_tenant()));

grant select, insert, update, delete on jobs to rampsmith_worker;
grant select, insert on jobs to rampsmith_app;
