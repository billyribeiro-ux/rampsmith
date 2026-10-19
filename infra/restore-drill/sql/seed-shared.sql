-- Rows that belong to no tenant (ADR-175): dashboard identity, which the application role
-- reaches without a tenant, and a system job, which only a worker may write.
--
--   psql -U rampsmith_api -v part=identity -f seed-shared.sql    (users, passkeys, sessions)
--   psql -U rampsmith_ctl -v part=system   -f seed-shared.sql    (the system job)
--
-- Without -v part the identity part runs.

\set ON_ERROR_STOP on

\if :{?part}
\else
  \set part identity
\endif

select :'part' = 'identity' as identity_part \gset
\if :identity_part
insert into users (id, email, display_name, email_verified_at)
select md5('user:' || g)::uuid, 'user' || g || '@example.test', 'Seed user ' || g, now()
from generate_series(1, 5) as g;

insert into passkeys (id, user_id, credential_id, passkey)
select md5('passkey:' || g)::uuid, md5('user:' || g)::uuid, decode(md5('credential:' || g), 'hex'),
       jsonb_build_object('cred', md5('cred:' || g))
from generate_series(1, 5) as g;

insert into web_sessions (token_hash, user_id, idle_expires_at, absolute_expires_at)
select decode(md5('session:' || g) || md5('token:' || g), 'hex'), md5('user:' || (1 + g % 5))::uuid,
       now() + interval '7 days', now() + interval '30 days'
from generate_series(1, 8) as g;
\else
insert into jobs (id, queue, payload_schema, payload, tenant_id, state)
values (md5('system:job')::uuid, 'retention.sweep', 'retention.sweep@1', '{}'::jsonb, null, 'ready');
\endif
