import { expect, test } from '@playwright/test';
import { parsePolicy, pinnedPolicy, watchPolicyViolations } from './csp.ts';
import { axe, PAGES, SCHEMES, TURNSTILE_FAKE } from './site-helpers.ts';

for (const scheme of SCHEMES) {
  test.describe(`${scheme} mode`, () => {
    test.use({ colorScheme: scheme });

    for (const { path, heading } of PAGES) {
      test(`${path} has no WCAG 2.2 A or AA violations`, async ({ page }) => {
        const violations = watchPolicyViolations(page);
        await page.goto(path);
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading);
        await axe(page);
        expect(violations).toEqual([]);
      });
    }
  });
}

for (const { path, draft } of PAGES) {
  test(`${path} is a well-formed page`, async ({ page }) => {
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('main')).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    expect((await page.title()).length).toBeGreaterThan(0);
    // The navigation says where the visitor is.
    const current = page.locator('nav a[aria-current="page"]');
    if (path !== '/') {
      await expect(current).toHaveAttribute('href', path);
    }
    // Nothing is shown that Rampsmith's own claims policy bans.
    const text = (await page.locator('body').innerText()).toLowerCase();
    expect(text).not.toMatch(/lawsuit-proof|100% accessible|fully accessible/u);
    const robots = response?.headers()['x-robots-tag'];
    const metaTag = page.locator('meta[name="robots"]');
    if (draft) {
      expect(robots).toBe('noindex, nofollow');
      await expect(metaTag).toHaveAttribute('content', 'noindex, nofollow');
    } else {
      expect(robots).toBeUndefined();
      await expect(metaTag).toHaveCount(0);
    }
  });
}

test('every page sends the pinned policy; only the scanner also admits Turnstile', async ({
  page,
}) => {
  for (const { path } of PAGES) {
    const response = await page.goto(path);
    const policy = parsePolicy(response?.headers()['content-security-policy']);
    if (path === '/scan') {
      const pinned = pinnedPolicy(["'none'"]);
      expect(policy).toEqual({
        ...pinned,
        'script-src': [...(pinned['script-src'] ?? []), TURNSTILE_FAKE],
        'frame-src': [TURNSTILE_FAKE],
      });
    } else {
      expect(policy, path).toEqual(pinnedPolicy(["'none'"]));
    }
  }
});

test('the legal pages are marked as drafts that await attorney review', async ({ page }) => {
  for (const path of ['/privacy', '/terms', '/dpa']) {
    await page.goto(path);
    await expect(page.getByRole('note')).toContainText(
      'Draft — attorney review required. Not published.',
    );
  }
});

test('the pricing page shows the plan table with gated features labelled', async ({ page }) => {
  await page.goto('/pricing');
  const plans = page.getByRole('list', { name: 'Plans' });
  await expect(plans.getByRole('listitem')).toHaveCount(4);
  await expect(plans).toContainText('$79 a month');
  await expect(plans).toContainText('or $790 a year');
  await expect(plans).toContainText('$199 a month');
  await expect(plans).toContainText('or $1,990 a year');
  await expect(plans).toContainText('$499 a month');
  await expect(plans).toContainText('or $4,990 a year');
  await expect(plans).toContainText('Data fixes; the 6 core recipes as GitHub pull requests');
  await expect(plans).toContainText('25 drafts, once');
  await expect(plans).toContainText('50,000 drafts a month');

  const matrix = page.getByRole('table');
  const row = matrix.getByRole('row', { name: /^Regression alerts/u });
  const cells = row.getByRole('cell');
  await expect(cells).toHaveCount(4);
  await expect(cells.nth(0)).toContainText('Not included');
  await expect(cells.nth(0)).toContainText('Available on Growth');
  await expect(cells.nth(1)).toContainText('Not included');
  await expect(cells.nth(2)).toContainText('Included');
  await expect(cells.nth(3)).toContainText('Included');
  const proRow = matrix.getByRole('row', { name: /^Priority queue/u });
  await expect(proRow.getByRole('cell').nth(2)).toContainText('Available on Pro');
});

test('the home page links to the scanner and the pricing page', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('main').getByRole('link', { name: 'Scan your site free' }).first().click();
  await expect(page).toHaveURL(/\/scan$/u);
  await page.goto('/');
  await page.getByRole('main').getByRole('link', { name: 'See pricing' }).click();
  await expect(page).toHaveURL(/\/pricing$/u);
});

test.describe('on a phone-sized screen', () => {
  test.use({ viewport: { width: 320, height: 640 } });

  for (const { path } of PAGES) {
    test(`${path} reflows without sideways scrolling`, async ({ page }) => {
      await page.goto(path);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      await axe(page);
    });
  }
});
