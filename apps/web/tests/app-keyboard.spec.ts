/**
 * Keyboard flows and focus management for the alt-text review queue: approve, edit and undo
 * without a pointer, where focus goes after each action, and what a screen reader is told.
 * Every action here is a key press on a focused control; nothing is clicked.
 */
import { expect, test, type Page } from '@playwright/test';
import { open, section } from './app-helpers.ts';

const live = (page: Page) => page.locator('.live');
const card = (page: Page, product: string) =>
  page.getByRole('article').filter({ has: page.getByRole('heading', { level: 3, name: product }) });
const button = (page: Page, verb: string, product: string) =>
  page.getByRole('button', {
    name:
      verb === 'Undo' ? `Undo alt text change for ${product}` : `${verb} alt text for ${product}`,
  });

test('approve with the keyboard moves focus to the next card and announces the result', async ({
  page,
}) => {
  await open(page, 'default', '/app/fixes', 'Review fixes');
  const lamp = button(page, 'Approve', 'Brass desk lamp');
  await lamp.focus();
  await page.keyboard.press('Enter');

  await expect(live(page)).toHaveText(/Approved the alt text for Brass desk lamp/);
  await expect(page.getByRole('heading', { level: 3, name: 'Wool throw blanket' })).toBeFocused();

  // The change is applied in the background; the lists follow it and the lamp moves across.
  const applied = section(page, 'Applied changes');
  await expect(applied.getByRole('heading', { level: 3, name: 'Brass desk lamp' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    card(page, 'Brass desk lamp').getByText('Applied', { exact: true }).first(),
  ).toBeVisible();
});

test('edit with the keyboard: focus enters the field, Escape returns to Edit, Save returns to Approve', async ({
  page,
}) => {
  await open(page, 'default', '/app/fixes', 'Review fixes');
  const edit = button(page, 'Edit', 'Brass desk lamp');
  await edit.focus();
  await page.keyboard.press('Enter');

  const field = page.getByRole('textbox', { name: 'Alt text' });
  await expect(field).toBeFocused();
  await expect(field).toHaveValue('A brass desk lamp with an adjustable arm and a round shade');
  await expect(page.getByText(/\d+ of 150 characters/)).toBeVisible();

  // Escape abandons the edit and puts focus back where it was.
  await page.keyboard.type(' (edited)');
  await page.keyboard.press('Escape');
  await expect(field).toHaveCount(0);
  await expect(edit).toBeFocused();
  await expect(card(page, 'Brass desk lamp')).toContainText(
    'A brass desk lamp with an adjustable arm and a round shade',
  );
  await expect(card(page, 'Brass desk lamp')).not.toContainText('(edited)');

  // Edit again, replace the text, Tab to Save and press Enter.
  await page.keyboard.press('Enter');
  await expect(field).toBeFocused();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('A small brass lamp with a green glass shade');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Save' })).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(live(page)).toHaveText(/Saved your edit to the alt text for Brass desk lamp/);
  await expect(button(page, 'Approve', 'Brass desk lamp')).toBeFocused();
  await expect(card(page, 'Brass desk lamp')).toContainText(
    'A small brass lamp with a green glass shade',
  );
  await expect(card(page, 'Brass desk lamp')).toContainText('Edited by you');
});

test('an empty or too long edit is refused with a message tied to the field', async ({ page }) => {
  await open(page, 'default', '/app/fixes', 'Review fixes');
  await button(page, 'Edit', 'Brass desk lamp').focus();
  await page.keyboard.press('Enter');
  const field = page.getByRole('textbox', { name: 'Alt text' });
  await expect(field).toBeFocused();

  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await expect(page.getByText('Write some alt text, or reject this suggestion.')).toBeVisible();
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();

  await page.keyboard.type('x'.repeat(151));
  await expect(page.getByText('Alt text can be at most 150 characters.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
});

test('undo with the keyboard restores the earlier text and moves focus on', async ({ page }) => {
  await open(page, 'default', '/app/fixes', 'Review fixes');
  const undo = button(page, 'Undo', 'Linen tote bag');
  await undo.focus();
  await page.keyboard.press('Enter');

  await expect(live(page)).toHaveText(/Undid the alt text change for Linen tote bag/);
  const applied = section(page, 'Applied changes');
  await expect(applied.getByRole('heading', { level: 3, name: 'Linen tote bag' })).toHaveCount(0);
  // Focus lands on a heading in the applied list, not on the document body.
  await expect(applied.getByRole('heading', { level: 3, name: 'Blue ceramic mug' })).toBeFocused();
});

test('reject with the keyboard removes the card and announces it', async ({ page }) => {
  await open(page, 'default', '/app/fixes', 'Review fixes');
  await button(page, 'Reject', 'Wool throw blanket').focus();
  await page.keyboard.press('Enter');
  await expect(live(page)).toHaveText(/Rejected the alt text for Wool throw blanket/);
  await expect(card(page, 'Wool throw blanket')).toHaveCount(0);
  // The last card is gone from the end of the list, so focus moves to the one before it.
  await expect(page.getByRole('heading', { level: 3, name: 'Brass desk lamp' })).toBeFocused();
});

test('when the last card leaves, focus moves to the empty message', async ({ page }) => {
  await open(page, 'default', '/app/fixes', 'Review fixes');
  await button(page, 'Reject', 'Wool throw blanket').focus();
  await page.keyboard.press('Enter');
  await expect(card(page, 'Wool throw blanket')).toHaveCount(0);
  await button(page, 'Reject', 'Brass desk lamp').focus();
  await page.keyboard.press('Enter');
  const empty = page.getByText('Nothing is waiting for review.');
  await expect(empty).toBeFocused();
});

test('every control in the queue can be reached with Tab alone, in reading order', async ({
  page,
}) => {
  await open(page, 'default', '/app/fixes', 'Review fixes');
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  const seen: string[] = [];
  for (let i = 0; i < 12; i += 1) {
    await page.keyboard.press('Tab');
    const name = await page.evaluate(() => {
      let el: Element | null = document.activeElement;
      while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
      return el === null ? '' : (el.getAttribute('aria-label') ?? el.textContent.trim());
    });
    seen.push(name);
  }
  const wanted = [
    'Approve alt text for Brass desk lamp',
    'Edit alt text for Brass desk lamp',
    'Reject alt text for Brass desk lamp',
    'Approve alt text for Wool throw blanket',
    'Edit alt text for Wool throw blanket',
    'Reject alt text for Wool throw blanket',
    'Undo alt text change for Blue ceramic mug',
    'Undo alt text change for Linen tote bag',
  ];
  let from = 0;
  for (const label of wanted) {
    const at = seen.indexOf(label, from);
    expect(at, `${label} in ${JSON.stringify(seen)}`).toBeGreaterThanOrEqual(from);
    from = at + 1;
  }
});

test('the email switch works with the keyboard alone', async ({ page }) => {
  await open(page, 'default', '/app/settings', 'Settings');
  const emails = page.getByRole('switch', { name: 'Email me about my store' });
  await emails.focus();
  await expect(emails).toBeFocused();
  await page.keyboard.press('Space');
  await expect(emails).not.toBeChecked();
  await expect(live(page)).toHaveText('Email preference saved.');
});

test('the settings form works with the keyboard alone', async ({ page }) => {
  await open(page, 'default', '/app/settings', 'Settings');
  const weekly = page.getByRole('switch', { name: 'Scheduled rescans' });
  await weekly.focus();
  await page.keyboard.press('Space');
  await expect(weekly).toBeChecked();
  const save = page.getByRole('button', { name: 'Save' });
  await expect(save).toBeEnabled();
  await save.focus();
  await page.keyboard.press('Enter');
  await expect(live(page)).toHaveText('Settings saved.');
  await expect(save).toBeDisabled();
});

test('dismiss a regression with the keyboard and hear the result', async ({ page }) => {
  await open(page, 'regressed', '/app/regressions', 'Regressions');
  const dismiss = page.getByRole('button', { name: 'Dismiss from overview' });
  await dismiss.focus();
  await page.keyboard.press('Enter');
  await expect(live(page)).toHaveText('Dismissed. The record stays on this page.');
  await expect(dismiss).toHaveCount(0);
});

test('approve and revoke an agency link with the keyboard and hear each result', async ({
  page,
}) => {
  await open(page, 'default', '/app/agency', 'Agency access');
  const code = page.getByRole('textbox', { name: 'Link code' });
  await code.focus();
  await page.keyboard.type('abcde-12345');
  const check = page.getByRole('button', { name: 'Check code' });
  await check.focus();
  await page.keyboard.press('Enter');
  const approve = page.getByRole('button', { name: 'Approve access' });
  await expect(approve).toBeVisible();
  await approve.focus();
  await page.keyboard.press('Enter');
  await expect(live(page)).toHaveText("Northwind Digital can now see this store's summary.");
  const revoke = page.getByRole('button', { name: /Revoke access/ });
  await revoke.focus();
  await page.keyboard.press('Enter');
  await expect(live(page)).toHaveText('Access revoked for Northwind Digital.');
  await expect(page.getByText('No agency can see this store.')).toBeVisible();
});
