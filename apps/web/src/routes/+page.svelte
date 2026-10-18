<script lang="ts">
  import { resolve } from '$app/paths';
  import { Link } from '@rampsmith/ui';
  import StandaloneShell from '#lib/components/StandaloneShell.svelte';
  import { m } from '#lib/paraglide/messages.js';
</script>

<svelte:head>
  <title>{m.home_title()}</title>
  <meta name="description" content={m.home_lede()} />
</svelte:head>

<StandaloneShell>
  <h1>{m.home_heading()}</h1>
  <p class="lede">{m.home_lede()}</p>
  <p>{m.home_note()}</p>
  <p><Link href={resolve('dashboard')}>{m.home_sign_in()}</Link></p>
</StandaloneShell>

<style>
  .lede {
    font-size: 1.25rem;
  }
</style>
