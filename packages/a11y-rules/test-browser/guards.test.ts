// Regression tests for the security audit of 5bd9f99 (H1, M4, M5): the checkout, personal-data
// and navigation guards, with the fixture server's request log as the witness.
import type { Browser } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { openCartDrawer, openMainNavigation } from '../src/index.ts';
import {
  launch,
  openFixture,
  startFixtureServer,
  stopFixtureServer,
  type FixtureOptions,
  type FixturePage,
} from './harness.ts';

let browser: Browser;
let open: FixturePage | null = null;

beforeAll(async () => {
  await startFixtureServer();
  browser = await launch();
});
afterAll(async () => {
  await browser.close();
  await stopFixtureServer();
});
afterEach(async () => {
  if (open !== null) {
    expect(open.blocked).toEqual([]);
    await open.context.close();
    open = null;
  }
});

async function load(path: string, options?: FixtureOptions): Promise<FixturePage> {
  open = await openFixture(browser, path, options);
  return open;
}

function paths(fixture: FixturePage): string[] {
  return fixture.served().map((r) => `${r.method} ${r.path}`);
}

function reachedCheckout(fixture: FixturePage): boolean {
  return paths(fixture).some((p) => p.includes('checkout'));
}

describe('H1: redirects, popups and service workers', () => {
  it('stops a form post the server redirects into checkout', async () => {
    const fixture = await load('/guard-302.html');
    expect(await openCartDrawer(fixture.page)).toMatchObject({
      status: 'blocked',
      guard: 'checkout',
      detail: expect.stringContaining('redirect into checkout') as unknown,
    });
    expect(paths(fixture)).toContain('POST /cart/add');
    expect(reachedCheckout(fixture)).toBe(false);
    expect(fixture.page.url()).toBe(`${fixture.origin}/guard-302.html`);
  });

  it('meets every hop of a redirect chain', async () => {
    const fixture = await load('/guard-chain.html');
    expect(await openCartDrawer(fixture.page)).toMatchObject({
      status: 'blocked',
      guard: 'checkout',
    });
    expect(paths(fixture)).toContain('GET /hop');
    expect(reachedCheckout(fixture)).toBe(false);
  });

  it('closes a popup the theme opens and stops its checkout request', async () => {
    const fixture = await load('/guard-window-open.html');
    const outcome = await openCartDrawer(fixture.page);
    expect(outcome).toMatchObject({ status: 'blocked' });
    expect(reachedCheckout(fixture)).toBe(false);
    expect(fixture.context.pages()).toEqual([fixture.page]);
  });

  it('refuses a form or button that targets a new window', async () => {
    const fixture = await load('/guard-target-blank.html');
    expect(await openCartDrawer(fixture.page)).toEqual({
      status: 'blocked',
      state: 'cart_drawer',
      guard: 'navigation',
      detail: 'opens another window',
    });
    expect(paths(fixture)).toEqual(['GET /guard-target-blank.html']);
  });

  it('stops a cart post that carries return_to, whatever the form looked like', async () => {
    const fixture = await load('/guard-return-to.html');
    expect(await openCartDrawer(fixture.page)).toMatchObject({
      status: 'blocked',
      guard: 'checkout',
    });
    expect(paths(fixture)).toEqual(['GET /guard-return-to.html']);
  });

  it('blocks service worker registration in a scan context', async () => {
    const fixture = await load('/guard-sw.html');
    expect((await openMainNavigation(fixture.page)).status).toBe('opened');
    expect(paths(fixture)).not.toContain('GET /sw.js');
    expect(fixture.context.serviceWorkers()).toEqual([]);
  });

  it('refuses to run in a context that lets pages register service workers', async () => {
    const fixture = await load('/guard-sw.html', { allowServiceWorkers: true });
    await fixture.page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    expect(await openMainNavigation(fixture.page)).toMatchObject({
      status: 'blocked',
      guard: 'checkout',
      detail: expect.stringContaining('scanContextOptions') as unknown,
    });
  });
});

describe('M4: the probe and the personal-data guard', () => {
  it('ignores a fake probe planted by the page and refuses the email field', async () => {
    const fixture = await load('/guard-planted.html');
    expect(await openCartDrawer(fixture.page)).toEqual({
      status: 'blocked',
      state: 'cart_drawer',
      guard: 'personal_data',
      detail: 'properties[Recipient email]',
    });
    expect(paths(fixture)).toEqual(['GET /guard-planted.html']);
  });

  it('refuses a form that holds a form-associated custom element', async () => {
    const fixture = await load('/guard-custom-field.html');
    expect(await openCartDrawer(fixture.page)).toEqual({
      status: 'blocked',
      state: 'cart_drawer',
      guard: 'personal_data',
      detail: 'custom form control gift-email',
    });
    expect(paths(fixture)).toEqual(['GET /guard-custom-field.html']);
  });

  it('blocks a page post to a non-cart endpoint while guarded', async () => {
    const fixture = await load('/clean.html');
    expect((await openMainNavigation(fixture.page)).status).toBe('opened');
    await fixture.page.evaluate(async () => {
      const body = new URLSearchParams({ form_type: 'customer', 'contact[email]': 'a@b.test' });
      await fetch('/contact', { method: 'POST', body }).catch(() => undefined);
    });
    expect(paths(fixture).filter((p) => p.startsWith('POST'))).toEqual([]);
  });
});

describe('M5: off-store navigation', () => {
  it('never triggers an off-store link and stops a scripted off-store navigation', async () => {
    const fixture = await load('/guard-offstore.html');
    expect(await openMainNavigation(fixture.page)).toMatchObject({
      status: 'blocked',
      guard: 'navigation',
      detail: expect.stringContaining('https://evil.example') as unknown,
    });
    expect(fixture.page.url()).toBe(`${fixture.origin}/guard-offstore.html`);
  });

  it('brings the page back after a script navigated it away', async () => {
    const fixture = await load('/nav-navigates.html');
    expect(await openMainNavigation(fixture.page)).toEqual({
      status: 'not_found',
      state: 'nav_open',
      reason: 'navigated_away',
    });
    expect(fixture.page.url()).toBe(`${fixture.origin}/nav-navigates.html`);
  });
});
