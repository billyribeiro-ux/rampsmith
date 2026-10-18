<script lang="ts">
  // APG Tabs with automatic activation: one tab stop for the tab list (roving tabindex);
  // Left and Right move and select, wrapping; Home and End jump to the ends.
  import type { Snippet } from 'svelte';

  interface Tab {
    id: string;
    label: string;
  }
  interface Props {
    tabs: readonly Tab[];
    /** The selected tab's id; the first tab when not given. */
    selected?: string;
    /** Accessible name of the tab list. */
    label: string;
    panel: Snippet<[string]>;
  }

  let { tabs, selected = $bindable(tabs[0]?.id ?? ''), label, panel }: Props = $props();

  const id = $props.id();
  const buttons: Record<string, HTMLButtonElement> = {};

  function select(index: number) {
    const tab = tabs.at(index % tabs.length);
    if (tab === undefined) return;
    selected = tab.id;
    buttons[tab.id]?.focus();
  }

  function keydown(event: KeyboardEvent) {
    const current = tabs.findIndex((t) => t.id === selected);
    const moves: Record<string, number> = {
      ArrowRight: current + 1,
      ArrowLeft: current - 1 + tabs.length,
      Home: 0,
      End: tabs.length - 1,
    };
    const next = moves[event.key];
    if (next === undefined) return;
    event.preventDefault();
    select(next);
  }
</script>

<div class="rs-tabs">
  <div role="tablist" aria-label={label} class="rs-tablist" tabindex="-1" onkeydown={keydown}>
    {#each tabs as tab (tab.id)}
      <button
        bind:this={buttons[tab.id]}
        type="button"
        role="tab"
        id={`${id}-tab-${tab.id}`}
        class="rs-tab"
        aria-selected={tab.id === selected}
        aria-controls={`${id}-panel-${tab.id}`}
        tabindex={tab.id === selected ? 0 : -1}
        onclick={() => {
          selected = tab.id;
        }}
      >
        {tab.label}
      </button>
    {/each}
  </div>
  {#each tabs as tab (tab.id)}
    <div
      role="tabpanel"
      id={`${id}-panel-${tab.id}`}
      class="rs-tabpanel"
      aria-labelledby={`${id}-tab-${tab.id}`}
      tabindex="0"
      hidden={tab.id !== selected}
    >
      {#if tab.id === selected}{@render panel(tab.id)}{/if}
    </div>
  {/each}
</div>

<style>
  .rs-tablist {
    display: flex;
    gap: var(--rs-space-1);
    border-bottom: 1px solid var(--rs-color-border);
  }
  .rs-tab {
    min-height: var(--rs-target);
    padding: var(--rs-space-2) var(--rs-space-4);
    border: 0;
    border-bottom: 3px solid transparent;
    background: transparent;
    color: var(--rs-color-text-muted);
    font: inherit;
    cursor: pointer;
  }
  .rs-tab[aria-selected='true'] {
    border-bottom-color: var(--rs-color-accent);
    color: var(--rs-color-accent);
    font-weight: 600;
  }
  .rs-tabpanel {
    padding: var(--rs-space-4) 0;
  }
</style>
