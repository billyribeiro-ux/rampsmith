/**
 * How the engine starts Chromium and points it at egress (PLAN §18, ADR-050).
 *
 * Two properties must hold for every page the engine opens, whatever the page's script does:
 *
 * - All network traffic goes through egress. WebRTC does not honour an HTTP proxy: it sends UDP
 *   (STUN, TURN, DTLS) from the browser process, so a page could probe loopback, the private
 *   network and cloud metadata addresses past egress's address policy. The
 *   `disable_non_proxied_udp` policy stops Chromium sending UDP that does not go through the
 *   proxy, and an HTTP proxy cannot carry UDP.
 * - Loopback goes through egress too. Chromium never proxies `localhost`, `127.0.0.0/8` and
 *   `::1` unless the proxy bypass list contains `<-loopback>`. Playwright adds that entry on its
 *   own, but only while `PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK` is unset, so the
 *   engine names the entry itself and refuses to run when the variable is set.
 */
import process from 'node:process';
import { chromium, type Browser, type LaunchOptions } from 'playwright';

/** Chromium's `--force-webrtc-ip-handling-policy`: UDP only through a proxy that carries it. */
export const WEBRTC_POLICY_ARG = '--force-webrtc-ip-handling-policy=disable_non_proxied_udp';

/** Chromium proxy bypass rule that removes the implicit "never proxy loopback" rule. */
export const LOOPBACK_BYPASS = '<-loopback>';

/** Playwright's switch that stops it adding `<-loopback>` for you. */
export const PROXIED_LOOPBACK_OVERRIDE = 'PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK';

/** Throws when the environment would let Chromium reach loopback directly. */
export function assertLoopbackProxied(env: NodeJS.ProcessEnv = process.env): void {
  if (env[PROXIED_LOOPBACK_OVERRIDE] !== undefined) {
    throw new Error(
      `${PROXIED_LOOPBACK_OVERRIDE} is set; unset it, because Chromium would reach loopback ` +
        'without going through egress',
    );
  }
}

export interface BrowserOptions {
  /** A Chromium binary other than Playwright's own (tests and the sandbox image check). */
  readonly executablePath?: string;
  /** Chromium's own sandbox. On in production (PLAN §22); tests as root turn it off. */
  readonly chromiumSandbox?: boolean;
}

/** The launch settings of every browser the engine starts. */
export function launchOptions(options: BrowserOptions = {}): LaunchOptions {
  return {
    chromiumSandbox: options.chromiumSandbox ?? true,
    args: [WEBRTC_POLICY_ARG],
    // The proxy itself is set per context (with the scan token); this only fixes loopback.
    proxy: { server: 'per-context', bypass: LOOPBACK_BYPASS },
    ...(options.executablePath === undefined ? {} : { executablePath: options.executablePath }),
  };
}

/** Starts Chromium with the engine's launch settings, after checking the environment. */
export async function launchBrowser(options: BrowserOptions = {}): Promise<Browser> {
  assertLoopbackProxied();
  return await chromium.launch(launchOptions(options));
}

/** The proxy settings of one browser context: egress, with the scan token as its password. */
export function contextProxy(
  server: string,
  token: string,
): { server: string; username: string; password: string; bypass: string } {
  return { server, username: 'rampsmith', password: token, bypass: LOOPBACK_BYPASS };
}
