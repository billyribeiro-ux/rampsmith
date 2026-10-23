# ADR-311: Regressions in App Home are shown on every plan, locked below Growth

- Status: Accepted
- Date: 2026-10-23
- Stream: R2 (daily monitoring)

## Context

Built for Shopify requirement 4.3.7 (ADR-141) says a feature a plan lacks is shown, disabled, and
names the plan that unlocks it. Regression alerts are a Growth feature (PLAN §20).

## Decision

1. `GET /v1/shopify/regressions` always answers. On a plan without `Feature::RegressionAlerts` it
   returns `gate: "locked"`, `unlocked_by: "growth"` and no items; the screen `/app/regressions`
   shows the explanation, a badge "Needs the Growth plan" and the Compare plans link. Otherwise it
   returns the records that found something, newest first, fifty at most.
2. The overview carries `regression_banner`: the newest record that found something, not dismissed
   and detected in the last seven days, `null` on a locked plan. App Home shows it as a warning
   banner above the scan section with a link to the screen. `POST …/regressions/{id}/dismiss` hides
   it and writes `regression.dismissed` to the audit log; the record stays on the screen.
3. A record of another shop is "not found", never "forbidden". The routes need a Shopify session.
4. The navigation gets one item, "Regressions".

## Consequences

Playwright covers the screen's locked, empty and populated states, the banner and the dismissal,
with axe and keyboard checks, and the `app-perf` project measures the two new screens.
