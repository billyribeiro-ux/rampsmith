<script lang="ts">
  import { m } from '#lib/paraglide/messages.js';
</script>

<svelte:head>
  <title>{m.home_title()}</title>
  <meta name="description" content={m.home_lede()} />
</svelte:head>

<a class="skip" href="#main">{m.skip_to_content()}</a>
<header>
  <p class="brand">{m.app_name()}</p>
</header>
<main id="main" tabindex="-1">
  <h1>{m.home_heading()}</h1>
  <p class="lede">{m.home_lede()}</p>
  <p>{m.home_note()}</p>
</main>

<style>
  .skip {
    position: absolute;
    left: -10000px;
  }
  .skip:focus {
    position: static;
  }
  header,
  main {
    max-width: 48rem;
    margin: 0 auto;
    padding: 1rem 1.5rem;
  }
  .brand {
    font-weight: 700;
    color: var(--rs-color-accent);
  }
  .lede {
    font-size: 1.25rem;
  }
</style>
