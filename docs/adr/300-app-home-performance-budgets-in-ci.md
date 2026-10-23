# ADR-300: App Home Core Web Vitals budgets are measured in CI on a throttled mobile profile

- Status: Accepted
- Date: 2026-10-23
- Stream: R2 (performance and App Review)

## Context

PLAN §5's R2 exit criterion: "admin LCP, CLS and INP inside Built for Shopify thresholds in
CI". PLAN §23 sets stricter budgets so production has headroom: LCP under 2.0 s, CLS under 0.05,
INP under 150 ms on a mid-tier device, and 150 KB of compressed JavaScript for the embedded admin.

Built for Shopify's thresholds, read on 23 October 2026 from
[Achievement criteria](https://shopify.dev/docs/apps/launch/built-for-shopify/achievement-criteria)
(through the documentation fetcher; `curl` to `shopify.dev` is blocked by the proxy, and
`Shopify/shopify-dev` is not public on GitHub; no Shopify npm package carries these values):

- 2.1: "it needs to meet Web Vitals targets for the following metrics, at the 75th percentile of
  page loads".
- 2.1.1 "Your app's Largest Contentful Paint (LCP) is 2.5 seconds or less."
- 2.1.2 "Your app's Cumulative Layout Shift (CLS) is 0.1 or less."
- 2.1.3 "Your app's Interaction to Next Paint (INP) is 200 milliseconds or less."
- Each needs "a minimum of 100 calls ... over the last 28 days to be assessed". "Shopify uses Web
  Vitals to determine the performance of your app in the Shopify admin", and collecting them
  needs the latest App Bridge.

A second, independent source (a third-party summary, Power Commerce) gives the same three
numbers and says Shopify reports daily and 28-day p75 values. The change log
[performance integration and category specific requirements](https://shopify.dev/changelog/posts/performance-integration-and-category-specific-requirements-come-into-practice.md)
says admin performance must "meet 75th percentile Web Vitals targets", CLS 0.1 or less, INP 200 ms
or less, enforced from 2 January 2025.

`web-vitals` is Google's library, the standard way to measure these metrics; 6.2.3 is the latest
release on npm (published 5 October 2026, Apache-2.0, no dependencies); `npm view web-vitals`.

## Decision

1. **Measurement.** Playwright project `app-perf` (`apps/web/tests/perf-app-home.spec.ts`,
   `perf-helpers.ts`) opens every App Home screen (overview, overview of a new install through its
   first scan, issues, issue detail, fixes, remediation log, statement, settings) on a fresh
   context against the typed fake api and the built app. `web-vitals` 6.2.3 (exact, devDependency
   of `apps/web`) is read from the pinned npm package and injected into every document before the
   app runs: nothing comes from a CDN, and the app's own bundle is untouched. Its attribution
   build names the element behind a failure.
2. **Profile.** A 412 x 915 phone at device scale 2, CPU 4x slower, 150 ms round trip, 1.6 Mbps
   down and 750 Kbps up through the DevTools protocol: Lighthouse's mobile preset, a mid-tier
   device on slow 4G. The browser cache is cold on every load, which is the worst case.
   Shopify's Polaris and App Bridge scripts come from Shopify's CDN and the tests answer them with
   the Polaris shim (ADR-094), so their cost is not measured; the local server speaks HTTP/1.1
   with six connections, which a production edge may not.
3. **Statistic.** LCP and CLS come from 5 cold loads per screen; INP and the CLS of the whole
   visit come from 2 scripted journeys per screen (approve, edit, undo, filter by keyboard,
   navigate, type, save, export). The 75th percentile is the nearest rank, as Shopify takes it
   over page loads; with two journeys it is the worse one. A screen with no INP fails: it means
   the script did not interact.
4. **Gates.** CLS (load and visit) under 0.05, INP under 150 ms and 150 KB of same-origin
   JavaScript (compressed) fail the job, as PLAN §23 says. LCP fails at Built for Shopify's
   2.5 s and warns, in the summary, at PLAN's 2.0 s: LCP is a chain of round trips on the throttled
   link, the one metric that moves with a loaded CI runner, and a required job that flakes blocks
   every pull request. The measured LCP is 1.6 to 1.9 s.
5. **CI.** The project is part of `playwright test`, so the `e2e` job runs it (about 3 minutes).
   The job prints a table to the run summary and uploads `test-results/perf/app-home.json`, also
   on failure.
6. **Fixes this found** (each shifted layout or delayed a first load):
   - The fixes screen showed its queue, applied list and locked-feature section as each one
     arrived, pushing the others down (CLS 0.26 to 0.36). They now appear together.
   - The first-scan overview inserted three sections above two that were already shown (CLS 0.25).
     Fixes and Plan appear once there is a scan.
   - The root `+error.svelte` had a scoped `<style>`. SvelteKit loads that page's code before it
     starts, so its stylesheet was a second serial request on every first load; moving the rule to
     `app.css` cut LCP by about 250 ms.
   - Links in the app load their code when they come into view
     (`data-sveltekit-preload-code="viewport"`), so a move between screens does not wait for a
     download before it paints; one overview journey had measured INP 144 ms.

## Consequences

- A regression in layout stability, interaction latency or first-load size fails the pull request
  that causes it, with the element named.
- Real numbers still come from Shopify: after 100 loads per screen on a development store, the
  Partner Dashboard shows the app's p75 values (LAUNCH.md section E).
- Each new screen must be added to `SCREENS` in the spec; the R2 GitHub channel's screen is behind
  a flag and off in the App Store build, so it is not measured here.

## Rejected alternatives

- Real-user monitoring in the app: it adds JavaScript to the budgeted bundle, and Shopify
  already collects the same metrics with App Bridge.
- `bundleStrategy: 'single'` for the whole app: LCP drops to 1.5 s but every route of the site and
  dashboard would ship in one file.
- A faster profile (no network throttle): it would pass easily and say little.
- Failing LCP at 2.0 s: see decision 4.
