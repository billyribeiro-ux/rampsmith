-- Seeds one tenant with a full graph of rows, as the application role (ADR-175).
--
--   psql -v tenant=<uuid> -v label=<text> -v findings=<n> -v occurrences=<n> -f seed.sql
--
-- It runs as `rampsmith_api`, a member of `rampsmith_app`, and sets `app.tenant_id` first,
-- exactly like a TenantTx: row-level security applies to every insert, so the seed is also a
-- check that the policies accept the tenant's own rows. Every id derives from the label, so
-- two runs produce the same rows.

\set ON_ERROR_STOP on

begin;
select set_config('app.tenant_id', :'tenant', true) as tenant_scope \gset

insert into tenants (id, kind) values (:'tenant', 'shopify_store');

insert into sites (id, tenant_id, platform, base_url, verified_at, verification_method)
values (md5(:'label' || ':site')::uuid, :'tenant', 'shopify',
        'https://' || :'label' || '.example', '2026-10-01T00:00:00Z', 'install');

insert into shopify_shops (id, tenant_id, site_id, shop_domain, scopes, api_version, status, installed_at)
values (md5(:'label' || ':shop')::uuid, :'tenant', md5(:'label' || ':site')::uuid,
        :'label' || '.myshopify.com', array['read_products', 'read_themes'], '2026-10',
        'installed', '2026-10-01T00:00:00Z');

-- Placeholder ciphertext, as in the isolation suite: the table stores bytes it never opens.
insert into shopify_tokens (shop_id, tenant_id, access_ct, refresh_ct, key_id,
                            access_expires_at, refresh_expires_at, version)
values (md5(:'label' || ':shop')::uuid, :'tenant',
        decode(md5(:'label' || ':access'), 'hex'), decode(md5(:'label' || ':refresh'), 'hex'),
        'k20261019', '2026-10-02T00:00:00Z', '2027-01-01T00:00:00Z', 1);

insert into scans (id, tenant_id, site_id, trigger, status, ruleset_version, pages_planned, pages_done,
                   started_at, finished_at)
select md5(:'label' || ':scan:' || g)::uuid, :'tenant', md5(:'label' || ':site')::uuid,
       (array['manual', 'scheduled', 'webhook'])[1 + g % 3], 'succeeded', 'axe-4.14.0+seed',
       10, 10, '2026-10-10T10:00:00Z', '2026-10-10T10:05:00Z'
from generate_series(1, 4) as g;

insert into findings (id, tenant_id, site_id, fingerprint, rule_id, criteria, impact, status,
                      source_location, first_seen_scan, last_seen_scan, occurrence_count)
select md5(:'label' || ':finding:' || g)::uuid, :'tenant', md5(:'label' || ':site')::uuid,
       decode(md5(:'label' || g) || md5(g::text || :'label'), 'hex'),
       (array['image-alt', 'color-contrast', 'label', 'link-name'])[1 + g % 4],
       array['1.1.1'], (array['minor', 'moderate', 'serious', 'critical'])[1 + g % 4],
       (array['open', 'fixed', 'needs_review'])[1 + g % 3],
       jsonb_build_object('file', 'sections/header.liquid', 'start', g, 'end', g + 20, 'confidence', 0.93),
       md5(:'label' || ':scan:1')::uuid, md5(:'label' || ':scan:4')::uuid, 1
from generate_series(1, :findings) as g;

insert into finding_occurrences (finding_id, scan_id, tenant_id, page_url, page_state, target,
                                 html_excerpt, captured_at)
select md5(:'label' || ':finding:' || (1 + g % :findings))::uuid,
       md5(:'label' || ':scan:' || (1 + g % 4))::uuid, :'tenant',
       'https://' || :'label' || '.example/products/p' || g,
       (array['default', 'nav_open', 'cart_drawer', 'variant_changed', 'modal'])[1 + g % 5],
       'main > img:nth-of-type(' || g || ')', '<img src="/p' || g || '.jpg">', now()
from generate_series(1, :occurrences) as g;

insert into fixes (id, tenant_id, site_id, kind, channel, status, origin, model, prompt_version,
                   confidence, diff)
select md5(:'label' || ':fix:' || g)::uuid, :'tenant', md5(:'label' || ':site')::uuid,
       'data', 'admin_api', (array['proposed', 'approved', 'applied'])[1 + g % 3], 'ai',
       'claude-haiku-5-5', 'alt-text@1', 0.9,
       jsonb_build_object('resource', 'MediaImage/' || g, 'field', 'alt', 'before', '', 'after', 'Seeded alt ' || g)
from generate_series(1, 40) as g;

insert into fix_findings (fix_id, finding_id, tenant_id)
select md5(:'label' || ':fix:' || g)::uuid, md5(:'label' || ':finding:' || g)::uuid, :'tenant'
from generate_series(1, 40) as g;

insert into audit_log (id, tenant_id, actor_kind, actor_id, action, subject_type, subject_id, data)
select md5(:'label' || ':audit:' || g)::uuid, :'tenant', 'system', null, 'fix.proposed', 'fix',
       md5(:'label' || ':fix:' || (1 + g % 40))::uuid, jsonb_build_object('n', g)
from generate_series(1, 120) as g;

insert into scan_pages (id, tenant_id, scan_id, url, page_state, http_status, duration_ms, violations)
select md5(:'label' || ':page:' || g)::uuid, :'tenant', md5(:'label' || ':scan:' || (1 + g % 4))::uuid,
       'https://' || :'label' || '.example/pages/' || g, 'default', 200, 100 + g, g % 7
from generate_series(1, 200) as g;

insert into jobs (id, queue, payload_schema, payload, tenant_id, state)
select md5(:'label' || ':job:' || g)::uuid, 'scan.page', 'scan.page@1',
       jsonb_build_object('page', g), :'tenant', 'ready'
from generate_series(1, 25) as g;

commit;
