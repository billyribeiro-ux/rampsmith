<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import StandaloneShell from '#lib/components/StandaloneShell.svelte';
  import { m } from '#lib/paraglide/messages.js';
  import { register } from '#lib/passkeys.ts';

  let email = $state('');
  let name = $state('');
  let working = $state(false);
  let failure: string | undefined = $state();

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    working = true;
    failure = undefined;
    const result = await register(fetch, email, name);
    working = false;
    if (result.ok) {
      await goto(resolve('dashboard'));
      return;
    }
    failure =
      result.kind === 'unsupported'
        ? m.passkeys_unsupported()
        : m.register_failed({
            reason:
              result.kind === 'refused' && result.detail !== undefined
                ? result.detail
                : m.register_failed_generic(),
          });
  }
</script>

<svelte:head>
  <title>{m.register_title()}</title>
</svelte:head>

<StandaloneShell>
  <h1>{m.register_heading()}</h1>
  <p>{m.register_lede()}</p>
  <noscript><p>{m.passkeys_need_js()}</p></noscript>
  <form onsubmit={submit} aria-describedby="register-status">
    <p>
      <label for="email">{m.register_email()}</label>
      <input
        id="email"
        name="email"
        type="email"
        autocomplete="email"
        required
        bind:value={email}
      />
    </p>
    <p>
      <label for="name">{m.register_name()}</label>
      <input
        id="name"
        name="name"
        type="text"
        autocomplete="name"
        required
        maxlength="100"
        bind:value={name}
      />
    </p>
    <p><button type="submit" disabled={working}>{m.register_button()}</button></p>
  </form>
  <p id="register-status" role="status">{working ? m.register_working() : ''}</p>
  {#if failure !== undefined}
    <p role="alert" class="error">{failure}</p>
  {/if}
  <p>
    {m.register_have_account()}
    <a href={resolve('/dashboard/sign-in')}>{m.register_sign_in_link()}</a>
  </p>
</StandaloneShell>

<style>
  label {
    display: block;
    font-weight: 600;
  }
  input {
    font: inherit;
    padding: 0.4rem;
    min-width: min(100%, 20rem);
    border: 1px solid #6b6b6b;
    border-radius: 4px;
  }
  .error {
    color: #a4161a;
  }
</style>
