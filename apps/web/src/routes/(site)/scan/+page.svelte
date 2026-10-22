<script lang="ts">
  import { resolve } from '$app/paths';
  import { m } from '#lib/paraglide/messages.js';
  import type { UrlRefusal } from '#lib/server/scanner/url.ts';
  import ScanForm from '#lib/site/ScanForm.svelte';
  import ScanResult from '#lib/site/ScanResult.svelte';
  import type { ScanFormData } from './+page.server.ts';
  import type { PageData } from './$types';

  let { data, form }: { data: PageData; form: ScanFormData | null | undefined } = $props();

  const hours = (seconds: number): string => Math.max(1, Math.ceil(seconds / 3600)).toString();

  function invalidProblem(reason: UrlRefusal): string {
    switch (reason) {
      case 'empty':
        return m.site_scan_err_empty();
      case 'invalid':
        return m.site_scan_err_invalid();
      case 'scheme':
        return m.site_scan_err_scheme();
      case 'credentials':
        return m.site_scan_err_credentials();
      case 'port':
        return m.site_scan_err_port();
      case 'address':
        return m.site_scan_err_address();
      case 'private':
        return m.site_scan_err_private();
    }
  }

  function refusedProblem(reason: 'robots' | 'bot-challenge' | 'unreachable'): string {
    switch (reason) {
      case 'robots':
        return m.site_scan_err_robots();
      case 'bot-challenge':
        return m.site_scan_err_bot_challenge();
      case 'unreachable':
        return m.site_scan_err_unreachable();
    }
  }

  /** The sentence for an outcome that did not produce a result, or undefined when it did. */
  function problem(outcome: ScanFormData | null | undefined): string | undefined {
    if (outcome === null || outcome === undefined) return undefined;
    switch (outcome.kind) {
      case 'result':
      case 'not-connected':
        return undefined;
      case 'invalid-url':
        return invalidProblem(outcome.reason);
      case 'challenge-failed':
        return m.site_scan_err_challenge();
      case 'challenge-unavailable':
        return m.site_scan_err_challenge_down();
      case 'rate-limited':
        return outcome.scope === 'ip'
          ? m.site_scan_err_rate_ip({ hours: hours(outcome.retryAfterSeconds) })
          : m.site_scan_err_rate_domain({ hours: hours(outcome.retryAfterSeconds) });
      case 'refused':
        return refusedProblem(outcome.reason);
      case 'scanner-error':
        return m.site_scan_err_failed();
    }
  }

  const error = $derived(problem(form));
  let outcomeRegion: HTMLDivElement | undefined = $state();

  /** After an in-place update, the outcome gets the focus so a screen reader reads it. */
  function focusOutcome(): void {
    outcomeRegion?.focus();
  }
</script>

<svelte:head>
  <title>{m.site_scan_title()} · {m.app_name()}</title>
  <meta name="description" content={m.site_scan_lede()} />
  {#if form !== null && form !== undefined}
    <meta name="robots" content="noindex, nofollow" />
  {/if}
</svelte:head>

<h1>{m.site_scan_title()}</h1>
<p class="site-lede">{m.site_scan_lede()}</p>

{#if !data.open}
  <div class="site-callout warning" role="note">
    <h2 class="callout-title">{m.site_scan_closed_title()}</h2>
    <p>{m.site_scan_closed_body()}</p>
  </div>
{:else}
  <ScanForm
    siteKey={data.siteKey}
    turnstileOrigin={data.turnstileOrigin}
    url={form?.url ?? ''}
    {error}
    invalid={form?.kind === 'invalid-url'}
    onsettled={focusOutcome}
  />

  <div class="outcome" bind:this={outcomeRegion} tabindex="-1">
    {#if form?.kind === 'result'}
      <ScanResult result={form.result} cached={form.cached} />
      <p>
        <a href={resolve('/(site)/scan')} data-sveltekit-reload>{m.site_scan_result_again()}</a>
      </p>
    {:else if form?.kind === 'not-connected'}
      <div class="site-callout warning" role="status">
        <h2 class="callout-title">{m.site_scan_not_connected_title()}</h2>
        <p>{m.site_scan_not_connected_body()}</p>
      </div>
    {:else if error !== undefined && form?.kind !== 'invalid-url'}
      <div class="site-callout warning" role="alert">
        <h2 class="callout-title">{m.site_scan_error_title()}</h2>
        <p>{error}</p>
      </div>
    {/if}
  </div>
{/if}

<section aria-labelledby="know-title">
  <h2 id="know-title">{m.site_scan_know_title()}</h2>
  <ul>
    <li>{m.site_scan_know_partial()}</li>
    <li>{m.site_scan_know_limits()}</li>
    <li>{m.site_scan_know_robots()}</li>
    <li>{m.site_scan_know_private()}</li>
  </ul>
</section>

<style>
  .outcome {
    margin-block: var(--rs-space-6);
  }
  .outcome:focus {
    outline: none;
  }
  .callout-title {
    margin: 0 0 var(--rs-space-2);
    font-family: var(--rs-font);
    font-size: 1.15rem;
  }
</style>
