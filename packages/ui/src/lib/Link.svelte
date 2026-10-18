<script lang="ts">
  // A native <a href> (APG Link pattern). A link that opens a new tab says so in its name.
  import type { Snippet } from 'svelte';
  import type { HTMLAnchorAttributes } from 'svelte/elements';

  type Props = Omit<HTMLAnchorAttributes, 'href' | 'target' | 'children'> & {
    href: string;
    /** Opens in a new tab; the text is appended for screen readers, e.g. "(opens in a new tab)". */
    newTabLabel?: string;
    children: Snippet;
  };

  let { href, newTabLabel, children, ...rest }: Props = $props();
</script>

{#if newTabLabel === undefined}
  <a {...rest} {href} class="rs-link">{@render children()}</a>
{:else}
  <a {...rest} {href} class="rs-link" target="_blank" rel="noopener noreferrer"
    >{@render children()}<span class="rs-visually-hidden"> {newTabLabel}</span></a
  >
{/if}

<style>
  .rs-link {
    color: var(--rs-color-accent);
    text-decoration: underline;
    text-underline-offset: 0.15em;
  }
  .rs-link:hover {
    text-decoration-thickness: 2px;
  }
</style>
