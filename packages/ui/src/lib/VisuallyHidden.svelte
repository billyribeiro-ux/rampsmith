<script lang="ts">
  // Text for assistive technology only, such as a label for an icon-only control.
  import type { Snippet } from 'svelte';

  let { children }: { children: Snippet } = $props();
</script>

<span class="rs-visually-hidden">{@render children()}</span>
