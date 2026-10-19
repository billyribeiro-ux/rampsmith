import { context, propagation, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterEach, describe, expect, it } from 'vitest';
import { startTelemetry, type Telemetry } from '../src/index.ts';

let running: Telemetry | undefined;

afterEach(async () => {
  await running?.shutdown();
  running = undefined;
  // One tracer provider per process; each test starts its own.
  trace.disable();
});

describe('startTelemetry', () => {
  it('exports only when an OTLP endpoint is configured', () => {
    running = startTelemetry({ serviceName: 'engine', serviceVersion: '0.0.0', env: {} });
    expect(running.exporting).toBe(false);
  });

  it('records spans and propagates W3C trace context through the active span', () => {
    const exporter = new InMemorySpanExporter();
    running = startTelemetry({
      serviceName: 'engine',
      serviceVersion: '0.0.0',
      env: {},
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const carrier: Record<string, string> = {};
    trace.getTracer('test').startActiveSpan('scan.page', (span) => {
      propagation.inject(context.active(), carrier);
      span.end();
    });
    expect(carrier['traceparent']).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    const [span] = exporter.getFinishedSpans();
    expect(span?.name).toBe('scan.page');
    expect(span?.resource.attributes['service.name']).toBe('engine');
    expect(span?.resource.attributes['service.version']).toBe('0.0.0');
  });

  it('treats a blank endpoint as unset', () => {
    running = startTelemetry({
      serviceName: 'engine',
      serviceVersion: '0.0.0',
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: '  ' },
    });
    expect(running.exporting).toBe(false);
  });
});
