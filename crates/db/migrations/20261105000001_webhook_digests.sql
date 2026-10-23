-- One row per webhook body digest, across topics (audit R1-A H1, L5). The id headers and the
-- topic header are not covered by the HMAC, so the same signed body can come back under a
-- new delivery id and a different topic. The digest key is therefore (tenant, body), and the
-- unique index makes the check-and-claim one atomic statement: two concurrent replays cannot
-- both win. `expires_at` is when the same body counts as new again.
create table webhook_digests (
  tenant_id uuid not null references tenants (id),
  body_sha256 bytea not null check (octet_length(body_sha256) = 32),
  topic text not null check (topic ~ '^[a-z_]+(/[a-z_]+)+$'),
  claimed_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (tenant_id, body_sha256)
);

-- Digests the table already knows (the old per-topic window was 24 hours).
insert into webhook_digests (tenant_id, body_sha256, topic, claimed_at, expires_at)
select distinct on (tenant_id, body_sha256)
       tenant_id, body_sha256, topic, received_at, received_at + interval '24 hours'
  from webhook_events
 order by tenant_id, body_sha256, received_at desc;

alter table webhook_digests enable row level security;
create policy tenant_isolation on webhook_digests
  using (tenant_id = (select app_current_tenant()))
  with check (tenant_id = (select app_current_tenant()));
grant select, insert, update, delete on webhook_digests to rampsmith_app, rampsmith_worker;

drop index webhook_events_body;
