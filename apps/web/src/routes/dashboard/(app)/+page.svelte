<script lang="ts">
  import { Button } from '@rampsmith/ui';
  import StandaloneShell from '#lib/components/StandaloneShell.svelte';
  import { m } from '#lib/paraglide/messages.js';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
</script>

<svelte:head>
  <title>{m.dash_title()}</title>
</svelte:head>

<StandaloneShell>
  <h1>{m.dash_heading()}</h1>
  <p>{m.dash_signed_in_as({ name: data.user.display_name, email: data.user.email })}</p>
  <p>{m.dash_empty()}</p>
  <form method="POST" action="?/signOut">
    <Button type="submit">{m.dash_sign_out()}</Button>
  </form>
</StandaloneShell>
