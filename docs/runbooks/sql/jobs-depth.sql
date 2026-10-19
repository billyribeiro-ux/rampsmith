-- Queue depth and age, for the dead-letter and webhook-backlog runbooks (ADR-178).
--
-- The same statement as `queue::depth` in crates/queue/src/ops.rs: jobs waiting (`ready`),
-- running or dead per queue, and for `ready` how long the oldest due job has been runnable.
-- Run from a checkout, connected to the database through a tunnel or `railway connect postgres
-- --ssh`:
--
--   \i docs/runbooks/sql/jobs-depth.sql
--
-- It runs as `rampsmith_worker`, the role of `ctl` and `engine`: it sees every job and nothing
-- tenant-owned. A superuser or `rampsmith_ctl` may run it; both can `set role` to the group.

\set ON_ERROR_STOP on

set role rampsmith_worker;

select queue,
       state,
       count(*) as jobs,
       round(extract(epoch from now() - min(run_at) filter (where state = 'ready' and run_at <= now()))::numeric, 1)
         as oldest_ready_seconds
  from jobs
 where state in ('ready', 'running', 'dead')
 group by queue, state
 order by queue, state;

reset role;
