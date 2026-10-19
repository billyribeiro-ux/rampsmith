<script lang="ts">
  import { onMount } from 'svelte';
  import { m } from '#lib/paraglide/messages.js';
  import { sessionFetch, type SessionTokenSource } from '#lib/shopify/session-fetch.ts';

  type Status =
    | { state: 'connecting' }
    | { state: 'ready'; shop: string; installed: boolean }
    | { state: 'failed' };

  let status: Status = $state({ state: 'connecting' });

  function isSession(value: unknown): value is { shop: string; installed: boolean } {
    return (
      typeof value === 'object' &&
      value !== null &&
      'shop' in value &&
      typeof value.shop === 'string' &&
      'installed' in value &&
      typeof value.installed === 'boolean'
    );
  }

  onMount(async () => {
    const bridge = (globalThis as { shopify?: SessionTokenSource }).shopify;
    if (bridge === undefined) {
      status = { state: 'failed' };
      return;
    }
    try {
      const response = await sessionFetch(bridge, fetch, '/app/api/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      const body: unknown = response.ok ? await response.json() : undefined;
      status = isSession(body)
        ? { state: 'ready', shop: body.shop, installed: body.installed }
        : { state: 'failed' };
    } catch {
      status = { state: 'failed' };
    }
  });
</script>

<svelte:head>
  <title>{m.embedded_title()}</title>
</svelte:head>

<s-page heading={m.embedded_heading()}>
  <s-section>
    <div role="status" aria-live="polite">
      {#if status.state === 'connecting'}
        <s-paragraph>{m.embedded_connecting()}</s-paragraph>
      {:else if status.state === 'ready'}
        <s-paragraph>
          {status.installed
            ? m.embedded_installed({ shop: status.shop })
            : m.embedded_connected({ shop: status.shop })}
        </s-paragraph>
      {/if}
    </div>
    {#if status.state === 'failed'}
      <s-banner tone="critical">{m.embedded_failed()}</s-banner>
    {/if}
  </s-section>
  <s-section heading={m.embedded_next_title()}>
    <s-paragraph>{m.embedded_next_body()}</s-paragraph>
  </s-section>
</s-page>
