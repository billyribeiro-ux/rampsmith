<script lang="ts">
  import { m } from '#lib/paraglide/messages.js';
  import { getAppContext } from '../context.svelte.ts';

  let { url, product }: { url: string | null; product: string } = $props();
  const app = getAppContext();

  let source = $state<string | undefined>(undefined);
  let failed = $state(false);

  $effect(() => {
    const wanted = url;
    source = undefined;
    failed = false;
    if (wanted === null) return;
    let live = true;
    app.api.productImage(wanted).then(
      (dataUrl) => {
        if (live) source = dataUrl;
      },
      () => {
        if (live) failed = true;
      },
    );
    return () => {
      live = false;
    };
  });
</script>

<div class="frame">
  {#if source !== undefined}
    <img src={source} alt={m.app_image_alt({ product })} width="160" height="160" />
  {:else}
    <span class="placeholder"
      >{failed || url === null ? m.app_image_unavailable() : m.app_loading()}</span
    >
  {/if}
</div>

<style>
  .frame {
    inline-size: 10rem;
    block-size: 10rem;
    display: grid;
    place-items: center;
    border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
    border-radius: 0.5rem;
    overflow: hidden;
    flex: none;
  }
  img {
    inline-size: 100%;
    block-size: 100%;
    object-fit: contain;
  }
  .placeholder {
    padding: 0.5rem;
    text-align: center;
    font-size: 0.875rem;
  }
</style>
