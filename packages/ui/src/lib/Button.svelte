<script lang="ts">
  // A native <button> (APG Button pattern): Enter and Space activate it without extra code.
  import type { Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';

  type Props = Omit<HTMLButtonAttributes, 'type' | 'children'> & {
    variant?: 'primary' | 'secondary' | 'critical';
    type?: 'button' | 'submit' | 'reset';
    children: Snippet;
  };

  let { variant = 'secondary', type = 'button', children, ...rest }: Props = $props();
</script>

<button {...rest} {type} class={['rs-button', variant]}>
  {@render children()}
</button>

<style>
  .rs-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--rs-space-2);
    min-height: var(--rs-target);
    min-width: var(--rs-target);
    padding: var(--rs-space-2) var(--rs-space-4);
    border: 1px solid var(--rs-color-border);
    border-radius: var(--rs-radius);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
    transition: background-color var(--rs-duration) ease-out;
  }
  .primary {
    background: var(--rs-color-accent);
    border-color: var(--rs-color-accent);
    color: var(--rs-color-on-accent);
  }
  .primary:hover:not(:disabled) {
    background: var(--rs-color-accent-hover);
  }
  .secondary {
    background: var(--rs-color-surface);
    color: var(--rs-color-accent);
  }
  .secondary:hover:not(:disabled) {
    background: var(--rs-color-surface-raised);
  }
  .critical {
    background: var(--rs-color-critical);
    border-color: var(--rs-color-critical);
    color: var(--rs-color-on-critical);
  }
  .rs-button:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }
</style>
