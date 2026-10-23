<script lang="ts">
  // Where GitHub's installation page ends (ADR-291). The App Home tab the person came from is
  // still open; this page only says how it went and sends them back to it.
  import { m } from '#lib/paraglide/messages.js';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const text = $derived(
    {
      connected: {
        title: m.app_codefix_result_connected_title(),
        body: m.app_codefix_result_connected_body(),
      },
      expired: {
        title: m.app_codefix_result_expired_title(),
        body: m.app_codefix_result_expired_body(),
      },
      refused: {
        title: m.app_codefix_result_refused_title(),
        body: m.app_codefix_result_refused_body(),
      },
      unavailable: {
        title: m.app_codefix_result_unavailable_title(),
        body: m.app_codefix_result_unavailable_body(),
      },
    }[data.result],
  );
</script>

<svelte:head>
  <title>{text.title} · {m.app_name()}</title>
  <meta name="robots" content="noindex, nofollow" />
  <meta name="referrer" content="no-referrer" />
</svelte:head>

<h1>{m.app_codefix_result_heading()}</h1>

<div class={data.result === 'connected' ? 'site-callout' : 'site-callout warning'} role="note">
  <h2 class="callout-title">{text.title}</h2>
  <p>{text.body}</p>
</div>

<style>
  .callout-title {
    margin: 0 0 var(--rs-space-2);
    font-family: var(--rs-font);
    font-size: 1.15rem;
  }
</style>
