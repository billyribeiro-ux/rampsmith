-- Standalone-dashboard identity (PLAN §16, ADR-024): users, their passkeys, in-flight WebAuthn
-- ceremonies and sign-in sessions.
--
-- These rows are not tenant-owned: a user will belong to several organizations through
-- memberships (R2), so they carry no tenant_id and no tenant policy. The application reaches
-- them only through `Db::identity()` and the identity repository; workers have no grants.

create table users (
  id uuid primary key,
  email text not null unique check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  display_name text not null check (length(display_name) between 1 and 100),
  email_verified_at timestamptz,
  created_at timestamptz not null default now()
);

-- A registered passkey: public key, counter and flags as serialised by webauthn-rs. No secret.
create table passkeys (
  id uuid primary key,
  user_id uuid not null references users (id) on delete cascade,
  credential_id bytea not null unique,
  passkey jsonb not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
create index passkeys_user on passkeys (user_id);

-- Server-side state of a registration or sign-in between its two requests. Never sent to the
-- browser; single use; expires after five minutes.
create table webauthn_ceremonies (
  id uuid primary key,
  kind text not null check (kind in ('registration', 'authentication')),
  state jsonb not null,
  pending_user_id uuid,
  pending_email text,
  pending_display_name text,
  expires_at timestamptz not null,
  check ((kind = 'registration') = (pending_user_id is not null and pending_email is not null
                                     and pending_display_name is not null))
);
create index webauthn_ceremonies_expiry on webauthn_ceremonies (expires_at);

-- Sign-in sessions. Only a SHA-256 of the 256-bit token is stored (PLAN §16: 7-day idle and
-- 30-day absolute expiry).
create table web_sessions (
  token_hash bytea primary key check (length(token_hash) = 32),
  user_id uuid not null references users (id) on delete cascade,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  idle_expires_at timestamptz not null,
  absolute_expires_at timestamptz not null,
  check (idle_expires_at <= absolute_expires_at)
);
create index web_sessions_user on web_sessions (user_id);
create index web_sessions_expiry on web_sessions (absolute_expires_at);

grant select, insert, update, delete on users, passkeys, webauthn_ceremonies, web_sessions
  to rampsmith_app;
