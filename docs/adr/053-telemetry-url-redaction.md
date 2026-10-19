# ADR-053: Spans leave the process without URLs, tokens or shop names

- Status: Accepted
- Date: 2026-10-19
- Refines: ADR-019 (telemetry wiring), PLAN §19, §21
- Fixes: R0 security audit M2

## Context

PLAN §19: "Telemetry carries tenant ids, never names, emails or store content." PLAN §21 says
logs and traces hold no personal data or tokens. SvelteKit 3's server tracing sets `http.url` on
its root span (`sveltekit.handle.root`) to `event.url.href`
(`@sveltejs/kit/src/runtime/server/respond.js`, line 482 in 3.1.0), the whole request URL. The
embedded app is launched with `?embedded=1&hmac=…&id_token=…&session=…&shop=<shop>.myshopify.com&host=…`,
so the web server's traces carried a session token (replayable for its minute), Shopify's request
signature and the shop's name to the trace backend. Reproduced on the built app before the fix:
the exported span held `https://127.0.0.1:41071/app?embedded=1&hmac=x&id_token=y&session=z&shop=s.myshopify.com`.

## Decision

1. **A span processor, `UrlRedactingSpanProcessor`** (`packages/telemetry/src/redact.ts`), runs
   before every exporter and rewrites the span in place:
   - attributes whose name ends in `url`, `uri`, `target`, `referer`, `referrer`, `location`,
     `original` or `full` (`http.url`, `url.full`, `http.target`, `http.request.header.referer`,
     `http.response.header.location`…) become origin plus path: credentials, query string and
     fragment are dropped; `data:` and `mailto:` style addresses keep only the scheme; relative
     addresses keep their path;
   - every other string attribute, array of strings, event attribute (exception messages and
     stack traces) and link attribute has each `scheme://…` address inside it reduced the same
     way, and every `<label>.myshopify.com` replaced with `[shop].myshopify.com`;
   - attributes that are secret by name (`url.query`, `url.fragment`, `password`, `secret`,
     `token`, `id_token`, `authorization`, `cookie`, `set-cookie`, `hmac`,
     `x-shopify-hmac-sha256`, `x-shopify-access-token`…) become `[redacted]`.
2. **When it runs.** At span start (attributes given at creation, which is how SvelteKit sets
   `http.url`), in `onEnding` (the span is still writable: late attributes and exception events),
   and again in `onEnd`, in case an SDK release stops calling `onEnding`, which the SDK marks
   experimental. The SDK keeps attributes in a plain object on the span, so the rewrite is in
   place, and a test pins that.
3. **Where.** `startTelemetry` puts the processor first in the SDK's processor list, so it
   covers the engine, the web server and any later TypeScript service. `startTelemetry` now
   builds the OTLP trace exporter itself (`@opentelemetry/exporter-trace-otlp-proto` 0.223.0,
   the exporter `@opentelemetry/sdk-node` 0.223.0 would have chosen for ADR-019's
   OTLP/HTTP-protobuf default, configured from the same `OTEL_EXPORTER_OTLP_*` variables),
   because the SDK offers no way to add a processor ahead of the ones it builds from the
   environment. `@opentelemetry/sdk-trace-base` moves from a dev to a runtime dependency for its
   `BatchSpanProcessor`. Without an exporter nothing changes: no tracer provider is registered.
   Extra processors (tests) now also run when exporting; before, they replaced the exporter.
4. **No backtracking.** Span text is chosen by whoever sent the request, so shop names are found
   by scanning outward from each `.myshopify.com`, trailing punctuation is trimmed by hand, and
   the URL pattern has a bounded scheme. A test feeds it 200,000 characters of hostile input.

## Tests

- `packages/telemetry/test/redact.test.ts` (21 tests): address and text rewriting, every
  attribute shape, events, links, start-time and late attributes, `startTelemetry`, and the real
  OTLP pipeline into a local collector, searched byte for byte for `id_token`, `hmac`, `session`
  and the shop name.
- `apps/web/tests/app.spec.ts`: starts a second copy of the built app that exports to a local
  collector, requests `/app?embedded=1&hmac=x&id_token=y&session=z&shop=s.myshopify.com`, waits
  for the root span to arrive, and checks that the body holds the route and the address cut to
  `/app` and none of the forbidden words. Without the processor the same test fails and prints
  the full URL.

## Consequences

- Traces show `https://<host>/app`, not which shop or session made the request. Support looks
  up a request by trace id and tenant id (PLAN §21), not by URL.
- A new instrumentation that records a different URL attribute is covered by name or by value;
  one that records an address under an unusual name inside a longer string is covered by the
  text rule.
- The redaction is a safety net behind the rule that code does not put tokens in attributes; it
  does not make it safe to do so.

## Rejected alternatives

- Dropping `http.url` in a SvelteKit hook: covers one attribute of one framework; the next
  instrumentation brings its own.
- Redacting in the collector (`infra/collector`): the secrets would already have left the
  process, and the founder's collector configuration is not under test.
- A custom `SpanExporter` wrapper around the SDK's exporter: it needs the same dependency and
  sees spans only when they are exported, after other processors have had them.
