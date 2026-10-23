<script lang="ts">
  import { page } from '$app/state';
  import { m } from '#lib/paraglide/messages.js';
</script>

<svelte:head>
  <title>{page.status === 404 ? m.not_found_title() : m.error_title()}</title>
</svelte:head>

<main class="error-page">
  <h1>{page.status === 404 ? m.not_found_title() : m.error_title()}</h1>
  {#if page.status !== 404}
    <p>
      {page.error?.reference === undefined
        ? m.error_body_plain()
        : m.error_body({ reference: page.error.reference })}
    </p>
  {/if}
</main>
