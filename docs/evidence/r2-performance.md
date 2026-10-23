# R2 evidence: App Home Core Web Vitals (PLAN §5, §23; ADR-300)

Date: 23 October 2026. Command: `pnpm --filter @rampsmith/web run test:e2e` (project `app-perf`), or
locally `playwright test --project=app-perf` with the built app and the typed fake api.
Chromium 141.0.7390.37 (`/opt/google/chrome/chrome`), Node 26.12.0, `web-vitals` 6.2.3, 2 vCPUs shared with
other builds. Profile: 412 x 915, CPU 4x, 150 ms, 1.6 Mbps (Lighthouse mobile). Cold cache.
LCP and CLS of the load: 5 loads per screen; INP and CLS of the visit: 2 journeys; p75, nearest rank.

| Screen | LCP (ms) | CLS load / visit | INP (ms) | JavaScript (KB) |
| --- | --- | --- | --- | --- |
| overview | 1816 | 0 / 0 | 40 | 45.8 |
| overview, first scan | 1616 | 0 / 0.019 | 24 | 45.8 |
| issues | 1880 | 0 / 0 | 24 | 45.7 |
| issue detail | 1844 | 0.003 / 0.003 | 40 | 45.6 |
| fixes | 1900 | 0 / 0 | 56 | 47.6 |
| remediation log | 1680 | 0 / 0 | 32 | 45.1 |
| statement | 1640 | 0 / 0.037 | 64 | 45.8 |
| settings | 1720 | 0.001 / 0.001 | 48 | 46.7 |
| **Built for Shopify** (2.1.1 to 2.1.3, p75) | 2500 | 0.1 | 200 | |
| **PLAN §23 budget** | 2000 (warns) | 0.05 | 150 | 150 |

All screens are inside both Built for Shopify's thresholds and PLAN's budgets; the tightest is
LCP of the fixes screen at 95% of PLAN's 2.0 s.

Before the fixes in ADR-300: fixes CLS 0.26 to 0.36 (load) and INP up to 176 ms; first-scan overview
CLS 0.25; overview LCP 1.88 to 2.08 s; issue-detail visit CLS 0.26 to 0.36. Source of the
thresholds and what is not measured (Shopify's own Polaris and App Bridge scripts, a real edge's
HTTP version): ADR-300.

Live counterpart: LAUNCH.md section E, "App Home Core Web Vitals in the real admin".
