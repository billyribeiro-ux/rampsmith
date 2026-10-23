#!/usr/bin/env node
/**
 * The engine process (PLAN §6): telemetry first, then the database role check, then Chromium
 * and one worker per engine queue (`queues.ts`) until SIGTERM, letting the jobs in flight
 * finish.
 */
import { hostname } from 'node:os';
import process from 'node:process';
import { startTelemetry } from '@rampsmith/telemetry';
import { runWorker } from '@rampsmith/queue';
import postgres from 'postgres';
import { launchBrowser } from './browser.ts';
import { assertWorkerRole } from './role-guard.ts';
import { ScanKeyRing, storefrontPasswordFromScan } from './scan-secret.ts';
import { userAgent } from './user-agent.ts';
import { ENGINE_QUEUES, engineHandlers } from './queues.ts';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') throw new Error(`${name} must be set`);
  return value.trim();
}

const version = process.env['SERVICE_VERSION'] ?? '0.0.0';
const telemetry = startTelemetry({ serviceName: 'engine', serviceVersion: version });
// One connection per queue's claim or heartbeat at a time, plus room for a job's transaction;
// LISTEN uses its own connection.
const sql = postgres(required('DATABASE_URL'), { max: 10, onnotice: () => undefined });

/** Runs until SIGTERM. Returns early, with exit code 1, if the database login is unsafe. */
async function run(): Promise<void> {
  // Row-level security protects tenants only from a plain member of rampsmith_worker (ADR-052).
  // Nothing turns this check off.
  try {
    await assertWorkerRole(sql);
  } catch (error) {
    process.stderr.write(`engine: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }
  // Chromium's own sandbox stays on (PLAN §22): the engine runs as a non-root user under the
  // seccomp profile in infra/engine.seccomp.json. WebRTC is held to the proxy and loopback goes
  // through egress (ADR-050).
  const browser = await launchBrowser();
  const stop = new AbortController();
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      stop.abort();
    });
  }

  // The key ring `ctl` seals a protected store's password under, for one scan (ADR-264).
  // Optional: without it such a store is reported as blocked. It is not a master key.
  const scanKeys = process.env['RAMPSMITH_SCAN_SECRET_KEYS']?.trim();
  const storefrontPassword =
    scanKeys === undefined || scanKeys === ''
      ? undefined
      : storefrontPasswordFromScan(sql, new ScanKeyRing(scanKeys));

  const handlers = engineHandlers({
    sql,
    browser,
    ...(storefrontPassword === undefined ? {} : { storefrontPassword }),
    egress: {
      proxyUrl: required('EGRESS_PROXY_URL'),
      tokenSecret: required('EGRESS_TOKEN_SECRET'),
    },
    userAgent: userAgent(version, process.env['BOT_INFO_URL']),
  });
  const workerId = process.env['WORKER_ID'] ?? `engine-${hostname()}-${process.pid.toString()}`;

  try {
    await Promise.all(
      ENGINE_QUEUES.map((queue) =>
        runWorker({
          sql,
          queue,
          workerId,
          concurrency: 1,
          signal: stop.signal,
          handler: handlers[queue],
        }),
      ),
    );
  } finally {
    await browser.close();
  }
}

try {
  await run();
} finally {
  await sql.end();
  await telemetry.shutdown();
}
