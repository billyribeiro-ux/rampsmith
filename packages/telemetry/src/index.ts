/**
 * OpenTelemetry for the TypeScript services (PLAN §21), matching crates/telemetry: export
 * traces and metrics over OTLP only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set (protocol,
 * headers and endpoints follow the standard `OTEL_EXPORTER_OTLP_*` variables), and always
 * propagate W3C trace context so job spans continue the trace that enqueued them.
 *
 * Every span passes through `UrlRedactingSpanProcessor` before any exporter sees it (audit M2,
 * ADR-053), so request URLs, launch tokens and shop names never leave the process. The engine
 * and the web server both start telemetry through `startTelemetry`.
 */
import process from 'node:process';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { BatchSpanProcessor, type SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { UrlRedactingSpanProcessor } from './redact.ts';

export interface TelemetryOptions {
  /** `service.name`, such as `engine`. */
  readonly serviceName: string;
  /** `service.version`, normally the image's commit. */
  readonly serviceVersion: string;
  /** Environment to read; defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Extra span processors, such as an in-memory exporter in tests. They run after redaction. */
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
  const exporters = [
    ...(exporting ? [new BatchSpanProcessor(new OTLPTraceExporter())] : []),
    ...(options.spanProcessors ?? []),
  ];
  const sdk = new NodeSDK({
    serviceName: options.serviceName,
    resource: resourceFromAttributes({
      'service.name': options.serviceName,
      'service.version': options.serviceVersion,
    }),
    autoDetectResources: false,
    textMapPropagator: new W3CTraceContextPropagator(),
    instrumentations: [],
    // Redaction first, so exporters that keep a reference to the span see the redacted copy.
    // Exporting: OTLP over HTTP with protobuf (ADR-019), built from the standard environment
    // variables. Without an exporter there is nothing to redact and no tracer provider, as
    // before, so nothing tries to reach a collector.
    spanProcessors: exporters.length === 0 ? [] : [new UrlRedactingSpanProcessor(), ...exporters],
    ...(exporting ? {} : { metricReaders: [] }),
  });
  sdk.start();
  return { exporting, shutdown: () => sdk.shutdown() };
}
