/**
 * What each App Home screen shows and does, against the typed fake api: contents, filters,
 * exports, saving, plan gates, and the empty, error and recovery states.
 */
import { expect, test } from '@playwright/test';
import { open, requestsSeen, section, shopify, reset, SHOP } from './app-helpers.ts';

const TOTE_FINDING = '00000000-0000-4000-8000-000000000102';

test.describe('overview', () => {
  test('shows the latest scan, issues by impact and fixes', async ({ page }) => {
    await open(page, 'default', '/app', 'Overview');
    const scan = section(page, 'Latest scan');
    await expect(scan).toContainText('Finished');
    await expect(scan).toContainText('Next scan');
    await expect(section(page, 'Checks')).toContainText('91% of checks passed (218 of 240).');
    await expect(section(page, 'Checks')).toContainText(
      'Automated checks find many accessibility issues, not all of them.',
    );
    const issues = section(page, 'Issues');
    await expect(issues).toContainText('Critical');
    await expect(issues.getByRole('link', { name: 'View all issues' })).toBeVisible();
    const fixes = section(page, 'Fixes');
    await expect(fixes).toContainText('Fixes waiting for your review: 2');
    await expect(fixes).toContainText('Fixes applied: 2');
    await expect(section(page, 'Plan')).toContainText('Your plan: Growth');
    await expect(section(page, 'Plan')).toContainText(
      'AI alt text drafts this period: 0 of 10,000',
    );
  });

  test('a new install shows an empty state, then follows a scan to its results', async ({
    page,
  }) => {
    await open(page, 'fresh', '/app', 'Overview');
    await expect(page.getByRole('heading', { name: 'No scan yet' })).toBeVisible();
    await page.locator('s-empty-state').getByRole('button', { name: 'Start a scan' }).click();
    await expect(page.locator('.live')).toHaveText(
      'Scan started. Results appear here as pages are checked.',
    );
    await expect(section(page, 'Latest scan')).toContainText(/Waiting to start|Running/);
    await expect(section(page, 'Latest scan')).toContainText('Finished', { timeout: 20_000 });
    await expect(section(page, 'Fixes')).toContainText('Fixes waiting for your review: 4');
    await expect(page.locator('.live')).toHaveText('Finished');
  });

  test('a failing api shows an error with a way to retry, and recovers', async ({ page }) => {
    await open(page, 'error', '/app', 'Overview');
    const banner = page.locator('s-banner[tone=critical]');
    await expect(banner).toContainText('Something went wrong');
    await expect(banner).toContainText('Rampsmith is temporarily unavailable.');
    await reset('default');
    await banner.getByRole('button', { name: 'Try again' }).click();
    await expect(page.locator('s-banner')).toHaveCount(0);
    await expect(section(page, 'Latest scan')).toContainText('Finished');
  });

  test('a session that expires is renewed once and the request repeats', async ({ page }) => {
    await reset('default');
    await shopify(page);
    // The first token the api sees is refused with the retry header; App Bridge gives a new one.
    let first = true;
    await page.addInitScript(() => {
      let n = 0;
      (globalThis as unknown as { shopify: unknown }).shopify = {
        idToken: () => Promise.resolve(n++ === 0 ? 'stale' : 'good'),
      };
    });
    await page.route('**/app/api/session', async (route) => {
      if (first) {
        first = false;
        await route.fulfill({
          status: 401,
          headers: {
            'x-shopify-retry-invalid-session-request': '1',
            'content-type': 'application/problem+json',
          },
          body: '{"code":"unauthenticated","title":"x","status":401}',
        });
      } else await route.continue();
    });
    await page.goto(`/app?${SHOP}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
    await expect(section(page, 'Latest scan')).toContainText('Finished');
  });
});

test.describe('issues', () => {
  test('lists the ranked issues with their criteria and whether they have a fix', async ({
    page,
  }) => {
    await open(page, 'default', '/app/findings', 'Issues');
    await expect(page.getByText('Issues: 7').first()).toBeVisible();
    const rows = page
      .getByRole('table', { name: 'Open accessibility issues, most important first' })
      .getByRole('row');
    await expect(rows).toHaveCount(8);
    await expect(rows.nth(1)).toContainText(
      'The image of Linen tote bag has no useful description',
    );
    await expect(rows.nth(1)).toContainText('1.1.1');
    await expect(rows.nth(1)).toContainText('Serious');
    await expect(page.getByRole('row').filter({ hasText: 'Links in the cart' })).toContainText(
      'On the path to purchase',
    );
  });

  test('filters by impact, where it was found and whether it has a fix', async ({ page }) => {
    await open(page, 'default', '/app/findings', 'Issues');
    await page.getByRole('combobox', { name: 'Impact' }).selectOption('critical');
    await expect(page.getByText('Issues: 1').first()).toBeVisible();
    await expect(page.getByRole('row')).toHaveCount(2);
    await page.getByRole('combobox', { name: 'Impact' }).selectOption('');
    await page.getByRole('combobox', { name: 'Found in' }).selectOption('data');
    await expect(page.getByText('Issues: 3').first()).toBeVisible();
    await page.getByRole('combobox', { name: 'Fix' }).selectOption('without');
    await expect(page.getByText('No issues match these filters.')).toBeVisible();
  });

  test('an empty list and a failing api each say so', async ({ page }) => {
    await open(page, 'empty', '/app/findings', 'Issues');
    await expect(page.getByRole('heading', { name: 'No open issues' })).toBeVisible();
    await open(page, 'error', '/app/findings', 'Issues');
    await expect(page.locator('s-banner[tone=critical]')).toContainText('Something went wrong');
  });

  test('an issue opens to its explanation, WCAG criterion, evidence and fixes', async ({
    page,
  }) => {
    await open(page, 'default', '/app/findings', 'Issues');
    await page
      .getByRole('link', { name: 'The image of Linen tote bag has no useful description' })
      .click();
    await expect(page).toHaveURL(new RegExp(`/app/findings/${TOTE_FINDING}`));
    await expect(page.getByText('Images need a short text description')).toBeVisible();
    const criteria = section(page, 'WCAG 2.2 criteria');
    await expect(criteria).toContainText('1.1.1');
    await expect(criteria).toContainText('Non-text Content');
    const learn = criteria.getByRole('link', { name: /Understanding success criterion 1\.1\.1/ });
    await expect(learn).toHaveAttribute(
      'href',
      /^https:\/\/www\.w3\.org\/WAI\/WCAG22\/Understanding\//,
    );
    await expect(section(page, 'Where it appears')).toContainText('img.product__media');
    await expect(section(page, 'Fixes')).toContainText('Applied');
    await expect(section(page, 'Evidence')).toContainText(
      'No before and after evidence has been captured yet.',
    );
  });

  test('an issue that does not exist says so', async ({ page }) => {
    await open(page, 'default', '/app/findings/00000000-0000-4000-8000-00000000ffff', /./);
    await expect(page.locator('s-banner[tone=critical]')).toContainText(
      'That item no longer exists.',
    );
  });
});

test.describe('remediation log', () => {
  test('lists every change with who approved it and how it was verified', async ({ page }) => {
    await open(page, 'default', '/app/log', 'Remediation log');
    const rows = page.getByRole('row');
    await expect(rows).toHaveCount(5);
    const mug = rows.filter({ hasText: 'Blue ceramic mug' });
    await expect(mug).toContainText('Sam Merchant');
    await expect(mug).toContainText('Verified');
    await expect(mug).toContainText('1.1.1');
    await expect(rows.filter({ hasText: 'Linen tote bag' })).toContainText(
      'Waiting for the next scan',
    );
    await expect(rows.filter({ hasText: 'Brass desk lamp' })).toContainText('Not applied');
  });

  test('exports CSV and JSON made by the reports package', async ({ page }) => {
    await open(page, 'default', '/app/log', 'Remediation log');
    const csv = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download CSV' }).click();
    const csvFile = await csv;
    expect(csvFile.suggestedFilename()).toBe('rampsmith-remediation-log.csv');
    const csvText = await (await import('node:fs/promises')).readFile(await csvFile.path(), 'utf8');
    expect(csvText).toContain('gid://shopify/MediaImage/1001');
    expect(csvText).toContain('Sam Merchant');
    await expect(page.locator('.live')).toHaveText('Downloaded rampsmith-remediation-log.csv.');

    const json = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download JSON' }).click();
    const jsonText = await (
      await import('node:fs/promises')
    ).readFile(await (await json).path(), 'utf8');
    const parsed = JSON.parse(jsonText) as { entries?: unknown[]; fixes?: unknown[] };
    expect((parsed.entries ?? parsed.fixes ?? []).length).toBe(4);
  });

  test('a store with no changes yet says so', async ({ page }) => {
    await open(page, 'fresh', '/app/log', 'Remediation log');
    await expect(page.getByRole('heading', { name: 'No changes yet' })).toBeVisible();
  });
});

test.describe('accessibility statement', () => {
  test('previews the statement as it is edited and saves a version', async ({ page }) => {
    await open(page, 'default', '/app/statement', 'Accessibility statement');
    await page.getByRole('textbox', { name: 'Business name' }).fill('Demo Store Ltd');
    await page.getByRole('textbox', { name: /^Email/ }).fill('access@demo-store.example');
    await page
      .getByRole('textbox', { name: /What you do for accessibility/ })
      .fill('We test new pages with a screen reader\nWe review alt text every month');
    const preview = page.frameLocator('iframe[title="Preview of your accessibility statement"]');
    await expect(preview.getByText('Demo Store Ltd').first()).toBeVisible({ timeout: 10_000 });
    await expect(preview.getByText('access@demo-store.example').first()).toBeVisible();
    await expect(preview.getByText('We test new pages with a screen reader')).toBeVisible();
    // The statement says what was and was not checked and never claims full conformance.
    await expect(preview.locator('body')).toContainText(/automated/i);
    const text = (await preview.locator('body').innerText()).toLowerCase();
    for (const banned of ['compliant', 'lawsuit-proof', 'guaranteed', 'certified'])
      expect(text).not.toContain(banned);

    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('.live')).toHaveText('Statement saved.');
    await expect(section(page, 'Saved versions')).toContainText('Version 1, Draft');
    await page.reload();
    await expect(page.getByRole('textbox', { name: 'Business name' })).toHaveValue(
      'Demo Store Ltd',
    );
  });

  test('known barriers can be added and removed, and focus stays put', async ({ page }) => {
    await open(page, 'default', '/app/statement', 'Accessibility statement');
    const add = page.getByRole('button', { name: 'Add a known barrier' });
    await add.click();
    await add.click();
    await expect(page.getByRole('group', { name: 'Known barrier 2' })).toBeVisible();
    await page.getByRole('button', { name: 'Remove known barrier 1' }).click();
    await expect(page.locator('.live')).toHaveText('Removed the known barrier.');
    await expect(page.getByRole('group', { name: /Known barrier/ })).toHaveCount(1);
    await expect(add).toBeFocused();
  });
});

test.describe('settings', () => {
  test('saves the weekly rescan, the email and the AI limits', async ({ page }) => {
    await open(page, 'default', '/app/settings', 'Settings');
    const save = page.getByRole('button', { name: 'Save' });
    await expect(save).toBeDisabled();
    await page.getByRole('switch', { name: 'Rescan every week' }).check();
    await page.getByRole('textbox', { name: 'Notification email' }).fill('team@demo-store.example');
    await page.getByRole('spinbutton', { name: 'Longest alt text (characters)' }).fill('120');
    await page.getByRole('spinbutton', { name: /AI budget/ }).fill('8');
    await save.click();
    await expect(page.locator('.live')).toHaveText('Settings saved.');
    await page.reload();
    await expect(page.getByRole('switch', { name: 'Rescan every week' })).toBeChecked();
    await expect(page.getByRole('textbox', { name: 'Notification email' })).toHaveValue(
      'team@demo-store.example',
    );
    await expect(
      page.getByRole('spinbutton', { name: 'Longest alt text (characters)' }),
    ).toHaveValue('120');
  });

  test('refuses values that are out of range and says which', async ({ page }) => {
    await open(page, 'default', '/app/settings', 'Settings');
    await page.getByRole('spinbutton', { name: 'Longest alt text (characters)' }).fill('20');
    await page.getByRole('spinbutton', { name: /AI budget/ }).fill('500');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Enter a number from 40 to 300.')).toBeVisible();
    await expect(page.getByText(/Enter an amount from 0 to/)).toBeVisible();
    await expect(page.locator('s-banner[tone=critical]')).toContainText(
      'Settings could not be saved.',
    );
  });

  test('stores a storefront password without ever showing it back', async ({ page }) => {
    await open(page, 'default', '/app/settings', 'Settings');
    await page.getByLabel('Storefront password').fill('s3cret-pass');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('.live')).toHaveText('Settings saved.');
    await expect(page.getByLabel('Storefront password')).toHaveValue('');
    await expect(
      page.getByText('A password is saved. Enter a new one to replace it.'),
    ).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'Remove the saved password' })).toBeVisible();
    expect(JSON.stringify(await requestsSeen())).not.toContain('s3cret-pass');
  });

  test('turns store emails off and on, saving at once and keeping the choice', async ({ page }) => {
    await open(page, 'default', '/app/settings', 'Settings');
    const emails = section(page, 'Email').getByRole('switch', { name: 'Email me about my store' });
    await expect(emails).toBeChecked();
    await emails.uncheck();
    await expect(page.locator('.live')).toHaveText('Email preference saved.');
    await page.reload();
    await expect(
      section(page, 'Email').getByRole('switch', { name: 'Email me about my store' }),
    ).not.toBeChecked();
    await section(page, 'Email').getByRole('switch', { name: 'Email me about my store' }).check();
    await expect(page.locator('.live')).toHaveText('Email preference saved.');
  });

  test('on the Free plan the weekly rescan is shown, labelled and disabled', async ({ page }) => {
    await open(page, 'free', '/app/settings', 'Settings');
    const weekly = page.getByRole('switch', { name: 'Rescan every week' });
    await expect(weekly).toBeDisabled();
    await expect(page.getByText('Weekly rescans are part of paid plans.')).toBeVisible();
    await expect(page.getByText('Needs the Starter plan').first()).toBeVisible();
    const plan = section(page, 'Plan');
    await expect(plan).toContainText('Your plan: Free');
    await expect(plan.getByRole('list', { name: 'Features' }).getByRole('listitem')).toHaveCount(9);
    await expect(plan).toContainText('Priority queue');
    await expect(plan).toContainText('Needs the Pro plan');
    await expect(plan.getByRole('link', { name: 'Compare plans' }).first()).toHaveAttribute(
      'href',
      'https://admin.shopify.com/store/demo-store/charges/rampsmith/pricing_plans',
    );
  });
});

test.describe('plan-gated fixes', () => {
  test('locked features are listed with the plan that unlocks them, and cannot be used', async ({
    page,
  }) => {
    await open(page, 'free', '/app/fixes', 'Review fixes');
    const more = section(page, 'More ways to fix');
    await expect(more).toContainText('Product description rewrites');
    await expect(more).toContainText('Needs the Growth plan');
    await expect(more).toContainText('Fixes as GitHub pull requests');
    await expect(more).toContainText('Needs the Starter plan');
    for (const name of ['Product description rewrites', 'Fixes as GitHub pull requests']) {
      await expect(more.getByRole('button', { name })).toBeDisabled();
    }
  });
});

test('every request to the api carries the session token and none goes unauthenticated', async ({
  page,
}) => {
  await open(page, 'default', '/app/fixes', 'Review fixes');
  await expect(section(page, 'Applied changes')).toContainText('Linen tote bag');
  const seen = await requestsSeen();
  expect(seen.length).toBeGreaterThan(3);
  expect(seen.every((r) => r.authorization === 'Bearer good')).toBe(true);
});
