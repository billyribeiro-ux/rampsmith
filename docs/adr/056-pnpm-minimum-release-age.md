# ADR-056: pnpm waits a day before installing a new version, and fails rather than fall back

- Status: Accepted
- Date: 2026-10-19
- Refines: PLAN §18 (threat model, "Compromised dependency")
- Fixes: R0 security audit L15

## Context

PLAN §18 lists "a minimum release age before upgrades" among the defences against a compromised
dependency. Renovate already waits (`renovate.json`: `"minimumReleaseAge": "7 days"`), but
`pnpm-workspace.yaml` set nothing, so a person or a script running `pnpm add -E` or `pnpm update`
could install a version published minutes earlier. PLAN §18 names no value for pnpm.

What pnpm 12.14.0 does (`pnpm.io/settings/dependency-resolution`, checked on 19 Oct 2026, and
the runs below):

- `minimumReleaseAge` is a number of minutes (added in v10.16.0). Since v11 it defaults to
  `1440`; before it was `0`. It covers transitive dependencies too.
- When no version in a range is old enough, `minimumReleaseAgeStrict` decides. `false` falls
  back to a younger version; `true` fails resolution. The built-in default is non-strict, but
  "strict turns on when you set `minimumReleaseAge` yourself".
- Every install, `--frozen-lockfile` included, verifies each lockfile entry against these policies
  and prints `Lockfile passes supply-chain policies`. The result is cached by the lockfile's
  content and the policy values (`~/.cache/pnpm/lockfile-verified.jsonl`).
- `minimumReleaseAgeExclude` exempts packages, or exact versions, by name.

## Decision

`pnpm-workspace.yaml` sets, explicitly:

```yaml
minimumReleaseAge: 1440
minimumReleaseAgeStrict: true
```

One day is the value the architect set for this change, since PLAN names none; it equals pnpm's
own default, so ordinary installs behave as they did, and Renovate's seven days still governs the
weekly update PRs. What changes is that the setting is now committed rather than inherited from a
default that a pnpm release can change, and that it fails resolution
(`ERR_PNPM_NO_MATURE_MATCHING_VERSION`) instead of quietly installing a younger version. In an emergency, such as a security fix published today, name the exact version
under `minimumReleaseAgeExclude` and say why in an ADR.

## Evidence

- `pnpm install --frozen-lockfile` on the branch after the change: `Lockfile passes
  supply-chain policies`, lockfile unchanged. The workspace state records
  `minimumReleaseAge: 1440` and `minimumReleaseAgeStrict: true`.
- A fresh verification (`--config.minimumReleaseAge=1441`, so the cache cannot answer): `Lockfile
  passes supply-chain policies (444 entries in 2.2s)`. With `--config.minimumReleaseAge=100000`
  (about 69 days) it fails and lists the entries that are younger, such as
  `@inlang/paraglide-js@2.29.0` (15 Oct 2026) "and 150 more": frozen installs do enforce the
  policy against the lockfile, which also means a lockfile entry younger than a day would stop CI
  until it matures.
- Strictness, in an empty project with `minimumReleaseAge: 99999999`: `pnpm add -E is-odd` fails
  with `ERR_PNPM_NO_MATURE_MATCHING_VERSION`; adding `minimumReleaseAgeStrict: false` makes it
  install `is-odd@3.0.1`.

## Consequences

- A version younger than a day cannot be added or updated to, by anyone, until it ages or is
  excluded by exact version.
- `ci.yml` is unchanged: CI's frozen install reads the same file.
- `trustPolicy` (pnpm's check that a package's provenance has not weakened) is a separate
  setting that this ADR does not turn on.

## Plan correction

PLAN §18's "a minimum release age before upgrades" has no value. It is one day for pnpm
(`minimumReleaseAge: 1440`, strict) and seven days for Renovate.

## Rejected alternatives

- Rely on pnpm's built-in default: it is non-strict, so the protection silently disappears
  whenever one range has no mature version, and it can change with a pnpm release.
- Seven days for pnpm as for Renovate: delays urgent fixes that a person installs by hand, which
  the exclude list would have to override each time.
