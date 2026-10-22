import { expect, test, type Page } from '@playwright/test';
import { watchPolicyViolations } from './csp.ts';
import {
  axe,
  PROXY_HEADERS,
  SCHEMES,
  SITE,
  SITE_CLOSED,
  SITE_FIXTURE,
  TURNSTILE_FAKE,
} from './site-helpers.ts';

interface SiteverifyCall {
  secret: string;
  response: string;
  remoteip: string | null;
}

async function siteverifyCalls(page: Page): Promise<SiteverifyCall[]> {
  return (await (await page.request.get(`${TURNSTILE_FAKE}/calls`)).json()) as SiteverifyCall[];
}

async function scan(page: Page, address: string): Promise<void> {
  await page.getByLabel('Website address').fill(address);
  await page.getByRole('button', { name: 'Scan this site' }).click();
}

/** Posts the form the way a browser without JavaScript would. */
function post(page: Page, base: string, address: string, token: string) {
  return page.request.post(`${base}/scan`, {
    headers: { origin: base, accept: 'text/html', ...PROXY_HEADERS },
    form: { url: address, 'cf-turnstile-response': token },
    maxRedirects: 0,
  });
}

test.describe('the scanner, with Turnstile stood in and no engine connected', () => {
  test('shows the form with the bot check, and nothing unprotected', async ({ page }) => {
    const violations = watchPolicyViolations(page);
    await page.goto('/scan');
    await expect(page.getByLabel('Website address')).toBeVisible();
    await expect(page.getByText('Bot check passed (test stand-in)')).toBeVisible();
    await expect(page.locator('input[name="cf-turnstile-response"]')).toHaveCount(1);
    await expect(page.getByText('3 scans a day')).toBeVisible();
    await expect(page.getByText('never solves or bypasses one')).toBeVisible();
    expect(violations).toEqual([]);
  });

  for (const scheme of SCHEMES) {
    test(`says plainly that the scanner is not connected (${scheme} mode)`, async ({ browser }) => {
      const context = await browser.newContext({
        baseURL: SITE,
        colorScheme: scheme,
        extraHTTPHeaders: PROXY_HEADERS,
      });
      const page = await context.newPage();
      await page.goto('/scan');
      const before = (await siteverifyCalls(page)).length;
      await scan(page, 'example.com');
      const status = page.getByRole('status');
      await expect(status).toContainText('The scanner is not connected yet');
      await expect(status).toContainText('did not count against your daily scans');
      // With JavaScript the outcome takes the focus, so a screen reader reads it.
      await expect(page.locator('.outcome')).toBeFocused();
      await axe(page);
      // The address was checked and the token verified on the server, with the visitor's address.
      const calls = await siteverifyCalls(page);
      expect(calls.length).toBe(before + 1);
      const last = calls[calls.length - 1];
      expect(last?.secret).toBe('fake-secret');
      expect(last?.response).toMatch(/^fake-pass-/u);
      expect(last?.remoteip).toBe('127.0.0.1');
      await context.close();
    });
  }

  test('a refused attempt uses no scan, so the cap is never reached', async ({ page }) => {
    await page.goto('/scan');
    for (let i = 0; i < 5; i += 1) {
      await scan(page, `shop-${i.toString()}.com`);
      await expect(page.getByRole('status')).toContainText('not connected yet');
    }
  });

  test('turns away addresses that are not public websites before asking Cloudflare', async ({
    page,
  }) => {
    await page.goto('/scan');
    const before = (await siteverifyCalls(page)).length;
    const cases: [string, string][] = [
      ['', 'Enter a website address.'],
      ['http://127.0.0.1/', 'Enter a website name, not an IP address.'],
      ['https://localhost', 'Only public websites can be scanned.'],
      [
        'https://shop.com:8443',
        'Only the standard web ports can be scanned. Remove the port number.',
      ],
      ['ftp://shop.com', 'Only http and https addresses can be scanned.'],
    ];
    for (const [address, message] of cases) {
      await scan(page, address);
      const field = page.getByLabel('Website address');
      await expect(page.getByText(message)).toBeVisible();
      await expect(field).toHaveAttribute('aria-invalid', 'true');
      await expect(field).toHaveAccessibleDescription(new RegExp(message.slice(0, 20), 'u'));
      await expect(field).toHaveValue(address);
    }
    await axe(page);
    expect((await siteverifyCalls(page)).length).toBe(before);
  });

  test('rejects a missing, made-up or replayed bot-check token on the server', async ({ page }) => {
    for (const token of ['', 'fake-bad']) {
      const response = await post(page, SITE, 'example.com', token);
      expect(response.status(), token).toBe(400);
      expect(await response.text()).toContain('The bot check did not pass');
    }
    const first = await post(page, SITE, 'example.com', 'fake-pass-replay-1');
    expect(first.status()).toBe(503);
    expect(await first.text()).toContain('The scanner is not connected yet');
    const replay = await post(page, SITE, 'example.com', 'fake-pass-replay-1');
    expect(replay.status()).toBe(400);
    expect(await replay.text()).toContain('The bot check did not pass');
  });

  test('keeps working as a plain form when JavaScript is off, and says why it cannot scan', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      baseURL: SITE,
      javaScriptEnabled: false,
      extraHTTPHeaders: PROXY_HEADERS,
    });
    const page = await context.newPage();
    await page.goto('/scan');
    // The note sits in <noscript>, so it is in the page's HTML for a browser without scripts.
    expect(await page.content()).toContain('The bot check needs JavaScript');
    await scan(page, 'example.com');
    await expect(page.getByRole('alert')).toContainText('The bot check did not pass');
    await expect(page.getByLabel('Website address')).toHaveValue('example.com');
    await context.close();
  });

  test('the whole flow works from the keyboard', async ({ page }) => {
    await page.goto('/scan');
    await page.getByLabel('Website address').focus();
    await page.keyboard.type('example.com');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Scan this site' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status')).toContainText('not connected yet');
  });
});

