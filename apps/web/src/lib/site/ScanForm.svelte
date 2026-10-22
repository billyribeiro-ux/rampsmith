<script lang="ts">
  // The free scanner's form. It works as a plain form post; with JavaScript it updates in place
  // and moves focus to the outcome. Cloudflare Turnstile needs JavaScript, so without it the
  // visitor is told why a scan cannot run.
  import { onMount, tick } from 'svelte';
  import { enhance } from '$app/forms';
  import { Button } from '@rampsmith/ui';
  import { m } from '#lib/paraglide/messages.js';
  import { renderChallenge, type Challenge } from './turnstile-client.ts';

  interface Props {
    siteKey: string;
    turnstileOrigin: string;
    url: string;
    /** The message to announce, when the last attempt did not produce a result. */
    error?: string | undefined;
    invalid?: boolean;
    /** Called after an in-place update, so the page can move focus to the outcome. */
    onsettled: () => void | Promise<void>;
  }

  let { siteKey, turnstileOrigin, url, error, invalid = false, onsettled }: Props = $props();

  // Starts as the address the server echoed back, and follows what the visitor types.
  let value = $derived(url);
  let working = $state(false);
  let slot: HTMLDivElement | undefined = $state();
  let challenge: Challenge | undefined;
  let challengeFailed = $state(false);

  onMount(() => {
    if (slot === undefined) return;
    renderChallenge(slot, { origin: turnstileOrigin, siteKey }).then(
      (rendered) => {
        challenge = rendered;
      },
      () => {
        challengeFailed = true;
      },
    );
    return () => {
      challenge?.remove();
    };
  });

  const inputId = $props.id();
</script>

<form
  method="POST"
  novalidate
  use:enhance={() => {
    working = true;
    return async ({ update }) => {
      await update({ reset: false });
      working = false;
      // A Turnstile token works once, so every attempt needs a fresh one.
      challenge?.reset();
      await tick();
      await onsettled();
    };
  }}
>
  <div class="field">
    <label for={`${inputId}-url`}>{m.site_scan_url_label()}</label>
    <p id={`${inputId}-hint`} class="hint">{m.site_scan_url_hint()}</p>
    {#if error !== undefined && invalid}
      <p id={`${inputId}-error`} class="error">{error}</p>
    {/if}
    <input
      id={`${inputId}-url`}
      name="url"
      type="text"
      inputmode="url"
      autocomplete="url"
      autocapitalize="off"
      spellcheck="false"
      required
      bind:value
      aria-describedby={error !== undefined && invalid
        ? `${inputId}-hint ${inputId}-error`
        : `${inputId}-hint`}
      aria-invalid={error !== undefined && invalid ? 'true' : undefined}
    />
  </div>

  <div class="challenge" role="group" aria-labelledby={`${inputId}-challenge`}>
    <p id={`${inputId}-challenge`} class="label">{m.site_scan_challenge_label()}</p>
    <div bind:this={slot}></div>
    <noscript><p class="error">{m.site_scan_noscript()}</p></noscript>
    {#if challengeFailed}
      <p class="error" role="alert">{m.site_scan_err_challenge_down()}</p>
    {/if}
  </div>

  <Button type="submit" variant="primary" disabled={working} aria-disabled={working}>
    {working ? m.site_scan_working() : m.site_scan_submit()}
  </Button>
</form>

<style>
  form {
    display: grid;
    gap: var(--rs-space-6);
    max-width: 36rem;
  }
  .field {
    display: grid;
    gap: var(--rs-space-1);
  }
  label,
  .label {
    font-weight: 700;
    margin: 0;
  }
  .hint {
    margin: 0;
    color: var(--rs-color-text-muted);
  }
  .error {
    margin: 0;
    color: var(--rs-color-critical);
    font-weight: 600;
  }
  input {
    min-height: var(--rs-target);
    padding: var(--rs-space-2) var(--rs-space-3);
    border: 2px solid var(--rs-color-border);
    border-radius: var(--rs-radius);
    background: var(--rs-color-surface);
    color: var(--rs-color-text);
    font: inherit;
    width: 100%;
    box-sizing: border-box;
  }
  input[aria-invalid='true'] {
    border-color: var(--rs-color-critical);
  }
  .challenge {
    display: grid;
    gap: var(--rs-space-2);
  }
</style>
