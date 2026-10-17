<script lang="ts">
  // The frame of every standalone page: a skip link, the brand, and the main landmark.
  import type { Snippet } from 'svelte';
  import { m } from '#lib/paraglide/messages.js';

  let { children }: { children: Snippet } = $props();
</script>

<a class="skip" href="#main">{m.skip_to_content()}</a>
<header>
  <p class="brand">{m.app_name()}</p>
</header>
<main id="main" tabindex="-1">
  {@render children()}
</main>

<style>
  .skip {
    position: absolute;
    left: -10000px;
  }
  .skip:focus {
    position: static;
  }
  header,
  main {
    max-width: 48rem;
    margin: 0 auto;
    padding: 1rem 1.5rem;
  }
  .brand {
    font-weight: 700;
    color: var(--rs-color-accent);
  }
  main :global(a) {
    color: var(--rs-color-accent);
  }
</style>
