import type { Browser, BrowserContextOptions } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LOOPBACK_BYPASS,
  PROXIED_LOOPBACK_OVERRIDE,
  WEBRTC_POLICY_ARG,
  assertLoopbackProxied,
  BROWSER_ENV_ALLOWLIST,
  browserEnv,
  contextProxy,
  SANDBOX_POLICY_ENV,
  isSandboxRefusal,
  launchBrowser,
  launchEngineBrowser,
  launchOptions,
  sandboxPolicy,
} from '../src/browser.ts';
import { scanPage } from '../src/scan-page.ts';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the browser process environment (audit M1)', () => {
  const polluted = {
    PATH: '/usr/bin',
    HOME: '/home/pwuser',
    LANG: 'C.UTF-8',
    DATABASE_URL: 'postgres://engine:secret@db/app',
    EGRESS_TOKEN_SECRET: 'egress-secret',
    ANTHROPIC_API_KEY: 'sk-ant-secret',
    SES_SECRET_ACCESS_KEY: 'ses-secret',
    SES_ACCESS_KEY_ID: 'ses-id',
    EMAIL_LINK_KEYS: 'k1:secret',
    RAMPSMITH_SCAN_SECRET_KEYS: 's1:secret',
    R2_SECRET_ACCESS_KEY: 'r2-secret',
    OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer%20token',
  };

  it('passes Chromium only the variables it needs, never a secret', () => {
    expect(browserEnv(polluted)).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/pwuser',
      LANG: 'C.UTF-8',
    });
  });

  it('puts that environment in every launch', () => {
    for (const [name, value] of Object.entries(polluted)) vi.stubEnv(name, value);
    const env = launchOptions().env ?? {};
    expect(Object.keys(env)).toEqual(expect.arrayContaining(['HOME', 'LANG', 'PATH']));
    for (const name of Object.keys(env)) expect(BROWSER_ENV_ALLOWLIST).toContain(name);
    expect(JSON.stringify(env)).not.toMatch(/secret|postgres/u);
  });
});

