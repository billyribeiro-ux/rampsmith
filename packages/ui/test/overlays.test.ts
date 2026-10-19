import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import { describe, expect, it } from 'vitest';
import { expectAccessible } from './axe.ts';
import Dialogs from './fixtures/Dialogs.svelte';
import Menu from './fixtures/Menu.svelte';
import Toasts from './fixtures/Toasts.svelte';

describe('Dialog', () => {
  it('passes axe while open', async () => {
    const screen = await render(Dialogs);
    await page.getByRole('button', { name: 'Rename site' }).click();
    await expect.element(page.getByRole('dialog', { name: 'Rename site' })).toBeVisible();
    await expectAccessible(screen.container);
  });

  it('moves focus in on open, keeps Tab inside, and restores focus on Escape', async () => {
    await render(Dialogs);
    const trigger = page.getByRole('button', { name: 'Rename site' });
    await userEvent.tab();
    await expect.element(trigger).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    const dialog = page.getByRole('dialog', { name: 'Rename site' });
    await expect.element(dialog).toBeVisible();
    await expect.element(page.getByLabelText('Site name')).toHaveFocus();
    // Opened with showModal(), so the rest of the page is inert.
    expect(document.querySelector('dialog')?.matches(':modal')).toBe(true);
    for (const name of ['Cancel', 'Save']) {
      await userEvent.tab();
      await expect.element(page.getByRole('button', { name })).toHaveFocus();
    }
    await userEvent.keyboard('{Escape}');
    await expect.element(dialog).not.toBeInTheDocument();
    await expect.element(trigger).toHaveFocus();
    await expect.element(page.getByText('Closed 1 times')).toBeVisible();
  });

  it('closes from its own buttons and restores focus', async () => {
    await render(Dialogs);
    const trigger = page.getByRole('button', { name: 'Rename site' });
    await trigger.click();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect.element(trigger).toHaveFocus();
    await trigger.click();
    await page.getByRole('button', { name: 'Close' }).click();
    await expect.element(trigger).toHaveFocus();
    await expect.element(page.getByText('Closed 2 times')).toBeVisible();
  });
});

describe('MenuButton', () => {
  it('passes axe closed and open', async () => {
    const screen = await render(Menu);
    await expectAccessible(screen.container);
    await page.getByRole('button', { name: 'Actions' }).click();
    await expect.element(page.getByRole('menu')).toBeVisible();
    await expectAccessible(screen.container);
  });

  it('opens on the first item, moves with arrows, Home, End and letters, and chooses with Enter', async () => {
    await render(Menu);
    const button = page.getByRole('button', { name: 'Actions' });
    await userEvent.tab();
    await expect.element(button).toHaveAttribute('aria-expanded', 'false');
    await userEvent.keyboard('{Enter}');
    await expect.element(button).toHaveAttribute('aria-expanded', 'true');
    const item = (name: string) => page.getByRole('menuitem', { name });
    await expect.element(item('Rescan')).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    await expect.element(item('Export')).toHaveFocus();
    await userEvent.keyboard('{End}');
    await expect.element(item('Rename')).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    await expect.element(item('Rescan')).toHaveFocus();
    await userEvent.keyboard('{ArrowUp}');
    await expect.element(item('Rename')).toHaveFocus();
    await userEvent.keyboard('{Home}');
    await expect.element(item('Rescan')).toHaveFocus();
    await userEvent.keyboard('a');
    await expect.element(item('Archive')).toHaveFocus();
    // A disabled item can be focused but not chosen.
    await userEvent.keyboard('{Enter}');
    await expect.element(page.getByRole('menu')).toBeVisible();
    await userEvent.keyboard('e');
    await expect.element(item('Export')).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect.element(page.getByText('Chose export')).toBeVisible();
    await expect.element(button).toHaveFocus();
    await expect.element(button).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens on the last item with Up, closes with Escape and with Tab', async () => {
    await render(Menu);
    const button = page.getByRole('button', { name: 'Actions' });
    await userEvent.tab();
    await userEvent.keyboard('{ArrowUp}');
    await expect.element(page.getByRole('menuitem', { name: 'Rename' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    await expect.element(button).toHaveFocus();
    await expect.element(button).toHaveAttribute('aria-expanded', 'false');
    await userEvent.keyboard(' ');
    await expect.element(page.getByRole('menuitem', { name: 'Rescan' })).toHaveFocus();
    await userEvent.tab();
    await expect.element(button).toHaveAttribute('aria-expanded', 'false');
    await expect.element(page.getByRole('button', { name: 'After' })).toHaveFocus();
  });
});

describe('Toast', () => {
  it('announces information politely and removes it after its timeout', async () => {
    const screen = await render(Toasts, { timeoutMs: 150 });
    await page.getByRole('button', { name: 'Queue scan' }).click();
    const status = page.getByRole('status');
    await expect.element(status).toHaveTextContent('Scan queued');
    await expectAccessible(screen.container);
    await expect.poll(() => status.element().textContent.trim(), { timeout: 2_000 }).toBe('');
  });

  it('keeps errors until dismissed, in an alert region, and dismisses from the keyboard', async () => {
    const screen = await render(Toasts, { timeoutMs: 100 });
    await page.getByRole('button', { name: 'Fail' }).click();
    const alert = page.getByRole('alert');
    await expect.element(alert).toHaveTextContent('Could not reach the store');
    await expectAccessible(screen.container);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await expect.element(alert).toHaveTextContent('Could not reach the store');
    await userEvent.tab();
    await expect.element(page.getByRole('button', { name: 'Dismiss' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect.element(alert).toHaveTextContent('');
  });

  it('pauses the countdown while focus is on a toast', async () => {
    await render(Toasts, { timeoutMs: 150 });
    await page.getByRole('button', { name: 'Queue scan' }).click();
    page.getByRole('button', { name: 'Dismiss' }).element().focus();
    await new Promise((resolve) => setTimeout(resolve, 400));
    await expect.element(page.getByRole('status')).toHaveTextContent('Scan queued');
    page.getByRole('button', { name: 'Queue scan' }).element().focus();
    await expect
      .poll(() => page.getByRole('status').element().textContent.trim(), { timeout: 2_000 })
      .toBe('');
  });
});
