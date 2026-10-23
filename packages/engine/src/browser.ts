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

/**
 * Whether the engine may start Chromium without its own sandbox (ADR-265).
 *
 * - `auto` (default): try the sandbox; when the host refuses it, start without. Railway runs
 *   containers with its own settings and its hosts differ in whether unprivileged user
 *   namespaces work, so one image has to start on both.
 * - `required`: never start without the sandbox (a host or a test that must prove it works).
 */
export type SandboxPolicy = 'auto' | 'required';

/** Whether a started browser has Chromium's own sandbox. */
type SandboxMode = 'on' | 'off';

/** The variable that selects a {@link SandboxPolicy}. */
export const SANDBOX_POLICY_ENV = 'ENGINE_CHROMIUM_SANDBOX';

/** Reads the policy; an unknown value is an error, so a typo never loosens the sandbox. */
export function sandboxPolicy(env: NodeJS.ProcessEnv = process.env): SandboxPolicy {
  const value = env[SANDBOX_POLICY_ENV]?.trim();
  if (value === undefined || value === '' || value === 'auto') return 'auto';
  if (value === 'required') return 'required';
  throw new Error(`${SANDBOX_POLICY_ENV} must be "auto" or "required"`);
}

/**
 * What Chromium prints when the host refuses to set its sandbox up: no user namespace
 * (`credentials.cc`, "Permission denied (13)" or "Operation not permitted"), "No usable
 * sandbox", the setuid helper, a failed move into a new namespace. Nothing else qualifies: a
 * timeout, a crash or a missing library is a launch failure, not a reason to drop the sandbox.
 */
const SANDBOX_REFUSAL = [
  /No usable sandbox/i,
  /Failed to move to new namespace/i,
  /User namespace not supported/i,
  /SUID sandbox helper/i,
  /\bcredentials\.cc\b/,
  /\bnamespace_sandbox\b/,
] as const;

/** Whether a failed launch is the host refusing Chromium's sandbox. */
export function isSandboxRefusal(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return SANDBOX_REFUSAL.some((pattern) => pattern.test(message));
}

/** The line of a launch error that names the refusal, shortened for a log. */
function refusalLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const line = message.split('\n').find((l) => SANDBOX_REFUSAL.some((p) => p.test(l)));
  return (line ?? 'sandbox refused').trim().slice(0, 300);
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

/** A started browser and whether it has Chromium's sandbox. */
export interface EngineBrowser {
  readonly browser: Browser;
  readonly sandbox: SandboxMode;
}

/**
 * Starts the engine's browser under `policy`: with Chromium's sandbox when the host allows it,
 * and, under `auto`, without it only when the launch failed because the host refused the
 * sandbox (ADR-265). Every other failure is thrown. Without the sandbox the controls that
 * remain are the ones of ADR-050 and ADR-265: a non-root user, egress as the only way out, a
 * fresh context per page and a read-only browser install.
 */
export async function launchEngineBrowser(
  options: BrowserOptions = {},
  policy: SandboxPolicy = sandboxPolicy(),
  launch: (options: BrowserOptions) => Promise<Browser> = launchBrowser,
  warn: (message: string) => void = () => undefined,
): Promise<EngineBrowser> {
  try {
    return { browser: await launch({ ...options, chromiumSandbox: true }), sandbox: 'on' };
  } catch (error) {
    if (policy === 'required' || !isSandboxRefusal(error)) throw error;
    warn(`this host refused Chromium's sandbox (${refusalLine(error)})`);
  }
  return { browser: await launch({ ...options, chromiumSandbox: false }), sandbox: 'off' };
}

/** The proxy settings of one browser context: egress, with the scan token as its password. */
export function contextProxy(
  server: string,
  token: string,
): { server: string; username: string; password: string; bypass: string } {
  return { server, username: 'rampsmith', password: token, bypass: LOOPBACK_BYPASS };
}