describe('launchOptions', () => {
  it('forces WebRTC onto the proxy, so a page cannot send UDP past egress (M1)', () => {
    expect(WEBRTC_POLICY_ARG).toBe('--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
    expect(launchOptions().args).toEqual([WEBRTC_POLICY_ARG]);
  });

  it('leaves the proxy to each context and proxies loopback at the browser too (L2)', () => {
    expect(launchOptions().proxy).toEqual({ server: 'per-context', bypass: '<-loopback>' });
  });

  it('keeps the sandbox on unless a test turns it off', () => {
    expect(launchOptions().chromiumSandbox).toBe(true);
    expect(launchOptions({ chromiumSandbox: false }).chromiumSandbox).toBe(false);
  });

  it('adds an executable path only when given one', () => {
    expect('executablePath' in launchOptions()).toBe(false);
    expect(launchOptions({ executablePath: '/opt/chromium' }).executablePath).toBe('/opt/chromium');
  });
});

describe('the proxied-loopback override (L2)', () => {
  it.each(['1', 'true', '0', ' '])('refuses to start when it is set to %j', (value) => {
    vi.stubEnv(PROXIED_LOOPBACK_OVERRIDE, value);
    expect(() => {
      assertLoopbackProxied();
    }).toThrow(PROXIED_LOOPBACK_OVERRIDE);
  });

  it('refuses even when it is set to the empty string', () => {
    vi.stubEnv(PROXIED_LOOPBACK_OVERRIDE, '');
    expect(() => {
      assertLoopbackProxied();
    }).toThrow(PROXIED_LOOPBACK_OVERRIDE);
  });

  it('passes when it is not set', () => {
    expect(() => {
      assertLoopbackProxied({});
    }).not.toThrow();
  });

  it('stops launchBrowser before a browser starts', async () => {
    vi.stubEnv(PROXIED_LOOPBACK_OVERRIDE, '1');
    await expect(launchBrowser({ executablePath: '/nonexistent/chromium' })).rejects.toThrow(
      PROXIED_LOOPBACK_OVERRIDE,
    );
  });

  it('stops scanPage before it opens a context', async () => {
    vi.stubEnv(PROXIED_LOOPBACK_OVERRIDE, '1');
    const newContext = vi.fn();
    const browser = { newContext } as unknown as Browser;
    await expect(
      scanPage(browser, {
        url: 'https://shop.example/',
        userAgent: 'test',
        proxy: { server: 'http://egress.internal:8080', token: 't' },
      }),
    ).rejects.toThrow(PROXIED_LOOPBACK_OVERRIDE);
    expect(newContext).not.toHaveBeenCalled();
  });
});

describe('contextProxy', () => {
  it('names loopback explicitly, so it never depends on a Playwright default (L2)', () => {
    expect(LOOPBACK_BYPASS).toBe('<-loopback>');
    expect(contextProxy('http://egress.internal:8080', 'token')).toEqual({
      server: 'http://egress.internal:8080',
      username: 'rampsmith',
      password: 'token',
      bypass: '<-loopback>',
    });
  });

  it('is what scanPage hands to every new context', async () => {
    const seen: BrowserContextOptions[] = [];
    const browser = {
      newContext: (options: BrowserContextOptions) => {
        seen.push(options);
        return Promise.reject(new Error('stop here'));
      },
    } as unknown as Browser;
    await expect(
      scanPage(browser, {
        url: 'https://shop.example/',
        userAgent: 'test',
        proxy: { server: 'http://egress.internal:8080', token: 'abc' },
      }),
    ).rejects.toThrow('stop here');
    expect(seen[0]?.proxy).toEqual({
      server: 'http://egress.internal:8080',
      username: 'rampsmith',
      password: 'abc',
      bypass: '<-loopback>',
    });
  });
});

describe('the sandbox policy (ADR-265)', () => {
  const fakeBrowser = { close: vi.fn() } as unknown as Browser;
  const refusal = new Error(
    'browserType.launch: Target page, context or browser has been closed\n' +
      '[1:1:1022/200000.000:FATAL:credentials.cc(137)] Check failed: . : Permission denied (13)',
  );

  it('reads auto by default, required on request, and refuses a typo', () => {
    expect(sandboxPolicy({})).toBe('auto');
    expect(sandboxPolicy({ [SANDBOX_POLICY_ENV]: ' ' })).toBe('auto');
    expect(sandboxPolicy({ [SANDBOX_POLICY_ENV]: 'auto' })).toBe('auto');
    expect(sandboxPolicy({ [SANDBOX_POLICY_ENV]: 'required' })).toBe('required');
    expect(() => sandboxPolicy({ [SANDBOX_POLICY_ENV]: 'off' })).toThrow(SANDBOX_POLICY_ENV);
    expect(() => sandboxPolicy({ [SANDBOX_POLICY_ENV]: 'requird' })).toThrow(SANDBOX_POLICY_ENV);
  });

  it.each([
    'FATAL:credentials.cc(137)] Check failed: . : Permission denied (13)',
    'FATAL:zygote_host_impl_linux.cc(128)] No usable sandbox! Update your kernel',
    'Failed to move to new namespace: PID namespaces supported, Network namespace supported, but User namespace not supported',
    'The SUID sandbox helper binary was found, but is not configured correctly',
  ])('recognises a sandbox refusal: %s', (message) => {
    expect(isSandboxRefusal(new Error(message))).toBe(true);
  });

  it.each([
    'Timeout 180000ms exceeded while launching',
    'error while loading shared libraries: libnss3.so: cannot open shared object file',
    "Executable doesn't exist at /ms-playwright/chromium-1/chrome",
    'Check failed: . : Permission denied (13)',
    'Target page, context or browser has been closed',
  ])('does not mistake another failure for one: %s', (message) => {
    expect(isSandboxRefusal(new Error(message))).toBe(false);
    expect(isSandboxRefusal(message)).toBe(false);
  });

  it('starts with the sandbox when the host allows it, and never tries without', async () => {
    const launch = vi.fn().mockResolvedValue(fakeBrowser);
    const warn = vi.fn();
    const started = await launchEngineBrowser({}, 'auto', launch, warn);
    expect(started).toEqual({ browser: fakeBrowser, sandbox: 'on' });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledWith({ chromiumSandbox: true });
    expect(warn).not.toHaveBeenCalled();
  });

  it('starts without the sandbox, and warns, only when the host refused it', async () => {
    const launch = vi.fn().mockRejectedValueOnce(refusal).mockResolvedValueOnce(fakeBrowser);
    const warn = vi.fn();
    const started = await launchEngineBrowser({}, 'auto', launch, warn);
    expect(started).toEqual({ browser: fakeBrowser, sandbox: 'off' });
    expect(launch.mock.calls).toEqual([[{ chromiumSandbox: true }], [{ chromiumSandbox: false }]]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('credentials.cc(137)');
  });

  it('keeps launchOptions in force on both attempts: proxy rule and WebRTC policy', () => {
    for (const chromiumSandbox of [true, false]) {
      const options = launchOptions({ chromiumSandbox });
      expect(options.args).toEqual([WEBRTC_POLICY_ARG]);
      expect(options.proxy).toEqual({ server: 'per-context', bypass: '<-loopback>' });
    }
  });

  it('never drops the sandbox for another failure', async () => {
    const launch = vi.fn().mockRejectedValue(new Error('Timeout 180000ms exceeded'));
    await expect(launchEngineBrowser({}, 'auto', launch)).rejects.toThrow('Timeout');
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('never drops the sandbox under "required"', async () => {
    const launch = vi.fn().mockRejectedValue(refusal);
    await expect(launchEngineBrowser({}, 'required', launch)).rejects.toThrow('credentials.cc');
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('fails when the unsandboxed launch fails too', async () => {
    const launch = vi.fn().mockRejectedValue(refusal);
    await expect(launchEngineBrowser({}, 'auto', launch)).rejects.toThrow('credentials.cc');
    expect(launch).toHaveBeenCalledTimes(2);
  });
});
