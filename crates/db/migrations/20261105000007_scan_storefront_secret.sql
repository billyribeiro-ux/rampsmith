-- The storefront password of a password-protected store, for the length of one scan (ADR-266).
--
-- `ctl` opens `sites.storefront_password_ct` with the master keys and seals the password again
-- under a key that only `ctl` and the engine hold (`RAMPSMITH_SCAN_SECRET_KEYS`), bound to the
-- scan by its context. The engine, which never holds a master key (ADR-035), opens it for that
-- one scan and clears both columns when the scan ends. Expand only: nullable columns.
alter table scans
  add column storefront_password_ct bytea,
  add column storefront_password_key_id text
    check (storefront_password_key_id ~ '^[a-z0-9_-]{1,32}$'),
  add constraint scans_storefront_password_sealed
    check ((storefront_password_ct is null) = (storefront_password_key_id is null));
