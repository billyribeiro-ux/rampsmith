# ADR-313: Agencies read stores through merchant-approved links, never through the tenant tables

- Status: Accepted
- Date: 2026-10-23
- Stream: R2 (agency view)
- Security-sensitive: yes

## Context

PLAN §5 R2 has an agency or company view in the standalone dashboard: one account following several
Shopify stores. Every tenant table is isolated by row-level security on `app.tenant_id` (ADR-006). A
dashboard user has no tenant. The risk is any path that lets a user read a store that did not grant it,
including by loosening row-level security or by a function that trusts its argument.

## Decision

1. **Who exists.** `organizations`, `organization_members` (role `owner` or `member`) and
   `agency_link_codes` belong to people, not tenants, like `users` (ADR-024). They are reached through
   `Db::identity()` only, with no tenant column and no tenant policy.
2. **The grant is tenant-owned.** `store_links (tenant_id, shop_id, organization_id, granted_at,
   revoked_at, revoked_by)` is a tenant table: row-level security, composite key to the shop. It is
   written by the merchant's own transaction (approve, revoke) and, for an agency's own unlink, by a
   definer function. A dashboard (identity) connection has no tenant set, so a direct select of
   `store_links`, `findings`, `scans` or any other tenant table fails (tested for five tables).
3. **The overview is one definer function**, `agency_linked_stores(user)`. It starts from the user's
   `organization_members`, joins only `store_links` with `revoked_at is null` and an installed shop,
   and returns counts and dates (pass rate, open findings, serious or critical, the latest
   undismissed regression, the latest scan's time and status). It returns no finding content, no
   address, no store contact and no setting. A store with no live link is not reachable by that
   function whatever the caller passes, because the join starts from the links.
4. **Writes check the caller in SQL.** `agency_unlink(user, link)` updates only when the user is a
   member of the link's organization. `agency_approve_link(tenant, shop, code_hash, link)` raises when
   its tenant argument differs from the transaction's tenant and when the shop is not that tenant's
   installed shop, so a Shopify session can grant only its own store. All four functions are
   `security definer` with `search_path = public, pg_temp`, revoked from `public`, executable by the
   app role only.
5. **Revocation is immediate.** There is no cache: every overview read joins the live links. A
   revoke by the merchant (App Home) or the agency (dashboard) sets `revoked_at` and `revoked_by`;
   a new code makes a new link. `shop/redact` deletes the shop's links.
6. **Cross-tenant and cross-organization attempts are `404`**: another organization's link, a link of
   another shop, a code for an organization the user is not in. No answer says whether the object
   exists.
7. **Audit.** `agency.link_approved`, `agency.link_revoked` and `agency.link_code_rejected` are
   written to the shop's audit log (no names, no codes). The agency side has no tenant to log into;
   its changes are visible to the merchant as the link vanishing.
8. The plan gate for agency features is not part of this ADR: "build the view, not agency pricing".

## Consequences

- The security auditor's checklist for this change: no policy was loosened; the four functions are the
  only cross-tenant reads; each starts from `store_links` or `organization_members`.
- Tests: `crates/db/tests/agency.rs`, the tenancy suite (`store_links` in both lists), and
  `crates/api/tests/app.rs` (full flow, unlinked store, other organization, revoke by either side,
  expired and reused codes, forged tenant argument, wrong session type).

## Rejected alternatives

- A `tenants.kind = 'organization'` tenant that owns links: it would put agencies inside the tenant
  model and let an agency's `app.tenant_id` read its own rows only, which is the opposite of the need.
- A policy on tenant tables that also lets "linked organizations" read: row-level security would then
  depend on session state for two principals, and a policy bug would expose every store.
