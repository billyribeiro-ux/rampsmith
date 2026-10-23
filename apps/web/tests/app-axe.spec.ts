/**
 * Axe at WCAG 2.2 A and AA on every App Home screen and state, against the typed fake api and
 * the Polaris test shim (ADR-094). Zero violations is the bar; the real components are
 * checked on a dev store (docs/evidence/r1-lane-c.md, LAUNCH.md section E).
 */
import { expect, test } from '@playwright/test';
import { axe, open } from './app-helpers.ts';
import type { ScenarioName } from './app-fake-api.ts';

const IMAGE_FINDING = '00000000-0000-4000-8000-000000000101';
const RENDER_FINDING = '00000000-0000-4000-8000-000000000200';

interface Screen {
  readonly name: string;
  readonly path: string;
  readonly heading: string | RegExp;
  readonly scenarios: readonly ScenarioName[];
}

const SCREENS: readonly Screen[] = [
  {
    name: 'overview',
    path: '/app',
    heading: 'Overview',
    scenarios: ['default', 'free', 'fresh', 'empty', 'error'],
  },
  {
    name: 'issue list',
    path: '/app/findings',
    heading: 'Issues',
    scenarios: ['default', 'empty', 'error'],
  },
  {
    name: 'image issue',
    path: `/app/findings/${IMAGE_FINDING}`,
    heading: /./,
    scenarios: ['default', 'error'],
  },
  {
    name: 'page issue',
    path: `/app/findings/${RENDER_FINDING}`,
    heading: /./,
    scenarios: ['default'],
  },
  {
    name: 'fix review',
    path: '/app/fixes',
    heading: 'Review fixes',
    scenarios: ['default', 'free', 'fresh', 'error'],
  },
  {
    name: 'remediation log',
    path: '/app/log',
    heading: 'Remediation log',
    scenarios: ['default', 'fresh', 'error'],
  },
  {
    name: 'statement',
    path: '/app/statement',
    heading: 'Accessibility statement',
    scenarios: ['default', 'fresh', 'error'],
  },
  {
    name: 'code fixes',
    path: '/app/code-fixes',
    heading: 'Code fixes',
    scenarios: ['codefix', 'codefix_new', 'codefix_locked', 'codefix_off', 'error'],
  },
  {
    name: 'settings',
    path: '/app/settings',
    heading: 'Settings',
    scenarios: ['default', 'free', 'starter', 'error'],
  },
];

for (const screen of SCREENS) {
  for (const scenario of screen.scenarios) {
    test(`${screen.name} (${scenario}) has no WCAG 2.2 AA violations`, async ({ page }) => {
      await open(page, scenario, screen.path, screen.heading);
      // Wait for data or the error block, not the loading spinner.
      await expect(page.getByRole('status', { name: 'Loading' })).toHaveCount(0);
      await axe(page);
    });
  }
}

test('the fix editor, with and without an error, has no violations', async ({ page }) => {
  await open(page, 'default', '/app/fixes', 'Review fixes');
  await page.getByRole('button', { name: /^Edit alt text for Brass desk lamp/ }).click();
  const field = page.getByRole('textbox', { name: 'Alt text' });
  await expect(field).toBeFocused();
  await axe(page);
  await field.fill('x'.repeat(200));
  await expect(page.getByText('Alt text can be at most 150 characters.')).toBeVisible();
  await axe(page);
});

test('the settings form with validation errors has no violations', async ({ page }) => {
  await open(page, 'default', '/app/settings', 'Settings');
  await page.getByRole('textbox', { name: /Notification email/ }).fill('not an address');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Enter a valid email address.').first()).toBeVisible();
  await axe(page);
});

test('the statement preview and a saved statement have no violations', async ({ page }) => {
  await open(page, 'default', '/app/statement', 'Accessibility statement');
  await page.getByRole('textbox', { name: 'Business name' }).fill('Demo Store Ltd');
  await page.getByRole('textbox', { name: /^Email/ }).fill('access@demo-store.example');
  await page.getByRole('button', { name: 'Add a known barrier' }).click();
  await expect(page.getByRole('group', { name: 'Known barrier 1' })).toBeVisible();

  // The preview is a sandboxed frame without scripts, which axe cannot enter. The frame
  // itself (its title) is checked with the page; the statement document it shows is loaded
  // as a page of its own and checked too.
  const frame = page.locator('iframe[title="Preview of your accessibility statement"]');
  await expect(frame).toBeVisible({ timeout: 10_000 });
  await axe(page, ['iframe']);
  const document = await frame.getAttribute('srcdoc');
  expect(document).toContain('<html lang="en">');
  const statement = await page.context().newPage();
  await statement.setContent(document ?? '');
  await axe(statement);
  await statement.close();

  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Statement saved.').first()).toBeVisible();
  await axe(page, ['iframe']);
});
