<script lang="ts">
  // The embedded App Home (PLAN §14). App Bridge must be in the <head> of every document
  // and is only published as Shopify's evergreen script; Polaris is pinned to 1.1 (ADR-023).
  import type { Snippet } from 'svelte';
  import { SHOPIFY_API_KEY } from '$app/env/public';
  import { m } from '#lib/paraglide/messages.js';

  let { children }: { children: Snippet } = $props();
</script>

<svelte:head>
  <meta name="shopify-api-key" content={SHOPIFY_API_KEY} />
  <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
  <script src="https://cdn.shopify.com/shopifycloud/polaris-1.1.js"></script>
</svelte:head>

<s-app-nav>
  <s-link href="/app" rel="home">{m.embedded_heading()}</s-link>
</s-app-nav>

{@render children()}
