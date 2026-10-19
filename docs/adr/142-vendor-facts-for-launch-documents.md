# ADR-142: Vendor facts read for the launch documents that refine PLAN.md and LAUNCH.md

- Status: Accepted (19 October 2026, at integration)
- Date: 2026-10-17
- Evidence: [`docs/evidence/ws-5-launch-docs.md`](../evidence/ws-5-launch-docs.md), section "Vendor facts"

## Context

The launch documents (privacy policy, terms, Data Processing Addendum, App Store listing,
founder setup) restate vendor rules. CLAUDE.md requires each one to be read from the official
source at the time it is written; where the source and PLAN.md or LAUNCH.md differ, the source
wins and the difference is recorded here. Every fact below was read on 17 October 2026.
Requirement 5.1.1 (theme changes) has its own record, ADR-141.

## Decision

The launch documents follow these facts.

1. **Listing copy carries no statistics or data.** Shopify App Store requirement 4.3.3: "Do not
   use any statistics or data in your app's listing content, overview of the app, and/or app
   introduction", which "includes verifiable and unverifiable information", and "avoid using
   terms like "the first", "the best", or "the only"." Requirement 4.4.1 says the same for the
   app card subtitle; 4.2.2 bans pricing in listing images.
   ([App Store requirements](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements))
   The PLAN §3 "Use instead" phrase "Passes N of M automated WCAG 2.2 AA checks" stays right for
   the app and reports, but listing fields use no numbers outside the pricing section.
2. **Listing field limits.** App name 30 characters; app introduction 100; app details 500;
   each feature 80; screenshots 1600 × 900, 3 to 6 for desktop, with alt text; up to 5 search
   terms. No limit for the app card subtitle is stated on the pages read.
   ([Best practices](https://shopify.dev/docs/apps/launch/shopify-app-store/best-practices))
3. **Compliance webhooks.** Every App Store app "must subscribe" to `customers/data_request`,
   `customers/redact` and `shop/redact`, configured with `compliance_topics` in
   `shopify.app.toml`, and "must respond to data subject requests, regardless of whether the app
   collects personal data". Acknowledge with a 2xx status, complete the action "within 30 days
   of receiving the request", and answer an invalid HMAC with `401 Unauthorized`. `shop/redact`
   arrives "48 hours after a store owner uninstalls your app". The page says both that the two
   customer topics go to apps installed on the store and that an app receives them "if your app
   has been granted access to customer or order data"; Rampsmith requests neither.
   ([Privacy law compliance](https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance))
4. **Anthropic spend limits and retention.** A spend limit the customer sets returns HTTP 400
   `invalid_request_error` ("You have reached your specified API usage limits"); the usage
   tier's cap returns HTTP 429 `rate_limit_error` with no `retry-after` header and error code
   `enforced_spend_limit_reached`
   ([rate limits](https://platform.claude.com/docs/en/api/rate-limits)). Commercial API inputs
   and outputs are deleted "within 30 days of receipt or generation" by default
   ([privacy center](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data)),
   the Batch API has "29-day retention"
   ([API and data retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention)),
   and commercial inputs and outputs are not used for training by default
   ([privacy center](https://privacy.claude.com/en/articles/7996868-is-my-data-used-for-model-training)).
5. **Railway project tokens are per environment.** "Project tokens are scoped to a specific
   environment within a project" and authenticate with the `Project-Access-Token` header
   ([Railway API](https://docs.railway.com/integrations/api)); the CLI reads them from
   `RAILWAY_TOKEN` ([Railway CLI](https://docs.railway.com/cli)). Staging and production each
   need their own token.
6. **Shopify CI token.** The App Automation Token is created per app in the Dev Dashboard with
   a 1, 3 or 6 month expiry and an overlapping rotation; Partner Dashboard CLI tokens can no
   longer be created
   ([App Automation Tokens](https://shopify.dev/docs/apps/build/dev-dashboard/app-automation-tokens)).
7. **Amazon SES production access** gets "an initial response to your request within 96 hours",
   and sandbox status is per AWS Region
   ([request production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html)).

## Plan correction

- PLAN §3, after the claims table: "In Shopify App Store listing fields, no numbers appear
  outside the pricing section (requirement 4.3.3, ADR-142)."
- PLAN §13, "Data handling and resilience": "A spend-limit response (HTTP 400 with 'specified
  API usage limits', or HTTP 429 with `enforced_spend_limit_reached`) opens the circuit breaker
  at once and is never retried." The current text only names 429 and overload responses.
- PLAN §19, compliance webhooks: add "Shopify may send the customer topics only to apps granted
  customer or order data; Rampsmith requests neither, so a shopper's request about a barrier
  report also reaches Rampsmith through the merchant's delete control and the privacy contact."
  And: "Store data is deleted within 30 days of `shop/redact`, which Shopify sends 48 hours after
  uninstall."
- PLAN §19, subprocessors, Anthropic row: add "inputs and outputs deleted by Anthropic within 30
  days by default; Batch API inputs retained 29 days; not used for training by default".
- LAUNCH.md section C, row 8: "Railway project tokens, one per environment (staging and
  production), stored as the GitHub environment secret `RAILWAY_TOKEN` in the matching GitHub
  environment".
- LAUNCH.md section C, row 2: note the App Automation Token's expiry (at most 6 months) and add
  its rotation to the runbooks in PLAN §22.

## Consequences

- The `engine` AI client must treat both spend-limit responses as "stop", not "retry".
- The founder creates two Railway project tokens instead of one.
- The App Automation Token needs a calendar reminder or an expiry check in `rsctl doctor`.

## Rejected alternatives

- Writing the documents from PLAN.md alone: CLAUDE.md requires the vendor source, and several
  facts above are newer than the plan.
