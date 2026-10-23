/**
 * The Code fixes screen: connecting GitHub, choosing the repository, asking for pull requests,
 * and reading their state, by keyboard, with the plan gate and the server flag respected.
 */
import { expect, test, type Page } from '@playwright/test';
import { open, section } from './app-helpers.ts';

const live = (page: Page) => page.locator('.live');

test('the link to the screen shows only while the channel is on', async ({ page }) => {
  await open(page, 'codefix', '/app/code-fixes', 'Code fixes');
  await expect(page.locator('s-app-nav s-link', { hasText: 'Code fixes' })).toHaveCount(1);
});

test('a store whose channel is off is told so and sees no link', async ({ page }) => {
  await open(page, 'codefix_off', '/app/code-fixes', 'Code fixes');
  await expect(
    page.getByRole('heading', { level: 2, name: 'Code fixes are not available yet' }),
  ).toBeVisible();
  await expect(page.locator('s-app-nav s-link', { hasText: 'Code fixes' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Connect GitHub' })).toHaveCount(0);
});

test('a plan without pull requests sees the locked action and the plan that unlocks it', async ({
  page,
}) => {
  await open(page, 'codefix_locked', '/app/code-fixes', 'Code fixes');
  await expect(page.getByText('Needs the Starter plan')).toBeVisible();
  await expect(page.getByRole('button', { name: /Connect GitHub/u })).toBeDisabled();
});

test('connecting by keyboard moves focus to the link that continues on GitHub', async ({
  page,
}) => {
  await open(page, 'codefix_new', '/app/code-fixes', 'Code fixes');
  const connect = page.getByRole('button', { name: 'Connect GitHub' });
  await connect.focus();
  await page.keyboard.press('Enter');
  const next = page.getByRole('link', { name: 'Continue to GitHub (opens in a new tab)' });
  await expect(next).toBeFocused();
  await expect(next).toHaveAttribute('href', `/github/connect?state=${'A'.repeat(43)}`);
  await expect(next).toHaveAttribute('target', '_blank');
  await expect(live(page)).toHaveText(/Your link to GitHub is ready/u);
});

test('choose the repository, ask for the fixes and follow the request to its pull request', async ({
  page,
}) => {
  await open(page, 'codefix', '/app/code-fixes', 'Code fixes');
  const start = page.getByRole('button', { name: 'Fix open code issues' });
  await expect(start).toBeDisabled();
  await expect(page.getByText('Choose a repository with a theme first.')).toBeVisible();

  await page.getByRole('combobox', { name: 'Repository' }).selectOption('1001');
  await page.getByRole('textbox', { name: 'Branch connected to your live theme' }).fill('main');
  const save = page.getByRole('button', { name: 'Save repository' });
  await save.focus();
  await page.keyboard.press('Enter');
  await expect(live(page)).toHaveText('Repository saved: demo-store/theme.');
  await expect(page.getByText('demo-store/theme: Theme found.')).toBeVisible();

  await expect(start).toBeEnabled();
  await start.focus();
  await page.keyboard.press('Enter');
  await expect(live(page)).toHaveText(/Started/u);

  const requests = section(page, 'Recent requests');
  await expect(requests.getByText('Pull requests opened')).toBeVisible({ timeout: 15_000 });
  await expect(requests.getByText('7 of 12 issues fixed.')).toBeVisible();
  await expect(requests.getByText(/needs your words: 3/u)).toBeVisible();

  const prs = section(page, 'Pull requests');
  const link = prs.getByRole('link', { name: 'Pull request 41 (opens in a new tab)' });
  await expect(link).toHaveAttribute('href', 'https://github.com/demo-store/theme/pull/41');
  await expect(prs.getByText('7 fixes, 4 files, 19 lines')).toBeVisible();
  await expect(prs.getByText('Open', { exact: true })).toBeVisible();
});

test('disconnecting GitHub returns to the connect step and announces it', async ({ page }) => {
  await open(page, 'codefix', '/app/code-fixes', 'Code fixes');
  const disconnect = page.getByRole('button', { name: 'Disconnect GitHub' });
  await disconnect.focus();
  await page.keyboard.press('Enter');
  await expect(live(page)).toHaveText('GitHub is disconnected.');
  await expect(page.getByRole('button', { name: 'Connect GitHub' })).toBeVisible();
});
