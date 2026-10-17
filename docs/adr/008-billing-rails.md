# ADR-008: Shopify App Pricing for Shopify customers; Stripe Billing for everyone else

- Status: Accepted
- Date: 2026-10-17
- Source: PLAN.md §6 decision summary, written out before the code it governs

## Context

Shopify App Store apps must bill Shopify merchants through Shopify. Shopify takes 0% of the first $1M of lifetime app revenue counted from 1 January 2025.

## Decision

Shopify merchants are billed through Shopify App Pricing. Non-Shopify customers (WordPress, Git-hosted sites) are billed through Stripe Billing. Entitlements are computed behind one function regardless of rail.

## Consequences

- Plan state for Shopify comes from redirect parameters plus a Partner API check, because App Pricing sends no plan-change webhook.
- Pricing itself is a founder decision (PLAN §27).

## Rejected alternatives

- Stripe for Shopify merchants: not allowed for App Store apps.
