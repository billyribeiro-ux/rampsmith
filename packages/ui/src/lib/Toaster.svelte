<script lang="ts">
  // Where toasts appear. Both live regions exist before any message does, so screen readers
  // announce each new toast: information in a polite role="status" region, errors in an
  // assertive role="alert" region (ADR-026).
  import XIcon from 'phosphor-svelte/lib/XIcon';
  import type { Toasts } from './toasts.svelte.ts';

  interface Props {
    toaster: Toasts;
    /** Accessible name of each toast's dismiss button, e.g. "Dismiss". */
    dismissLabel: string;
  }

  let { toaster, dismissLabel }: Props = $props();

  const regions = $derived([
    { role: 'status', items: toaster.toasts.filter((t) => t.tone !== 'error') },
    { role: 'alert', items: toaster.toasts.filter((t) => t.tone === 'error') },
  ] as const);
</script>

<div
  class="rs-toaster"
  role="presentation"
  onmouseenter={() => {
    toaster.pause();
  }}
  onmouseleave={() => {
    toaster.resume();
  }}
  onfocusin={() => {
    toaster.pause();
  }}
  onfocusout={(event) => {
    const to = event.relatedTarget;
    if (!(to instanceof Node && event.currentTarget.contains(to))) toaster.resume();
  }}
>
  {#each regions as region (region.role)}
    <div role={region.role} class="rs-toast-region">
      {#each region.items as toast (toast.id)}
        <div class={['rs-toast', toast.tone]}>
          <p>{toast.message}</p>
          <button
            type="button"
            class="rs-toast-dismiss"
            aria-label={dismissLabel}
            onclick={() => {
              toaster.dismiss(toast.id);
            }}
          >
            <XIcon size={14} weight="bold" aria-hidden="true" />
          </button>
        </div>
      {/each}
    </div>
  {/each}
</div>

<style>
  .rs-toaster {
    position: fixed;
    right: var(--rs-space-4);
    bottom: var(--rs-space-4);
    z-index: 900;
    display: grid;
    gap: var(--rs-space-2);
    width: min(24rem, calc(100vw - 2rem));
  }
  .rs-toast-region {
    display: grid;
    gap: var(--rs-space-2);
  }
  .rs-toast {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--rs-space-2);
    padding: var(--rs-space-3) var(--rs-space-4);
    border: 1px solid var(--rs-color-border);
    border-left-width: 0.375rem;
    border-radius: var(--rs-radius);
    background: var(--rs-color-surface);
    box-shadow: var(--rs-shadow);
    color: var(--rs-color-text);
    animation: rs-toast-in var(--rs-duration) ease-out;
  }
  .rs-toast p {
    margin: 0;
    align-self: center;
  }
  .success {
    border-left-color: var(--rs-color-success);
  }
  .error {
    border-left-color: var(--rs-color-critical);
  }
  .info {
    border-left-color: var(--rs-color-accent);
  }
  .rs-toast-dismiss {
    display: inline-grid;
    flex: none;
    place-items: center;
    min-width: var(--rs-target);
    min-height: var(--rs-target);
    margin: calc(-1 * var(--rs-space-2));
    border: 1px solid transparent;
    border-radius: var(--rs-radius);
    background: transparent;
    color: var(--rs-color-text);
    cursor: pointer;
  }
  @keyframes rs-toast-in {
    from {
      opacity: 0;
      transform: translateY(0.5rem);
    }
  }
</style>
