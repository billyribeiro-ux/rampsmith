<script lang="ts">
  // A draft document from docs/, shown under a banner that says what it is. These pages are
  // never indexed: the founder publishes them only after review.
  import { m } from '#lib/paraglide/messages.js';
  import Markdown from './Markdown.svelte';
  import type { DraftDocument } from './legal.ts';

  interface Props {
    document: DraftDocument;
    /** The banner's heading and sentence. */
    banner: string;
    bannerBody: string;
  }

  let { document: doc, banner, bannerBody }: Props = $props();
</script>

<svelte:head>
  <title>{doc.title} · {m.app_name()}</title>
  <meta name="robots" content="noindex, nofollow" />
</svelte:head>

<div class="site-callout warning" role="note">
  <p><strong>{banner}</strong></p>
  <p>{bannerBody}</p>
</div>

<article>
  <Markdown blocks={doc.blocks.slice(0, 1)} />
  {#if doc.sections.length > 0}
    <nav aria-label={m.site_legal_toc()}>
      <h2 class="toc-title">{m.site_legal_toc()}</h2>
      <ol>
        {#each doc.sections as section (section.id)}
          <li><a href={`#${section.id}`}>{section.title}</a></li>
        {/each}
      </ol>
    </nav>
  {/if}
  <Markdown blocks={doc.blocks.slice(1)} />
</article>

<style>
  .toc-title {
    font-size: 1.2rem;
    margin-top: var(--rs-space-6);
  }
  nav ol {
    columns: 2 18rem;
    padding-inline-start: var(--rs-space-6);
  }
  nav li {
    max-width: none;
    break-inside: avoid;
  }
  article :global(h2) {
    scroll-margin-top: var(--rs-space-4);
  }
</style>
