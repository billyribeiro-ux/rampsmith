import type { Browser, BrowserContextOptions } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LOOPBACK_BYPASS,
  PROXIED_LOOPBACK_OVERRIDE,
  WEBRTC_POLICY_ARG,
  assertLoopbackProxied,
  contextProxy,
  launchBrowser,
  launchOptions,
} from '../src/browser.ts';
import { scanPage } from '../src/scan-page.ts';

afterEach(() => {
  vi.unstubAllEnvs();
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
