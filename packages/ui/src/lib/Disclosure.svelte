<script lang="ts">
  // APG Disclosure: a button that shows and hides the content after it.
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
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
      <path d="M5 3l6 5-6 5z" fill="currentColor" />
    </svg>
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
  .rs-disclosure-button svg {
    transition: transform var(--rs-duration) ease-out;
  }
  .rs-disclosure-button[aria-expanded='true'] svg {
    transform: rotate(90deg);
  }
  .rs-disclosure-content {
    padding: 0 0 var(--rs-space-2) var(--rs-space-6);
  }
</style>
