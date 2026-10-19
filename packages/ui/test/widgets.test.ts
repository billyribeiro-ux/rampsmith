import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import { describe, expect, it } from 'vitest';
import { expectAccessible } from './axe.ts';
import ComboboxDemo from './fixtures/ComboboxDemo.svelte';
import DisclosureDemo from './fixtures/DisclosureDemo.svelte';
import Table from './fixtures/Table.svelte';
import TabsDemo from './fixtures/TabsDemo.svelte';

describe('Tabs', () => {
  it('passes axe', async () => {
    const screen = await render(TabsDemo);
    await expectAccessible(screen.container);
  });

  it('is one Tab stop; arrows, Home and End select tabs, wrapping', async () => {
    await render(TabsDemo);
    const tab = (name: string) => page.getByRole('tab', { name });
    await userEvent.tab();
    await expect.element(tab('Open')).toHaveFocus();
    await expect.element(tab('Open')).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{ArrowRight}');
    await expect.element(tab('Fixed')).toHaveFocus();
    await expect.element(tab('Fixed')).toHaveAttribute('aria-selected', 'true');
    await expect
      .element(page.getByRole('tabpanel', { name: 'Fixed' }))
      .toHaveTextContent('fixed findings');
    await userEvent.keyboard('{End}');
    await expect.element(tab('Ignored')).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}');
    await expect.element(tab('Open')).toHaveFocus();
    await userEvent.keyboard('{ArrowLeft}');
    await expect.element(tab('Ignored')).toHaveFocus();
    await userEvent.keyboard('{Home}');
    await expect.element(tab('Open')).toHaveFocus();
    await userEvent.tab();
    await expect.element(page.getByRole('tabpanel', { name: 'Open' })).toHaveFocus();
  });
});

describe('Disclosure', () => {
  it('passes axe open and closed', async () => {
    const screen = await render(DisclosureDemo);
    await expectAccessible(screen.container);
    await page.getByRole('button', { name: 'How fixes are verified' }).click();
    await expectAccessible(screen.container);
  });

  it('toggles with Enter and Space and reports its state', async () => {
    await render(DisclosureDemo);
    const button = page.getByRole('button', { name: 'How fixes are verified' });
    const content = () =>
      document.getElementById(button.element().getAttribute('aria-controls') ?? '');
    await userEvent.tab();
    await expect.element(button).toHaveFocus();
    await expect.element(button).toHaveAttribute('aria-expanded', 'false');
    expect(content()?.checkVisibility()).toBe(false);
    await userEvent.keyboard('{Enter}');
    await expect.element(button).toHaveAttribute('aria-expanded', 'true');
    expect(content()?.checkVisibility()).toBe(true);
    await expect
      .element(page.getByText('Every fix is re-scanned before it is reported as fixed.'))
      .toBeVisible();
    await userEvent.keyboard(' ');
    await expect.element(button).toHaveAttribute('aria-expanded', 'false');
    expect(content()?.checkVisibility()).toBe(false);
  });
});

describe('Combobox', () => {
  it('passes axe closed and open', async () => {
    const screen = await render(ComboboxDemo);
    await expectAccessible(screen.container);
    await page.getByRole('combobox', { name: 'Theme' }).fill('e');
    await expect.element(page.getByRole('listbox')).toBeVisible();
    await expectAccessible(screen.container);
  });

  it('filters as you type, moves with arrows through aria-activedescendant, and chooses with Enter', async () => {
    await render(ComboboxDemo);
    const input = page.getByRole('combobox', { name: 'Theme' });
    await userEvent.tab();
    await expect.element(input).toHaveFocus();
    await userEvent.keyboard('e');
    await expect.element(input).toHaveAttribute('aria-expanded', 'true');
    const options = page.getByRole('option');
    await expect.element(options.nth(0)).toHaveTextContent('Refresh');
    expect(options.elements().map((o) => o.textContent.trim())).toEqual(['Refresh', 'Sense']);
    await expect.element(page.getByRole('status')).toHaveTextContent('2 results');
    await userEvent.keyboard('{ArrowDown}');
    const refresh = page.getByRole('option', { name: 'Refresh' });
    await expect.element(refresh).toHaveAttribute('aria-selected', 'true');
    await expect.element(input).toHaveAttribute('aria-activedescendant', refresh.element().id);
    await userEvent.keyboard('{ArrowDown}');
    await expect
      .element(page.getByRole('option', { name: 'Sense' }))
      .toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{ArrowDown}');
    await expect.element(refresh).toHaveAttribute('aria-selected', 'true');
    await expect.element(input).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect.element(input).toHaveValue('Refresh');
    await expect.element(input).toHaveAttribute('aria-expanded', 'false');
    await expect.element(page.getByText('Chosen: refresh')).toBeVisible();
  });

  it('closes with Escape, then clears with a second Escape, and says when nothing matches', async () => {
    await render(ComboboxDemo);
    const input = page.getByRole('combobox', { name: 'Theme' });
    await userEvent.tab();
    await userEvent.keyboard('{ArrowDown}');
    await expect.element(input).toHaveAttribute('aria-expanded', 'true');
    await userEvent.keyboard('{Escape}');
    await expect.element(input).toHaveAttribute('aria-expanded', 'false');
    await userEvent.keyboard('zzz');
    await expect.element(input).toHaveAttribute('aria-expanded', 'false');
    await expect.element(page.getByRole('status')).toHaveTextContent('No matches');
    await userEvent.keyboard('{Escape}');
    await userEvent.keyboard('{Escape}');
    await expect.element(input).toHaveValue('');
  });

  it('chooses with the pointer', async () => {
    await render(ComboboxDemo);
    await page.getByRole('combobox', { name: 'Theme' }).fill('cr');
    await page.getByRole('option', { name: 'Craft' }).click();
    await expect.element(page.getByText('Chosen: craft')).toBeVisible();
  });
});

describe('DataTable', () => {
  it('passes axe unsorted and sorted', async () => {
    const screen = await render(Table);
    await expectAccessible(screen.container);
    await page.getByRole('button', { name: 'Rule' }).click();
    await expectAccessible(screen.container);
  });

  it('sorts from the keyboard and marks only the sorted column with aria-sort', async () => {
    await render(Table);
    const header = (name: string) => page.getByRole('columnheader', { name });
    const firstColumn = () =>
      page
        .getByRole('row')
        .elements()
        .slice(1)
        .map((r) => r.querySelector('td')?.textContent.trim());
    await expect.element(page.getByRole('table', { name: 'Findings by rule' })).toBeVisible();
    expect(header('Rule').element().hasAttribute('aria-sort')).toBe(false);
    await userEvent.tab();
    await expect.element(page.getByRole('button', { name: 'Rule' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect.element(header('Rule')).toHaveAttribute('aria-sort', 'ascending');
    expect(firstColumn()).toEqual(['color-contrast', 'image-alt', 'link-name']);
    await userEvent.keyboard(' ');
    await expect.element(header('Rule')).toHaveAttribute('aria-sort', 'descending');
    expect(firstColumn()).toEqual(['link-name', 'image-alt', 'color-contrast']);
    await userEvent.tab();
    await userEvent.keyboard('{Enter}');
    await expect.element(header('Elements')).toHaveAttribute('aria-sort', 'ascending');
    expect(header('Rule').element().hasAttribute('aria-sort')).toBe(false);
    expect(firstColumn()).toEqual(['link-name', 'image-alt', 'color-contrast']);
  });
});
