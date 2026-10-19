<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { Button, Link } from '@rampsmith/ui';
  import StandaloneShell from '#lib/components/StandaloneShell.svelte';
  import { m } from '#lib/paraglide/messages.js';
  import { signIn, supportsPasskeys } from '#lib/passkeys.ts';

  let working = $state(false);
  let failure: string | undefined = $state();
  let supported = $state(true);

  onMount(() => {
    supported = supportsPasskeys();
  });

  async function start() {
    working = true;
    failure = undefined;
    const result = await signIn(fetch);
    working = false;
    if (result.ok) {
      await goto(resolve('dashboard'));
      return;
    }
    failure = result.kind === 'unsupported' ? m.passkeys_unsupported() : m.signin_failed();
  }
</script>

<svelte:head>
  <title>{m.signin_title()}</title>
</svelte:head>

<StandaloneShell>
  <h1>{m.signin_heading()}</h1>
  <p>{m.signin_lede()}</p>
  <noscript><p>{m.passkeys_need_js()}</p></noscript>
  <p>
    <Button variant="primary" onclick={start} disabled={working} aria-describedby="sign-in-status">
      {m.signin_button()}
    </Button>
  </p>
  <p id="sign-in-status" role="status">{working ? m.signin_working() : ''}</p>
  {#if failure !== undefined}
    <p role="alert" class="error">{failure}</p>
  {:else if !supported}
    <p role="alert" class="error">{m.passkeys_unsupported()}</p>
  {/if}
  <p>
    {m.signin_no_account()}
    <Link href={resolve('/dashboard/register')}>{m.signin_register_link()}</Link>
  </p>
</StandaloneShell>

<style>
  .error {
    color: var(--rs-color-critical);
  }
</style>
