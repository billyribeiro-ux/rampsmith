#!/usr/bin/env node
/**
 * The engine process (PLAN §6): telemetry first, then the database role check, then Chromium
 * and the `scan.page` worker until SIGTERM, letting the page in flight finish.
 */
import { hostname } from 'node:os';
import process from 'node:process';
import { startTelemetry } from '@rampsmith/telemetry';
import { runWorker } from '@rampsmith/queue';
import postgres from 'postgres';
import { launchBrowser } from './browser.ts';
import { assertWorkerRole } from './role-guard.ts';
import { userAgent } from './user-agent.ts';
import { scanPageHandler } from './worker.ts';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') throw new Error(`${name} must be set`);
  return value.trim();
}

const version = process.env['SERVICE_VERSION'] ?? '0.0.0';
const telemetry = startTelemetry({ serviceName: 'engine', serviceVersion: version });
const sql = postgres(required('DATABASE_URL'), { max: 5, onnotice: () => undefined });

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

  try {
    await runWorker({
      sql,
      queue: 'scan.page',
      workerId: process.env['WORKER_ID'] ?? `engine-${hostname()}-${process.pid.toString()}`,
      concurrency: 1,
      signal: stop.signal,
      handler: scanPageHandler({
        sql,
        browser,
        egress: {
          proxyUrl: required('EGRESS_PROXY_URL'),
          tokenSecret: required('EGRESS_TOKEN_SECRET'),
        },
        userAgent: userAgent(version, process.env['BOT_INFO_URL']),
      }),
    });
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
