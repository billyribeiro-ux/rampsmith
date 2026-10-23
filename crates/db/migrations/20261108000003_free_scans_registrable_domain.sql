-- The free scanner's per-domain limit counts the registrable domain (audit L1, ADR-284).
--
-- `domain` is the host the visitor asked for, without `www.`; the cache and the join of a scan
-- already running stay keyed on it. `registrable_domain` is that host's public-suffix-list
-- registrable domain (`shop.example.co.uk` -> `example.co.uk`), computed by the api: the daily
-- cap is counted on it, so subdomains of one shop cannot each take a scan.
alter table free_scans add column registrable_domain text;
-- Rows already stored predate the column; each keeps its own host as its key until it expires.
update free_scans set registrable_domain = domain;
alter table free_scans
  alter column registrable_domain set not null,
  add constraint free_scans_registrable_domain_check
    check (char_length(registrable_domain) <= 253
           and registrable_domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
           and (domain = registrable_domain or right(domain, char_length(registrable_domain) + 1) = '.' || registrable_domain));
create index free_scans_registrable_domain on free_scans (registrable_domain, created_at);
