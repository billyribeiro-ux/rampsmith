<script lang="ts">
  // Inline Markdown as elements. Links to other sites open in the same tab; the draft documents
  // cite sources, and a new tab is the reader's choice.
  import Self from './InlineNodes.svelte';
  import type { Inline } from './markdown.ts';

  let { nodes }: { nodes: readonly Inline[] } = $props();
</script>

{#each nodes as node, index (index)}
  {#if node.kind === 'text'}
    {node.text}
  {:else if node.kind === 'code'}
    <code>{node.text}</code>
  {:else if node.kind === 'strong'}
    <strong><Self nodes={node.children} /></strong>
  {:else if node.kind === 'em'}
    <em><Self nodes={node.children} /></em>
  {:else}
    <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- an address from a source document, not a route -->
    <a href={node.href}><Self nodes={node.children} /></a>
  {/if}
{/each}
