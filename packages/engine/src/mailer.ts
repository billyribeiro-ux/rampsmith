#!/usr/bin/env node
/**
 * The mailer process (ADR-276): the only process that holds the Amazon SES keys and the
 * unsubscribe-link key, and the only one that serves `email.send`.
 *
 * It is the engine's image with a different entry point, and it deliberately imports nothing
 * that reaches Chromium: not `browser.ts`, not the scan worker, not `queues.ts`. A renderer
 * exploit from a stranger's page (the engine opens them, audit H1) then lands in a process that
 * has no SES key, and the process that has the key never opens a page (ADR-050). It holds the
 * database login of a plain member of `rampsmith_worker`, checked at start like the engine's.
 */
import { hostname } from 'node:os';
import process from 'node:process';
import { startTelemetry } from '@rampsmith/telemetry';
import { runWorker } from '@rampsmith/queue';
import postgres from 'postgres';
import { createEmailRuntime } from './email/runtime.ts';
import { startHealthServer } from './health.ts';
import { emailSendHandler } from './jobs/email-send.ts';
import { assertWorkerRole } from './role-guard.ts';

/** The queues the mailer serves. */
export const MAILER_QUEUES = ['email.send'] as const;

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') throw new Error(`${name} must be set`);
  return value.trim();
}

const version = process.env['SERVICE_VERSION'] ?? '0.0.0';
const telemetry = startTelemetry({ serviceName: 'mailer', serviceVersion: version });
const sql = postgres(required('DATABASE_URL'), { max: 5, onnotice: () => undefined });

/** Runs until SIGTERM. Returns early, with exit code 1, if the database login is unsafe. */
async function run(): Promise<void> {
  try {
    await assertWorkerRole(sql);
  } catch (error) {
    process.stderr.write(`mailer: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }
  const health = await startHealthServer(process.env['PORT']);
  const stop = new AbortController();
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      stop.abort();
    });
  }
  // Missing settings are named once here (no values); `email.send` jobs retry until they are set.
  const email = createEmailRuntime(process.env);
  for (const problem of email.problems)
    process.stderr.write(`mailer: warning: email: ${problem}\n`);
  process.stderr.write('mailer: serving email.send (no browser in this process)\n');

  const handler = emailSendHandler({ sql, email });
  const workerId = process.env['WORKER_ID'] ?? `mailer-${hostname()}-${process.pid.toString()}`;
  try {
    await Promise.all(
      MAILER_QUEUES.map((queue) =>
        runWorker({ sql, queue, workerId, concurrency: 2, signal: stop.signal, handler }),
      ),
    );
  } finally {
    await health.close();
  }
}

try {
  await run();
} finally {
  await sql.end();
  await telemetry.shutdown();
}
