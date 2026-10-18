<script lang="ts">
  import Toaster from '../../src/lib/Toaster.svelte';
  import { Toasts } from '../../src/lib/toasts.svelte.ts';

  let { timeoutMs = 200 }: { timeoutMs?: number } = $props();
  const toasts = new Toasts();
</script>

<button
  type="button"
  onclick={() => {
    toasts.show('Scan queued', { timeoutMs });
  }}>Queue scan</button
>
<button
  type="button"
  onclick={() => {
    toasts.show('Could not reach the store', { tone: 'error', timeoutMs });
  }}>Fail</button
>
<Toaster toaster={toasts} dismissLabel="Dismiss" />
