-- Dead jobs: a summary by queue and error code, then the newest ones (ADR-178).
--
--   \i docs/runbooks/sql/jobs-dead.sql
--   \set queue 'shopify.%'    -- optional: a LIKE pattern for the queue (default all)
--   \set code 'crypto'        -- optional: a LIKE pattern for last_error.code (default all)
--   \set limit 20             -- optional: how many jobs to list (default 50)
--   \i docs/runbooks/sql/jobs-dead.sql
--
-- A job is dead when it failed permanently or used its attempts (crates/queue/src/ops.rs,
-- `fail` and `reap_expired`). `last_error` holds `code`, `message` and `retryable`. The messages
-- are fixed strings written by the workers and carry no response bodies, but this file
-- shortens them anyway. Payloads are not printed; read one only when the triage needs it, and
-- never paste it into a ticket.
--
-- Runs as `rampsmith_worker`, which sees every job and nothing tenant-owned.

\set ON_ERROR_STOP on

\if :{?queue}
\else
  \set queue '%'
\endif
\if :{?code}
\else
  \set code '%'
\endif
\if :{?limit}
\else
  \set limit 50
\endif

set role rampsmith_worker;

\echo 'dead jobs by queue and error code'
select queue,
       coalesce(last_error ->> 'code', '(none)') as code,
       count(*) as jobs,
       min(finished_at) as first_dead,
       max(finished_at) as last_dead
  from jobs
 where state = 'dead'
 group by 1, 2
 order by jobs desc, queue, code;

\echo 'newest dead jobs matching the queue and code patterns'
select id,
       queue,
       tenant_id,
       attempts,
       max_attempts,
       finished_at,
       coalesce(last_error ->> 'code', '(none)') as code,
       left(last_error ->> 'message', 120) as message
  from jobs
 where state = 'dead'
   and queue like :'queue'
   and coalesce(last_error ->> 'code', '(none)') like :'code'
 order by finished_at desc
 limit :limit;

reset role;
