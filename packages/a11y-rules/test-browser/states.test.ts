import type { Browser } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  changeVariant,
  openCartDrawer,
  openFirstModal,
  openMainNavigation,
  openState,
} from '../src/index.ts';
import { launch, openFixture, type FixturePage } from './harness.ts';

let browser: Browser;
let open: FixturePage | null = null;

beforeAll(async () => {
  browser = await launch();
});
afterAll(async () => {
  await browser.close();
});
afterEach(async () => {
  if (open !== null) {
    expect(open.traffic.blocked).toEqual([]);
    await open.context.close();
    open = null;
  }
});

async function load(path: string): Promise<FixturePage> {
  open = await openFixture(browser, path);
  return open;
}

function paths(fixture: FixturePage): string[] {
  return fixture.traffic.served.map((r) => `${r.method} ${r.path}`);
}

describe('on the Dawn-like product page', () => {
  it('opens the main navigation by keyboard and returns the submenu', async () => {
    const fixture = await load('/clean.html');
    const outcome = await openMainNavigation(fixture.page);
    expect(outcome).toEqual({
      status: 'opened',
      state: 'nav_open',
      region: ['#HeaderMenu-MenuList-1'],
      trigger: ['#HeaderMenu-shop'],
    });
    expect(await fixture.page.evaluate(() => document.activeElement?.id)).toBe('HeaderMenu-shop');
  });

  it('adds the in-stock item, opens the cart drawer and never touches checkout', async () => {
    const fixture = await load('/clean.html');
    const outcome = await openCartDrawer(fixture.page);
    expect(outcome).toEqual({
      status: 'opened',
      state: 'cart_drawer',
      region: ['#CartDrawer'],
      trigger: ['#add-to-cart'],
    });
    expect(paths(fixture)).toContain('POST /cart/add.js');
    expect(paths(fixture).some((p) => p.includes('checkout'))).toBe(false);
  });

  it('changes the variant with the keyboard and returns the product region', async () => {
    const fixture = await load('/clean.html');
    const outcome = await changeVariant(fixture.page);
    expect(outcome).toMatchObject({
      status: 'opened',
      state: 'variant_changed',
      trigger: ['#size-s'],
    });
    expect(outcome.status === 'opened' ? outcome.region.join('') : '').toMatch(/product-info/);
    expect(await fixture.page.evaluate(() => document.getElementById('price')?.textContent)).toBe(
      '$80.00',
    );
    expect(
      await fixture.page.evaluate(
        () => (document.getElementById('size-m') as HTMLInputElement).checked,
      ),
    ).toBe(true);
  });

  it('opens the first modal and returns the dialog', async () => {
    const fixture = await load('/clean.html');
    const outcome = await openFirstModal(fixture.page);
    expect(outcome).toMatchObject({ status: 'opened', state: 'modal' });
    const region = outcome.status === 'opened' ? outcome.region : [];
    const role = await fixture.page.evaluate(
      (selector) => document.querySelector(selector)?.getAttribute('role'),
      region.join(''),
    );
    expect(role).toBe('dialog');
  });

  it('stops each script at its hard time cap', async () => {
    const fixture = await load('/clean.html');
    for (const state of ['nav_open', 'cart_drawer', 'variant_changed', 'modal'] as const) {
      const started = performance.now();
      expect(await openState(fixture.page, state, { timeoutMs: 1 })).toEqual({
        status: 'timed_out',
        state,
      });
      expect(performance.now() - started).toBeLessThan(3_000);
    }
  });

  it('dispatches by state name', async () => {
    const fixture = await load('/clean.html');
    expect((await openState(fixture.page, 'nav_open')).status).toBe('opened');
  });
});

describe('when a state is not on the page', () => {
  it('returns a typed reason for each state', async () => {
    const fixture = await load('/no-states.html');
    expect(await openMainNavigation(fixture.page)).toEqual({
      status: 'not_found',
      state: 'nav_open',
      reason: 'no_trigger',
    });
    expect(await openCartDrawer(fixture.page)).toEqual({
      status: 'not_found',
      state: 'cart_drawer',
      reason: 'no_product_form',
    });
    expect(await changeVariant(fixture.page)).toEqual({
      status: 'not_found',
      state: 'variant_changed',
      reason: 'no_variant_picker',
    });
    expect(await openFirstModal(fixture.page)).toEqual({
      status: 'not_found',
      state: 'modal',
      reason: 'no_trigger',
    });
    expect(paths(fixture)).toEqual(['GET /no-states.html']);
  });

  it('reports a sold-out product instead of adding it', async () => {
    const fixture = await load('/sold-out.html');
    expect(await openCartDrawer(fixture.page)).toEqual({
      status: 'not_found',
      state: 'cart_drawer',
      reason: 'sold_out',
    });
  });
});

describe('guards', () => {
  it('refuses a control that would enter checkout and sends nothing', async () => {
    const fixture = await load('/guard-checkout.html');
    expect(await openCartDrawer(fixture.page)).toEqual({
      status: 'blocked',
      state: 'cart_drawer',
      guard: 'checkout',
      detail: 'control named checkout',
    });
    expect(paths(fixture)).toEqual(['GET /guard-checkout.html']);
  });

  it('stops a theme that jumps to checkout after adding, before the request leaves', async () => {
    const fixture = await load('/guard-redirect.html');
    const outcome = await openCartDrawer(fixture.page);
    expect(outcome).toMatchObject({ status: 'blocked', state: 'cart_drawer', guard: 'checkout' });
    expect(paths(fixture)).toEqual(['GET /guard-redirect.html', 'POST /cart/add.js']);
    expect(fixture.page.url()).not.toMatch(/checkout/);
  });

  it('keeps the checkout guard on the page after the script returns', async () => {
    const fixture = await load('/clean.html');
    expect((await openMainNavigation(fixture.page)).status).toBe('opened');
    // A late theme script, or a cart form posted with `checkout`, is still stopped.
    await fixture.page.evaluate(async () => {
      await fetch('/checkouts/cn/late').catch(() => undefined);
      const body = new URLSearchParams({ checkout: '' });
      await fetch('/cart', { method: 'POST', body }).catch(() => undefined);
    });
    expect(paths(fixture).filter((p) => p.includes('checkout') || p === 'POST /cart')).toEqual([]);
  });

  it('never submits a form that carries personal data', async () => {
    const fixture = await load('/guard-pii.html');
    expect(await openCartDrawer(fixture.page)).toEqual({
      status: 'blocked',
      state: 'cart_drawer',
      guard: 'personal_data',
      detail: 'properties[Recipient email]',
    });
    expect(paths(fixture)).toEqual(['GET /guard-pii.html']);
  });

  it('never activates the "Buy it now" button on the product page', async () => {
    const fixture = await load('/clean.html');
    for (const run of [openMainNavigation, openCartDrawer, changeVariant, openFirstModal]) {
      await run(fixture.page);
    }
    expect(paths(fixture).some((p) => p.includes('checkout'))).toBe(false);
  });
});
