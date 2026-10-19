// Loaded by SvelteKit before the application (PLAN §21, ADR-019): exports SvelteKit's
// server spans over OTLP when OTEL_EXPORTER_OTLP_ENDPOINT is set, and nothing otherwise.
import process from 'node:process';
import { startTelemetry } from '@rampsmith/telemetry';

const telemetry = startTelemetry({
  serviceName: 'web',
  serviceVersion: process.env['SERVICE_VERSION'] ?? '0.0.0',
});

process.once('SIGTERM', () => {
  void telemetry.shutdown();
});
