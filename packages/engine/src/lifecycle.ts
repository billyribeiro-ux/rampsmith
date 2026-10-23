/**
 * The engine does not outlive its browser (audit L6). A Chromium that crashed or was killed
 * leaves a worker that claims jobs it can only fail; the process exits non-zero so Railway
 * restarts it, and the health route stops answering 200 first.
 */
import type { Browser } from 'playwright';
import type { HealthServer } from './health.ts';

export interface BrowserWatch {
  /** Call when the engine is shutting down on purpose, so the disconnect is not an error. */
  readonly stopping: () => void;
}

/**
 * Exits with code 1 when `browser` disconnects without `stopping()` having been called. `exit`
 * is the process's own `exit` outside tests.
 */
export function exitWhenBrowserLost(
  browser: Pick<Browser, 'on'>,
  health: Pick<HealthServer, 'setUnhealthy'>,
  write: (line: string) => void,
  exit: (code: number) => void,
): BrowserWatch {
  let intended = false;
  browser.on('disconnected', () => {
    if (intended) return;
    health.setUnhealthy();
    write('engine: chromium disconnected; exiting so the host restarts the engine\n');
    exit(1);
  });
  return {
    stopping: () => {
      intended = true;
    },
  };
}
