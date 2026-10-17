/**
 * OpenTelemetry for the TypeScript engine (PLAN §21), matching crates/telemetry: export
 * traces and metrics over OTLP only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set (protocol,
 * headers and endpoints follow the standard `OTEL_EXPORTER_OTLP_*` variables), and always
 * propagate W3C trace context so job spans continue the trace that enqueued them.
 */
import process from 'node:process';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import type { SpanProcessor } from '@opentelemetry/sdk-trace-base';

export interface TelemetryOptions {
  /** `service.name`, such as `engine`. */
  readonly serviceName: string;
  /** `service.version`, normally the image's commit. */
  readonly serviceVersion: string;
  /** Environment to read; defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Extra span processors, such as an in-memory exporter in tests. */
  readonly spanProcessors?: SpanProcessor[];
}

export interface Telemetry {
  /** Whether traces and metrics leave the process. */
  readonly exporting: boolean;
  /** Flushes and stops exporting; call on shutdown. */
  shutdown(): Promise<void>;
}

/** Starts telemetry once, at the top of the process, before any work runs. */
export function startTelemetry(options: TelemetryOptions): Telemetry {
  const env = options.env ?? process.env;
  const exporting = (env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? '').trim() !== '';
  const sdk = new NodeSDK({
    serviceName: options.serviceName,
    resource: resourceFromAttributes({
      'service.name': options.serviceName,
      'service.version': options.serviceVersion,
    }),
    autoDetectResources: false,
    textMapPropagator: new W3CTraceContextPropagator(),
    instrumentations: [],
    // Exporting: let the SDK build OTLP trace and metric pipelines from the environment.
    // Otherwise: no exporters at all, so nothing tries to reach a collector.
    ...(exporting
      ? options.spanProcessors === undefined
        ? {}
        : { spanProcessors: options.spanProcessors }
      : { spanProcessors: options.spanProcessors ?? [], metricReaders: [] }),
  });
  sdk.start();
  return { exporting, shutdown: () => sdk.shutdown() };
}
