<script lang="ts">
  // APG Menu Button: Enter, Space or Down opens the menu on its first item, Up on its last.
  // In the menu, Up and Down move (wrapping), Home and End jump, a letter moves to the next
  // item starting with it, Enter or Space chooses, Escape closes and returns focus, and Tab
  // closes and moves on.
  import { tick } from 'svelte';

  interface Item {
    id: string;
    label: string;
    disabled?: boolean;
  }
  interface Props {
    label: string;
    items: readonly Item[];
    onselect: (id: string) => void;
  }

  let { label, items, onselect }: Props = $props();

  const id = $props.id();
  let open = $state(false);
  let active = $state(0);
  let button: HTMLButtonElement | undefined = $state();
  const entries: HTMLElement[] = $state([]);

  async function show(index: number) {
    open = true;
    active = (index + items.length) % items.length;
    await tick();
    entries[active]?.focus();
  }

  function hide(returnFocus: boolean) {
    open = false;
    if (returnFocus) button?.focus();
  }

  function choose(item: Item) {
    if (item.disabled === true) return;
    hide(true);
    onselect(item.id);
  }

  function buttonKeydown(event: KeyboardEvent) {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      void show(0);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      void show(items.length - 1);
    }
  }

  function move(index: number) {
    active = (index + items.length) % items.length;
    entries[active]?.focus();
  }

  function menuKeydown(event: KeyboardEvent) {
    const item = items[active];
    switch (event.key) {
      case 'ArrowDown':
        move(active + 1);
        break;
      case 'ArrowUp':
        move(active - 1);
        break;
      case 'Home':
        move(0);
        break;
      case 'End':
        move(items.length - 1);
        break;
      case 'Escape':
        hide(true);
        break;
      case 'Tab':
        hide(false);
        return;
      case 'Enter':
      case ' ':
        if (item !== undefined) choose(item);
        break;
      default: {
        if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;
        const letter = event.key.toLowerCase();
        const order = items.map((_, i) => (active + 1 + i) % items.length);
        const next = order.find((i) => items[i]?.label.toLowerCase().startsWith(letter));
        if (next !== undefined) move(next);
      }
    }
    event.preventDefault();
  }

  function menuClick(event: MouseEvent) {
    const entry = event.target instanceof Element ? event.target.closest('[data-index]') : null;
    const item = items[Number(entry?.getAttribute('data-index'))];
    if (item !== undefined) choose(item);
  }

  function focusout(event: FocusEvent) {
    const to = event.relatedTarget;
    if (
      open &&
      !(
        to instanceof Node &&
        event.currentTarget instanceof Node &&
        event.currentTarget.contains(to)
      )
    ) {
      open = false;
    }
  }
</script>

<div class="rs-menu-button" onfocusout={focusout}>
  <button
    bind:this={button}
    type="button"
    id={`${id}-button`}
    class="rs-menu-trigger"
    aria-haspopup="menu"
    aria-expanded={open}
    aria-controls={`${id}-menu`}
    onclick={() => {
      if (open) hide(false);
      else void show(0);
    }}
    onkeydown={buttonKeydown}
  >
    {label}
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
      <path d="M3 6l5 5 5-5z" fill="currentColor" />
    </svg>
  </button>
  <ul
    role="menu"
    id={`${id}-menu`}
    class="rs-menu"
    aria-labelledby={`${id}-button`}
    tabindex="-1"
    hidden={!open}
    onkeydown={menuKeydown}
    onclick={menuClick}
  >
    {#each items as item, i (item.id)}
      <li
        bind:this={entries[i]}
        role="menuitem"
        class="rs-menu-item"
        tabindex="-1"
        aria-disabled={item.disabled === true ? 'true' : undefined}
        data-index={i}
      >
        {item.label}
      </li>
    {/each}
  </ul>
</div>

<style>
  .rs-menu-button {
    position: relative;
    display: inline-block;
  }
  .rs-menu-trigger {
    display: inline-flex;
    align-items: center;
    gap: var(--rs-space-2);
    min-height: var(--rs-target);
    padding: var(--rs-space-2) var(--rs-space-4);
    border: 1px solid var(--rs-color-border);
    border-radius: var(--rs-radius);
    background: var(--rs-color-surface);
    color: var(--rs-color-accent);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }
  .rs-menu {
    position: absolute;
    z-index: 10;
    min-width: 100%;
    margin: var(--rs-space-1) 0 0;
    padding: var(--rs-space-1) 0;
    list-style: none;
    border: 1px solid var(--rs-color-border);
    border-radius: var(--rs-radius);
    background: var(--rs-color-surface);
    box-shadow: var(--rs-shadow);
  }
  .rs-menu-item {
    display: flex;
    align-items: center;
    min-height: var(--rs-target);
    padding: 0 var(--rs-space-4);
    color: var(--rs-color-text);
    cursor: pointer;
    white-space: nowrap;
  }
  .rs-menu-item:hover,
  .rs-menu-item:focus {
    background: var(--rs-color-surface-raised);
  }
  .rs-menu-item[aria-disabled='true'] {
    color: var(--rs-color-text-muted);
    cursor: not-allowed;
  }
</style>
