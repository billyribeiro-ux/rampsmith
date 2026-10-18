<script lang="ts">
  // The first focusable element on a page (WCAG 2.4.1): hidden until focused, it moves focus
  // to the main content.
  import type { Snippet } from 'svelte';

  let { target = 'main', children }: { target?: string; children: Snippet } = $props();

  function skip(event: MouseEvent) {
    const destination = document.getElementById(target);
    if (destination === null) return;
    event.preventDefault();
    if (!destination.hasAttribute('tabindex')) destination.setAttribute('tabindex', '-1');
    destination.focus();
  }
</script>

<a class="rs-skip-link" href={`#${target}`} onclick={skip}>{@render children()}</a>

<style>
  .rs-skip-link {
    position: absolute;
    top: var(--rs-space-2);
    left: var(--rs-space-2);
    z-index: 1000;
    padding: var(--rs-space-2) var(--rs-space-4);
    background: var(--rs-color-accent);
    color: var(--rs-color-on-accent);
    border-radius: var(--rs-radius);
    transform: translateY(-200%);
    transition: transform var(--rs-duration) ease-out;
  }
  .rs-skip-link:focus {
    transform: none;
  }
</style>
