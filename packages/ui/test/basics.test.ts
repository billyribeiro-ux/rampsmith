import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import { describe, expect, it } from 'vitest';
import { expectAccessible } from './axe.ts';
import Buttons from './fixtures/Buttons.svelte';
import Links from './fixtures/Links.svelte';
import Skip from './fixtures/Skip.svelte';

describe('Button', () => {
  it('passes axe', async () => {
    const screen = await render(Buttons);
    await expectAccessible(screen.container);
  });

  it('is reached with Tab, shows the focus ring, and activates with Enter and Space', async () => {
    await render(Buttons);
    const save = page.getByRole('button', { name: 'Save' });
    await userEvent.tab();
    await expect.element(save).toHaveFocus();
    const style = getComputedStyle(save.element());
    expect(style.outlineStyle).toBe('solid');
    expect(style.outlineWidth).toBe('3px');
    expect(style.outlineColor).toBe('rgb(11, 87, 208)');
    await userEvent.keyboard('{Enter}');
    await expect.element(page.getByText('Pressed 1 times')).toBeVisible();
    await userEvent.keyboard(' ');
    await expect.element(page.getByText('Pressed 2 times')).toBeVisible();
  });

  it('defaults to type="button" and leaves disabled buttons out of the tab order', async () => {
    await render(Buttons);
    expect(page.getByRole('button', { name: 'Save' }).element().getAttribute('type')).toBe(
      'button',
    );
    for (const name of ['Save', 'Cancel', 'Delete']) {
      await userEvent.tab();
      await expect.element(page.getByRole('button', { name })).toHaveFocus();
    }
    await userEvent.tab();
    await expect.element(page.getByRole('button', { name: 'Unavailable' })).not.toHaveFocus();
  });

  it('meets the 24 px target size with room to spare', async () => {
    await render(Buttons);
    const box = page.getByRole('button', { name: 'Delete' }).element().getBoundingClientRect();
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(44);
  });
});

describe('Link and VisuallyHidden', () => {
  it('pass axe', async () => {
    const screen = await render(Links);
    await expectAccessible(screen.container);
  });

  it('follows a link with Enter', async () => {
    await render(Links);
    await userEvent.tab();
    await expect.element(page.getByRole('link', { name: 'Read the report' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(location.hash).toBe('#report');
  });

  it('says when a link opens a new tab, and opens it safely', async () => {
    await render(Links);
    const external = page.getByRole('link', { name: 'WCAG 2.2 text (opens in a new tab)' });
    await expect.element(external).toHaveAttribute('target', '_blank');
    await expect.element(external).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('names an icon-only control without showing the text', async () => {
    await render(Links);
    const search = page.getByRole('button', { name: 'Search' });
    await expect.element(search).toBeInTheDocument();
    const hidden = search.element().querySelector('.rs-visually-hidden');
    const box = hidden?.getBoundingClientRect();
    expect(box?.width).toBeLessThanOrEqual(1);
    expect(box?.height).toBeLessThanOrEqual(1);
  });
});

describe('SkipLink', () => {
  it('passes axe', async () => {
    const screen = await render(Skip);
    await expectAccessible(screen.container);
  });

  it('is the first Tab stop, becomes visible, and moves focus to the main content', async () => {
    await render(Skip);
    const skip = page.getByRole('link', { name: 'Skip to content' });
    expect(skip.element().getBoundingClientRect().bottom).toBeLessThanOrEqual(0);
    await userEvent.tab();
    await expect.element(skip).toHaveFocus();
    await expect.poll(() => skip.element().getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
    await userEvent.keyboard('{Enter}');
    await expect.element(page.getByRole('main')).toHaveFocus();
  });
});
