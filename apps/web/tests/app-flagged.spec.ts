/**
 * A draft the engine flagged (security audit M1, ADR-096): the card says why in words, the
 * merchant must tick a check before Approve works, the request carries the confirmation, and
 * the whole thing is reachable and announced without a pointer. An unflagged card is unchanged.
 */
import { expect, test, type Page } from '@playwright/test';
import { axe, open, requestsSeen } from './app-helpers.ts';

const card = (page: Page, product: string) =>
  page.getByRole('article').filter({ has: page.getByRole('heading', { level: 3, name: product }) });
const approve = (page: Page, product: string) =>
  page.getByRole('button', { name: `Approve alt text for ${product}` });

test('a flagged draft explains why and cannot be approved before the check is ticked', async ({
  page,
}) => {
  await open(page, 'flagged', '/app/fixes', 'Review fixes');
  const lamp = card(page, 'Brass desk lamp');
  await expect(lamp).toContainText('Check this draft before you approve it');
  await expect(lamp).toContainText('looked like instructions to it');
  await expect(lamp).toContainText('reads like an instruction to an AI');
  await expect(approve(page, 'Brass desk lamp')).toBeDisabled();
  await axe(page);

  // An unflagged draft is untouched: no warning, Approve works at once.
  const blanket = card(page, 'Wool throw blanket');
  await expect(blanket).not.toContainText('Check this draft');
  await expect(approve(page, 'Wool throw blanket')).toBeEnabled();
});

test('ticking the check enables Approve, and the request carries the confirmation', async ({
  page,
}) => {
  await open(page, 'flagged', '/app/fixes', 'Review fixes');
  const lamp = card(page, 'Brass desk lamp');
  const check = lamp.getByRole('checkbox', { name: /I checked this alt text against the image/ });
  await check.focus();
  await page.keyboard.press('Space');
  await expect(check).toBeChecked();
  await expect(approve(page, 'Brass desk lamp')).toBeEnabled();
  await approve(page, 'Brass desk lamp').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.live')).toHaveText(/Approved the alt text for Brass desk lamp/);
  const seen = await requestsSeen();
  expect(
    seen.some((r) => r.method === 'POST' && r.path.endsWith('/approve?confirm_flagged=true')),
  ).toBe(true);
});

test('an unflagged draft is approved without the confirmation parameter', async ({ page }) => {
  await open(page, 'flagged', '/app/fixes', 'Review fixes');
  await approve(page, 'Wool throw blanket').click();
  await expect(page.locator('.live')).toHaveText(/Approved the alt text for Wool throw blanket/);
  const seen = await requestsSeen();
  const approvals = seen.filter((r) => r.method === 'POST' && r.path.includes('/approve'));
  expect(approvals.every((r) => !r.path.includes('confirm_flagged=true'))).toBe(true);
});
