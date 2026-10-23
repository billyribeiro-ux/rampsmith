-- The engine updates only what a run changes (audit L2, ADR-285).
--
-- Migration 20261105000008 granted `rampsmith_worker` update on every column of `free_scans`,
-- so a compromised engine could rewrite a visitor's ip_hash, domain or expiry. A run sets the
-- status, a refusal or a result, and the two times, and nothing else.
revoke update on free_scans from rampsmith_worker;
grant update (status, refusal, result, started_at, finished_at) on free_scans to rampsmith_worker;
