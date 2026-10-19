-- Makes one dead job ready again with a fresh attempt budget, and records who did it (ADR-178).
--
--   psql ... -v job=<job uuid> -v operator=<your name> [-v reason='short cause'] \
--        -f docs/runbooks/sql/jobs-retry-dead.sql
--
-- The update is `queue::retry_dead` in crates/queue/src/ops.rs, whose own comment says the
-- operator action belongs to `rsctl jobs retry`. That command is not built (`rsctl` has `doctor`
-- and `keys` only), so this file stands in until it exists. It changes one job by id, and only
-- when that job is dead. When the job belongs to a tenant it also appends an `audit_log` row
-- (`job.retried`, actor kind `operator`), because PLAN section 18 wants every cross-tenant
-- operator action audited; a system job has no tenant, so it cannot be written to the audit log
-- (the table requires one), and the output says `audited 0`: record it in the ticket.
-- Run it only after the cause is understood (docs/runbooks/dead-letter-triage.md). Put the job
-- id and the cause in the incident or change ticket. Keep `reason` free of personal data.
--
-- Runs as `rampsmith_worker`, whose grants include update on `jobs` and insert on `audit_log`.

\set ON_ERROR_STOP on

\if :{?job}
\else
  \warn 'refused: pass the job id, for example -v job=00000000-0000-0000-0000-000000000000'
  do $$ begin raise exception 'jobs-retry-dead.sql needs -v job=<uuid>'; end $$;
\endif
\if :{?operator}
\else
  \warn 'refused: pass your name for the audit log, for example -v operator=alex'
  do $$ begin raise exception 'jobs-retry-dead.sql needs -v operator=<name>'; end $$;
\endif
\if :{?reason}
\else
  \set reason ''
\endif

set role rampsmith_worker;

begin;

\echo 'the job before'
select id, queue, state, attempts, max_attempts, finished_at,
       coalesce(last_error ->> 'code', '(none)') as code
  from jobs
 where id = :'job';

-- The audit policy checks the tenant of the transaction, so scope it to the job's tenant first.
select set_config('app.tenant_id', coalesce((select tenant_id::text from jobs where id = :'job'), ''), true)
       as tenant_scope
\gset

\echo 'retried (1 = made ready; 0 = not found or not dead, nothing changed) and audited (1 = logged)'
with retried as (
  update jobs
     set state = 'ready', attempts = 0, run_at = now(), finished_at = null
   where id = :'job' and state = 'dead'
  returning id, tenant_id, queue
),
audited as (
  insert into audit_log (id, tenant_id, actor_kind, actor_id, action, subject_type, subject_id, data)
  select gen_random_uuid(), tenant_id, 'operator', :'operator', 'job.retried', 'job', id,
         jsonb_build_object('queue', queue, 'reason', :'reason')
    from retried
   where tenant_id is not null
  returning id
)
select (select count(*) from retried) as retried, (select count(*) from audited) as audited;

commit;

reset role;
