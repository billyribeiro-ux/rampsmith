import { expect, test, type Page } from '@playwright/test';
import { axe, MOCK_API, PROXY_HEADERS, SITE_API, TURNSTILE_FAKE } from './site-helpers.ts';

interface Call {
  method: string;
  path: string;
  authorization: string | undefined;
  body: { url: string; turnstile_token: string; client_ip: string } | undefined;
}

const calls = async (page: Page): Promise<Call[]> =>
  (await (await page.request.get(`${MOCK_API}/_free_scan_calls`)).json()) as Call[];

async function scan(page: Page, address: string): Promise<void> {
  await expect(page.locator('input[name="cf-turnstile-response"]')).toHaveCount(1);
  await page.getByLabel('Website address').fill(address);
  await page.getByRole('button', { name: 'Scan this site' }).click();
}

test.describe('the scanner, running through the api', () => {
  test.use({ baseURL: SITE_API, extraHTTPHeaders: PROXY_HEADERS });

  test('hands the visitor and the bot-check token to the api, then shows the real result', async ({
    page,
  }) => {
    await page.goto('/scan');
    // The api owns the bot check: this server never calls Cloudflare's verification.
    const verifiedBefore = (await (
      await page.request.get(`${TURNSTILE_FAKE}/calls`)
    ).json()) as unknown[];
    await scan(page, 'https://www.example.com/products/a');
    await expect(page.getByRole('heading', { name: 'Results for example.com' })).toBeVisible();
    await expect(page.getByText('Passes 38 of 44 automated WCAG 2.2 AA checks')).toBeVisible();
    await expect(page.getByText('7 elements, WCAG 1.1.1')).toBeVisible();
    // Not the end-to-end sample: a real result carries no test-data notice.
    await expect(page.getByText('Test data.')).toHaveCount(0);
    await expect(page.locator('.outcome')).toBeFocused();
    await axe(page);

    const verifiedAfter = (await (
      await page.request.get(`${TURNSTILE_FAKE}/calls`)
    ).json()) as unknown[];
    expect(verifiedAfter.length).toBe(verifiedBefore.length);

    const all = await calls(page);
    const post = all.filter((c) => c.method === 'POST').at(-1);
    expect(post?.authorization).toBe('Bearer e2e-service-token-0123456789abcdef0123456789');
    expect(post?.body?.url).toBe('https://www.example.com/products/a');
    expect(post?.body?.turnstile_token).toMatch(/^fake-pass-/u);
    expect(post?.body?.client_ip).toBe('127.0.0.1');
    // It polled the scan by the id the api gave.
    expect(all.some((c) => c.method === 'GET' && c.path.startsWith('/v1/free-scans/'))).toBe(true);
  });

  test('says when the site asked scanners to stay away', async ({ page }) => {
    await page.goto('/scan');
    await scan(page, 'robots-shop.com');
    await expect(page.getByRole('alert')).toContainText('robots.txt asks scanners to stay away');
    await axe(page);
  });

  test('shows the api’s daily limit with how long to wait', async ({ page }) => {
    await page.goto('/scan');
    await scan(page, 'limit-shop.com');
    await expect(page.getByRole('alert')).toContainText("You have used today's 3 scans");
    await expect(page.getByRole('alert')).toContainText('about 2 hours');
  });

  test('tells a visitor the scanner is busy without charging a scan', async ({ page }) => {
    await page.goto('/scan');
    await scan(page, 'busy-shop.com');
    await expect(page.getByRole('alert')).toContainText('The scanner is busy right now');
    await expect(page.getByRole('alert')).toContainText('did not count against your daily scans');
  });

  test('answers a "check again" for a scan that was still running', async ({ page }) => {
    const response = await page.request.post(`${SITE_API}/scan`, {
      headers: { origin: SITE_API, accept: 'text/html', ...PROXY_HEADERS },
      form: { scan: '0199c0de-0000-7000-8000-0000000000f1', url: 'example.com' },
      maxRedirects: 0,
    });
    expect(response.status()).toBe(200);
    expect(await response.text()).toContain('Results for example.com');
    const refused = await page.request.post(`${SITE_API}/scan`, {
      headers: { origin: SITE_API, accept: 'text/html', ...PROXY_HEADERS },
      form: { scan: 'not-an-id', url: 'example.com' },
      maxRedirects: 0,
    });
    expect(refused.status()).toBe(400);
  });
});
