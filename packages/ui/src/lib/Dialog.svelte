<script lang="ts">
  // A modal dialog on native <dialog> (APG Dialog pattern): showModal() makes the rest of the
  // page inert and Escape closes it. Focus moves to the first focusable element inside (or to
  // the dialog) on open, and back to whatever had it before on close.
  import type { Snippet } from 'svelte';

  interface Props {
    open?: boolean;
    title: string;
    /** Accessible name of the close button, e.g. "Close". */
    closeLabel: string;
    children: Snippet;
    actions?: Snippet;
    onclose?: () => void;
  }

  let { open = $bindable(false), title, closeLabel, children, actions, onclose }: Props = $props();

  const id = $props.id();
  let dialog: HTMLDialogElement | undefined = $state();
  let returnTo: HTMLElement | null = null;

  const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  $effect(() => {
    if (dialog === undefined) return;
    if (open && !dialog.open) {
      returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
      // Content first, then the close button, then the dialog itself.
      const body = dialog.querySelector('.rs-dialog-body');
      const first =
        dialog.querySelector<HTMLElement>('[autofocus]') ??
        body?.querySelector<HTMLElement>(FOCUSABLE) ??
        dialog.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? dialog).focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  });

  function closed() {
    open = false;
    returnTo?.focus();
    returnTo = null;
    onclose?.();
  }
</script>

<dialog
  bind:this={dialog}
  class="rs-dialog"
  aria-labelledby={`${id}-title`}
  tabindex="-1"
  onclose={closed}
>
  <header class="rs-dialog-header">
    <h2 id={`${id}-title`}>{title}</h2>
    <button
      type="button"
      class="rs-dialog-close"
      aria-label={closeLabel}
      onclick={() => {
        open = false;
      }}
    >
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
        <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" stroke-width="2" fill="none" />
      </svg>
    </button>
  </header>
  <div class="rs-dialog-body">
    {@render children()}
  </div>
  {#if actions}
    <footer class="rs-dialog-actions">{@render actions()}</footer>
  {/if}
</dialog>

<style>
  .rs-dialog {
    width: min(32rem, calc(100vw - 2rem));
    padding: 0;
    border: 1px solid var(--rs-color-border);
    border-radius: var(--rs-radius);
    box-shadow: var(--rs-shadow);
    color: var(--rs-color-text);
    background: var(--rs-color-surface);
  }
  .rs-dialog::backdrop {
    background: rgb(0 0 0 / 0.45);
  }
  .rs-dialog-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--rs-space-4);
    padding: var(--rs-space-4) var(--rs-space-6) 0;
  }
  .rs-dialog-header h2 {
    margin: 0;
    font-size: 1.25rem;
  }
  .rs-dialog-close {
    display: inline-grid;
    place-items: center;
    min-width: var(--rs-target);
    min-height: var(--rs-target);
    border: 1px solid transparent;
    border-radius: var(--rs-radius);
    background: transparent;
    color: var(--rs-color-text);
    cursor: pointer;
  }
  .rs-dialog-close:hover {
    border-color: var(--rs-color-border);
  }
  .rs-dialog-body {
    padding: var(--rs-space-4) var(--rs-space-6);
  }
  .rs-dialog-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--rs-space-2);
    padding: 0 var(--rs-space-6) var(--rs-space-4);
  }
</style>
