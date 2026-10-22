<script lang="ts">
  // Renders parsed Markdown as elements. There is no {@html}: raw HTML in a source file shows
  // as text. Headings keep their level; the page's first heading is its h1.
  import InlineNodes from './InlineNodes.svelte';
  import { plain, type Block } from './markdown.ts';

  let { blocks }: { blocks: readonly Block[] } = $props();
</script>

{#each blocks as block, index (index)}
  {#if block.kind === 'heading'}
    {#if block.level === 1}
      <h1 id={block.id}><InlineNodes nodes={block.children} /></h1>
    {:else if block.level === 2}
      <h2 id={block.id}><InlineNodes nodes={block.children} /></h2>
    {:else if block.level === 3}
      <h3 id={block.id}><InlineNodes nodes={block.children} /></h3>
    {:else}
      <h4 id={block.id}><InlineNodes nodes={block.children} /></h4>
    {/if}
  {:else if block.kind === 'paragraph'}
    <p><InlineNodes nodes={block.children} /></p>
  {:else if block.kind === 'list'}
    {#if block.ordered}
      <ol>
        {#each block.items as item, i (i)}
          <li><InlineNodes nodes={item} /></li>
        {/each}
      </ol>
    {:else}
      <ul>
        {#each block.items as item, i (i)}
          <li><InlineNodes nodes={item} /></li>
        {/each}
      </ul>
    {/if}
  {:else if block.kind === 'table'}
    <!-- A wide table scrolls sideways inside its own region, which the keyboard can reach. -->
    <!-- A scrollable region must be reachable by keyboard (WCAG 2.1.1). -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div
      class="scroll"
      role="region"
      aria-label={block.header.map((cell) => plain(cell)).join(', ')}
      tabindex="0"
    >
      <table>
        <thead>
          <tr>
            {#each block.header as cell, i (i)}
              <th scope="col"><InlineNodes nodes={cell} /></th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each block.rows as row, r (r)}
            <tr>
              {#each row as cell, c (c)}
                <td><InlineNodes nodes={cell} /></td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {:else}
    <hr />
  {/if}
{/each}

<style>
  .scroll {
    overflow-x: auto;
    margin-block: var(--rs-space-4);
  }
  .scroll table {
    min-width: 36rem;
  }
  ol,
  ul {
    padding-inline-start: var(--rs-space-6);
  }
  hr {
    border: 0;
    border-top: 1px solid var(--rs-color-border);
    margin-block: var(--rs-space-6);
  }
</style>
