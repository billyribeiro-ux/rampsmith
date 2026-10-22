<script lang="ts">
  import type { Snippet } from 'svelte';
  import SiteShell from '#lib/site/SiteShell.svelte';

  let { children }: { children: Snippet } = $props();
</script>

<SiteShell>
  {@render children()}
</SiteShell>
