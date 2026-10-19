<script lang="ts">
  // APG Disclosure: a button that shows and hides the content after it.
  import CaretRightIcon from 'phosphor-svelte/lib/CaretRightIcon';
  import type { Snippet } from 'svelte';

  interface Props {
    summary: string;
    open?: boolean;
    children: Snippet;
  }

  let { summary, open = $bindable(false), children }: Props = $props();

  const id = $props.id();
</script>

<div class="rs-disclosure">
  <button
    type="button"
    class="rs-disclosure-button"
    aria-expanded={open}
    aria-controls={`${id}-content`}
    onclick={() => {
      open = !open;
    }}
  >
    <CaretRightIcon class="rs-disclosure-caret" size={12} weight="bold" aria-hidden="true" />
    {summary}
  </button>
  <div id={`${id}-content`} class="rs-disclosure-content" hidden={!open}>
    {@render children()}
  </div>
</div>

<style>
  .rs-disclosure-button {
    display: inline-flex;
    align-items: center;
    gap: var(--rs-space-2);
    min-height: var(--rs-target);
    padding: var(--rs-space-2) 0;
    border: 0;
    background: transparent;
    color: var(--rs-color-accent);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }
  /* The icon belongs to another component, so its class is not scoped to this one. */
  .rs-disclosure-button :global(.rs-disclosure-caret) {
    transition: transform var(--rs-duration) ease-out;
  }
  .rs-disclosure-button[aria-expanded='true'] :global(.rs-disclosure-caret) {
    transform: rotate(90deg);
  }
  .rs-disclosure-content {
    padding: 0 0 var(--rs-space-2) var(--rs-space-6);
  }
</style>
