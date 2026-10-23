/**
 * The engine's free-scan heartbeat (audit H1, ADR-280).
 *
 * An engine that serves `free_scan.run` (only with Chromium's sandbox on) writes its worker id
 * and the time to `free_scan_engines` every 15 seconds. The api accepts a free scan only while
 * a row is under 45 seconds old, so a deployment with no sandboxed engine answers "free scanner
 * unavailable" instead of queueing scans that nothing will run. The row is removed on a clean
 * stop; a killed engine simply stops beating.
 */
import type postgres from 'postgres';

/** Time between beats. The api's window is three times this. */
const BEAT_INTERVAL_MS = 15_000;

export interface FreeScanBeat {
  /** Stops beating and withdraws the row. */
  stop(): Promise<void>;
}

export interface BeatOptions {
  readonly intervalMs?: number;
  /** Told when a beat could not be written; the message names no value. */
  readonly warn?: (message: string) => void;
}

/** Writes the first beat (a failure here is thrown) and then one every `intervalMs`. */
export async function startFreeScanBeat(
  sql: postgres.Sql,
  workerId: string,
  options: BeatOptions = {},
): Promise<FreeScanBeat> {
  const warn = options.warn ?? (() => undefined);
  const write = async (): Promise<void> => {
    await sql`
      insert into free_scan_engines (worker_id, beat_at) values (${workerId}, now())
      on conflict (worker_id) do update set beat_at = excluded.beat_at`;
  };
  await write();
  let writing: Promise<void> | undefined;
  const timer = setInterval(() => {
    // A slow database must not stack beats.
    writing ??= write()
      .catch(() => {
        warn('free-scan heartbeat could not be written');
      })
      .finally(() => {
        writing = undefined;
      });
  }, options.intervalMs ?? BEAT_INTERVAL_MS);
  timer.unref();
  return {
    async stop() {
      clearInterval(timer);
      await writing;
      await sql`delete from free_scan_engines where worker_id = ${workerId}`.catch(() => {
        warn('free-scan heartbeat could not be withdrawn');
      });
    },
  };
}
