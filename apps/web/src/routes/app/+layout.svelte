<script lang="ts">
  // The embedded App Home (PLAN §14). App Bridge must be in the <head> of every document
  // and is only published as Shopify's evergreen script; Polaris is pinned to 1.1 (ADR-023).
  // The shell carries no tenant data: once App Bridge is up, the session starts with a session
  // token and every screen loads its own data (ADR-022, ADR-091).
  import { onMount, type Snippet } from 'svelte';
  import '#lib/app/app-home.css';
  import { page } from '$app/state';
  import { SHOPIFY_API_KEY } from '$app/env/public';
  import { press } from '#lib/app/dom.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { createHttpApi } from '#lib/app/api.ts';
  import { AppContext, setAppContext } from '#lib/app/context.svelte.ts';
  import { appHref, carriedQuery } from '#lib/app/nav.ts';
  import type { SessionTokenSource } from '#lib/shopify/session-fetch.ts';

  let { children }: { children: Snippet } = $props();

  // App Bridge appears as a global once its script runs; read at call time, never at import.
  const bridge: SessionTokenSource = {
    idToken: () => {
      const shopify = (globalThis as { shopify?: SessionTokenSource }).shopify;
      return shopify === undefined
        ? Promise.reject(new Error('App Bridge is not loaded'))
        : shopify.idToken();
    },
  };
  const app = new AppContext(createHttpApi(bridge));
  setAppContext(app);

  let session = $state<'connecting' | 'ready' | 'failed'>('connecting');

  $effect(() => {
    app.carry = carriedQuery(page.url.searchParams);
  });

  async function connect(): Promise<void> {
    session = 'connecting';
    try {
      const started = await app.api.startSession();
      app.shop = started.shop;
      session = 'ready';
    } catch {
      session = 'failed';
    }
  }

  onMount(() => {
    void connect();
  });

  const nav = $derived([
    { path: '/app', label: m.app_nav_overview(), home: true },
    { path: '/app/findings', label: m.app_nav_findings(), home: false },
    { path: '/app/fixes', label: m.app_nav_fixes(), home: false },
    { path: '/app/regressions', label: m.app_nav_regressions(), home: false },
    { path: '/app/log', label: m.app_nav_log(), home: false },
    { path: '/app/statement', label: m.app_nav_statement(), home: false },
    { path: '/app/agency', label: m.app_nav_agency(), home: false },
    { path: '/app/settings', label: m.app_nav_settings(), home: false },
  ]);
</script>

<svelte:head>
  <meta name="shopify-api-key" content={SHOPIFY_API_KEY} />
  <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
  <script src="https://cdn.shopify.com/shopifycloud/polaris-1.1.js"></script>
  {#if session !== 'ready'}
    <title>{m.embedded_title()}</title>
  {/if}
</svelte:head>

<s-app-nav>
  {#each nav as item (item.path)}
    <s-link href={appHref(item.path, app.carry)} rel={item.home ? 'home' : undefined}>
      {item.label}
    </s-link>
  {/each}
</s-app-nav>

<!-- One polite live region for results (approved, undone, saved); see AppContext.announce. -->
<div class="live" role="status" aria-live="polite" aria-atomic="true">{app.announcement}</div>

{#if session === 'ready'}
  <!-- Load the code of every link on screen ahead of the click, so a move between screens does
       not wait for a download before it paints (INP, ADR-300). -->
  <div style="display: contents" data-sveltekit-preload-code="viewport">
    {@render children()}
  </div>
{:else}
  <s-page heading={m.embedded_heading()}>
    <s-section>
      {#if session === 'connecting'}
        <div role="status" aria-live="polite">
          <s-paragraph>{m.embedded_connecting()}</s-paragraph>
        </div>
      {:else}
        <s-banner tone="critical">
          <s-paragraph>{m.embedded_failed()}</s-paragraph>
          <s-button slot="secondary-actions" {@attach press(() => void connect())}>
            {m.app_retry()}
          </s-button>
        </s-banner>
      {/if}
    </s-section>
  </s-page>
{/if}

<style>
  .live {
    position: absolute;
    inline-size: 1px;
    block-size: 1px;
    margin: -1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