test.describe('the scanner, with a fixed sample result', () => {
  test.use({ baseURL: SITE_FIXTURE });

  test('shows counts and three examples per failure, once and never indexed', async ({ page }) => {
    await page.goto('/scan');
    await scan(page, 'https://www.example.com/products/a');
    const result = page.getByRole('heading', { name: 'Results for example.com' });
    await expect(result).toBeVisible();
    await expect(page.locator('.outcome')).toBeFocused();
    await expect(page.getByText('Passes 41 of 47 automated WCAG 2.2 AA checks')).toBeVisible();
    await expect(page.getByText('12 elements, WCAG 1.1.1')).toBeVisible();
    await expect(page.getByText('Test data.')).toBeVisible();
    await expect(page.getByText('This result is automated and partial')).toBeVisible();
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
      'content',
      'noindex, nofollow',
    );
    expect(
      await page.locator('.groups li').first().locator('.examples li').count(),
    ).toBeLessThanOrEqual(3);
    for (const scheme of SCHEMES) {
      await page.emulateMedia({ colorScheme: scheme });
      await axe(page);
    }
  });

  test('serves a result that is no cache hit with private, no-store headers', async ({ page }) => {
    const response = await post(page, SITE_FIXTURE, 'headers-check.com', 'fake-pass-headers-1');
    expect(response.status()).toBe(200);
    expect(response.headers()['cache-control']).toBe('private, no-store');
    expect(response.headers()['x-robots-tag']).toBe('noindex, nofollow');
  });

  test('caches a domain for a day and stops a visitor at three scans', async ({ page }) => {
    // example.com was scanned above and headers-check.com just now: two of the three scans.
    // A repeat of a scanned domain comes from the cache and costs no scan.
    const cached = await post(page, SITE_FIXTURE, 'www.example.com', 'fake-pass-cap-1');
    expect(cached.status()).toBe(200);
    expect(await cached.text()).toContain('result from the last 24 hours');
    const third = await post(page, SITE_FIXTURE, 'third-shop.com', 'fake-pass-cap-2');
    expect(third.status()).toBe(200);
    const fourth = await post(page, SITE_FIXTURE, 'fourth-shop.com', 'fake-pass-cap-3');
    expect(fourth.status()).toBe(429);
    expect(Number(fourth.headers()['retry-after'])).toBeGreaterThan(0);
    expect(await fourth.text()).toContain("You have used today's 3 scans");
  });

  test('shows the limit message accessibly', async ({ page }) => {
    await page.goto('/scan');
    await scan(page, 'fifth-shop.com');
    await expect(page.getByRole('alert')).toContainText("You have used today's 3 scans");
    await axe(page);
  });
});

test.describe('the scanner, on a server without Turnstile keys', () => {
  test('stays closed instead of running unprotected', async ({ page }) => {
    await page.goto(`${SITE_CLOSED}/scan`);
    await expect(page.getByText('The free scanner is closed for now')).toBeVisible();
    await expect(page.getByLabel('Website address')).toHaveCount(0);
    await axe(page);
    const response = await post(page, SITE_CLOSED, 'example.com', 'fake-pass-closed-1');
    expect(response.status()).toBe(503);
  });
});
