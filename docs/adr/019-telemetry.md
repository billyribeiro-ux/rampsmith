# ADR-019: Telemetry wiring

- Status: Accepted
- Date: 2026-10-17
- Refines: PLAN §21

## Context

PLAN §21 asks for OpenTelemetry traces, metrics and logs from every service, one trace from
webhook to scan to fix to pull request, and logs with no personal data or tokens.

## Decision

1. **Export only when configured.** Rust (`crates/telemetry`) and TypeScript
   (`packages/telemetry`) export over OTLP/HTTP with protobuf only when
   `OTEL_EXPORTER_OTLP_ENDPOINT` is set; headers (Grafana Cloud credentials) come from the
   standard `OTEL_EXPORTER_OTLP_HEADERS`. Without an endpoint nothing tries to reach a
   collector, so local runs and tests stay quiet.
2. **Trace context crosses the queue.** `enqueue` stores the current span's W3C
   `traceparent` unless the job carries one; each worker attempt runs in a `job` span (kind
   consumer, attributes `queue`, `job_id`, `attempt`) whose parent is that `traceparent`.
   Rust validates the stored value strictly (lowercase, 32 and 16 hex digits, non-zero ids)
   because the propagator alone accepts shorter ids; the database checks the same format.
3. **Logs.** Rust services log JSON (one object per event, current span fields flattened)
   unless `LOG_FORMAT=pretty`; the filter comes from `RUST_LOG`. Job and request spans carry
   ids, never payloads.
4. **Metrics, same names in both languages.** `rampsmith.queue.attempts` (counter, by
   `queue` and `outcome`) and `rampsmith.queue.claim.duration` (histogram, seconds).
   `queue::depth` returns depth by queue and state and the oldest due job's age, for the
   `ctl` leader to export as gauges.
5. **One TLS stack.** The OTLP exporter uses reqwest with rustls, whose default crypto
   provider is aws-lc-rs. sqlx moves from `tls-rustls` (ring) to `tls-rustls-aws-lc-rs` so
   the process has exactly one rustls provider; with both compiled in, rustls cannot pick a
   default and building a client config would fail at run time. The batch span processor
   runs on its own thread, so the exporter uses reqwest's blocking client.
6. **Web.** SvelteKit 3's built-in OpenTelemetry tracing is configured with the `web`
   skeleton in R0 step 8.

## Consequences

- `telemetry::init` runs at the top of `main`, before the Tokio runtime starts or from a
  blocking context, and returns a guard that flushes on drop.
- A missing endpoint is not an error; a malformed log filter is.
- Duplicates added by the OpenTelemetry SDK (rand 0.9, getrandom 0.3) and base64 0.22 vs 0.23
  are listed with reasons in `deny.toml`.

## Rejected alternatives

- gRPC (tonic) transport: a second HTTP stack and protobuf toolchain for no benefit over
  OTLP/HTTP.
- Keeping ring for sqlx and installing a process-default provider by hand: one more thing
  every binary must remember to do before its first connection.
