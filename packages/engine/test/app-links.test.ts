import { describe, expect, it } from 'vitest';
import { appLinkFor, DEFAULT_APP_HANDLE, isAppHandle } from '../src/email/app-links.ts';
import { createEmailRuntime } from '../src/email/runtime.ts';

describe('links into the app in the merchant admin (ADR-279)', () => {
  it('builds the admin address from the store domain and the app handle', () => {
    expect(appLinkFor('welcome', 'demo-store.myshopify.com', 'rampsmith')).toEqual({
      appUrl: 'https://admin.shopify.com/store/demo-store/apps/rampsmith',
    });
    expect(
      appLinkFor('first_scan_complete', 'demo-store.myshopify.com', 'rampsmith-staging'),
    ).toEqual({
      findingsUrl: 'https://admin.shopify.com/store/demo-store/apps/rampsmith-staging/findings',
    });
    expect(appLinkFor('weekly_summary', 'demo-store.myshopify.com', 'rampsmith')).toEqual({
      dashboardUrl: 'https://admin.shopify.com/store/demo-store/apps/rampsmith',
    });
    expect(appLinkFor('fix_verified', 'demo-store.myshopify.com', 'rampsmith')).toEqual({
      logUrl: 'https://admin.shopify.com/store/demo-store/apps/rampsmith/log',
    });
  });

  it('adds nothing for other templates, other hosts or a handle that is not one', () => {
    expect(appLinkFor('uninstall_export', 'demo-store.myshopify.com', 'rampsmith')).toEqual({});
    for (const domain of [
      'evil.example',
      'a.myshopify.com.evil.example',
      '',
      'x/y.myshopify.com',
    ]) {
      expect(appLinkFor('welcome', domain, 'rampsmith'), domain).toEqual({});
    }
    for (const handle of ['', 'Has Space', '../x', 'a'.repeat(64), '-lead']) {
      expect(appLinkFor('welcome', 'demo-store.myshopify.com', handle), handle).toEqual({});
      expect(isAppHandle(handle)).toBe(false);
    }
  });

  it('reads the handle from SHOPIFY_APP_HANDLE and defaults to the one in shopify.app.toml', () => {
    expect(createEmailRuntime({}).appHandle).toBe(DEFAULT_APP_HANDLE);
    expect(DEFAULT_APP_HANDLE).toBe('rampsmith');
    expect(createEmailRuntime({ SHOPIFY_APP_HANDLE: ' my-app ' }).appHandle).toBe('my-app');
    const bad = createEmailRuntime({ SHOPIFY_APP_HANDLE: 'Not A Handle' });
    expect(bad.appHandle).toBe(DEFAULT_APP_HANDLE);
    expect(bad.problems.join(' ')).toContain('SHOPIFY_APP_HANDLE');
  });
});
