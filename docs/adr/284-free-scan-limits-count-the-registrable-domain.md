# ADR-284: The free scanner counts the registrable domain and refuses public suffixes

- Status: Accepted
- Date: 2026-10-22
- Amends: ADR-267
- Source: audit of the R1 integration, finding L1

## Context

The per-domain limit (1 scan per domain per day) was keyed on the host without `www.`, so
`a.shop.com`, `b.shop.com` and every other subdomain of one shop each took a scan. The engine's
egress token also named `.apex` (the subdomains of the scanned host), so a host that is itself a
public suffix (`co.uk`, `myshopify.com`) would have opened every site under it. The web form and
the api accepted such hosts and spent a Turnstile token on them.

## Decision

- The Public Suffix List decides. Rust: the `psl` crate 2.1.244 (MIT or Apache-2.0, registry
  release of 2026-10-21, the list refreshed daily by the project; `deny.toml` allows both
  licences). Engine: `tldts` 7.4.19 (MIT, released 2026-10-20), exact versions. Both read the
  private section too, so `store.myshopify.com` is one site and `myshopify.com` is none.
- `parse_public_url` (`crates/api/src/free_scan.rs`) computes the host's registrable domain. A host
  with none is a suffix and is refused with the new reason `suffix` (422, field `url`) **before the
  budget is read and before Cloudflare is called**. The page shows its generic "not valid"
  message for a reason it does not know.
- `free_scans.registrable_domain` (migration `20261108000003`, backfilled from `domain`) holds it.
  The daily count (`used_by_domain`) and the advisory lock are keyed on it. The 24-hour cache and
  the join of a scan already running stay keyed on the host (`domain`): `www.` and the bare host
  share a result, a different subdomain is a different site to look at but shares the day's one scan.
- `hostsFor` (`packages/engine/src/free-scan.ts`) drops the `.apex` wildcard when the apex is a
  public suffix, as a second line behind the api.

## Consequences

- One shop cannot spend several scans by varying a subdomain, and a visitor cannot ask for a
  scan of a whole suffix.
- The list is compiled into the crate and the package: it ages until the dependency is bumped
  (Renovate does this). A suffix added to the list after the build is not refused until then.
- Tests: `crates/api/src/free_scan.rs` (`the_daily_limit_is_keyed_on_the_registrable_domain`,
  `a_public_suffix_is_refused_before_anything_is_spent`), `crates/api/tests/free_scan.rs`
  (`the_daily_limit_covers_every_subdomain_of_a_registrable_domain`, suffixes never reach
  Cloudflare or the table), `crates/db/tests/free_scans.rs`, `packages/engine/test/free-scan.test.ts`.

## Rejected alternatives

- Counting the last two labels: wrong for `co.uk` and for private suffixes such as `github.io`.
- Fetching the list at run time: a new egress path and a new failure mode for a list that changes
  slowly.
