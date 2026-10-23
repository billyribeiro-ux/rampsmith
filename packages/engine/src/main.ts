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
import { launchEngineBrowser } from './browser.ts';
import { startFreeScanBeat, type FreeScanBeat } from './free-scan-beat.ts';
import { startHealthServer } from './health.ts';
import { exitWhenBrowserLost } from './lifecycle.ts';
import { assertWorkerRole } from './role-guard.ts';
import { ScanKeyRing, storefrontPasswordFromScan } from './scan-secret.ts';
import { userAgent } from './user-agent.ts';
import { deadlineMs, engineHandlers, queuesFor } from './queues.ts';

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
  // Chromium's own sandbox is on wherever the host allows it (PLAN §22; ADR-028's profile in
  // infra/engine.seccomp.json does it under Docker). Railway starts containers with its own
  // settings, and some of its hosts refuse unprivileged user namespaces: there, and only there,
  // the engine starts Chromium without the sandbox and says so (ADR-265;
  // ENGINE_CHROMIUM_SANDBOX=required turns the fallback off). WebRTC is held to the proxy and
  // loopback goes through egress (ADR-050).
  const { browser, sandbox } = await launchEngineBrowser({}, undefined, undefined, (message) =>
    process.stderr.write(`engine: warning: ${message}\n`),
  );
  process.stderr.write(`engine: chromium sandbox=${sandbox}\n`);
  // Railway's deploy health check (ADR-264): up only once the database login and the browser
  // are, so a deployment that cannot scan never goes live.
  const health = await startHealthServer(process.env['PORT']);
  const stop = new AbortController();
  // A browser that dies takes the engine with it (audit L6); a shutdown on purpose does not.
  const watch = exitWhenBrowserLost(
    browser,
    health,
    (line) => process.stderr.write(line),
    (code) => process.exit(code),
  );
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      watch.stopping();
      stop.abort();
    });
  }

  // The key ring `ctl` seals a protected store's password under, for one scan (ADR-266).
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

  // Free scans visit sites chosen by strangers, so this engine serves them only with Chromium's
  // sandbox on (audit H1, ADR-280). It says so in the database for the api, which refuses free
  // scans while no engine does.
  const queues = queuesFor(sandbox);
  let beat: FreeScanBeat | undefined;
  if (queues.includes('free_scan.run')) {
    beat = await startFreeScanBeat(sql, workerId, {
      warn: (message) => process.stderr.write(`engine: warning: ${message}\n`),
    });
    process.stderr.write('engine: serving free scans (chromium sandbox is on)\n');
  } else {
    process.stderr.write(
      'engine: not serving free scans: chromium runs without its sandbox (ADR-280)\n',
    );
  }

  try {
    await Promise.all(
      queues.map((queue) =>
        runWorker({
          sql,
          queue,
          workerId,
          concurrency: 1,
          deadlineMs: deadlineMs(queue),
          signal: stop.signal,
          handler: handlers[queue],
        }),
      ),
    );
  } finally {
    watch.stopping();
    await beat?.stop();
    await health.close();
    await browser.close();
  }
}

try {
  await run();
} finally {
  await sql.end();
  await telemetry.shutdown();
}
