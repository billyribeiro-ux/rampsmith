<script lang="ts">
  // The frame of every standalone page: a skip link, the brand, and the main landmark.
  import type { Snippet } from 'svelte';
  import { SkipLink } from '@rampsmith/ui';
  import { m } from '#lib/paraglide/messages.js';

  let { children }: { children: Snippet } = $props();
</script>

<SkipLink>{m.skip_to_content()}</SkipLink>
<header>
  <p class="brand">{m.app_name()}</p>
</header>
<main id="main" tabindex="-1">
  {@render children()}
</main>

<style>
  header,
  main {
    max-width: 48rem;
    margin: 0 auto;
    padding: var(--rs-space-4) var(--rs-space-6);
  }
  .brand {
    font-weight: 700;
    color: var(--rs-color-accent);
  }
  main :global(a) {
    color: var(--rs-color-accent);
  }
</style>
