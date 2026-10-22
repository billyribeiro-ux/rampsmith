<script lang="ts">
  import ArrowRightIcon from 'phosphor-svelte/lib/ArrowRightIcon';
  import ClipboardTextIcon from 'phosphor-svelte/lib/ClipboardTextIcon';
  import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlassIcon';
  import WrenchIcon from 'phosphor-svelte/lib/WrenchIcon';
  import { resolve } from '$app/paths';
  import { Link } from '@rampsmith/ui';
  import { m } from '#lib/paraglide/messages.js';
</script>

<svelte:head>
  <title>{m.home_title()}: {m.home_heading()}</title>
  <meta name="description" content={m.home_lede()} />
</svelte:head>

<section class="hero" aria-labelledby="hero-title">
  <p class="site-eyebrow">{m.site_home_eyebrow()}</p>
  <h1 id="hero-title">{m.home_heading()}</h1>
  <p class="site-lede">{m.home_lede()}</p>
  <div class="site-actions">
    <a class="site-button primary" href={resolve('/(site)/scan')}>
      {m.site_cta_scan()}
      <ArrowRightIcon size={20} weight="bold" aria-hidden="true" />
    </a>
    <a class="site-button secondary" href={resolve('/(site)/pricing')}>{m.site_cta_pricing()}</a>
  </div>
  <p class="note">{m.home_note()}</p>
</section>

<section aria-labelledby="what-title">
  <h2 id="what-title">{m.site_home_what_title()}</h2>
  <ul class="site-grid">
    <li class="site-card">
      <span class="site-icon"><MagnifyingGlassIcon size={32} aria-hidden="true" /></span>
      <h3>{m.site_home_find_title()}</h3>
      <p>{m.site_home_find_body()}</p>
    </li>
    <li class="site-card">
      <span class="site-icon"><WrenchIcon size={32} aria-hidden="true" /></span>
      <h3>{m.site_home_fix_title()}</h3>
      <p>{m.site_home_fix_body()}</p>
    </li>
    <li class="site-card">
      <span class="site-icon"><ClipboardTextIcon size={32} aria-hidden="true" /></span>
      <h3>{m.site_home_record_title()}</h3>
      <p>{m.site_home_record_body()}</p>
    </li>
  </ul>
  <p><Link href={resolve('/(site)/how-it-works')}>{m.site_cta_how()}</Link></p>
</section>

<section aria-labelledby="never-title">
  <h2 id="never-title">{m.site_home_never_title()}</h2>
  <ul class="site-grid">
    <li class="site-card">
      <h3>{m.site_home_never_overlay_title()}</h3>
      <p>{m.site_home_never_overlay_body()}</p>
    </li>
    <li class="site-card">
      <h3>{m.site_home_never_claims_title()}</h3>
      <p>{m.site_home_never_claims_body()}</p>
    </li>
  </ul>
</section>

<section aria-labelledby="limits-title">
  <h2 id="limits-title">{m.site_home_limits_title()}</h2>
  <div class="site-callout">
    <p>{m.site_home_limits_body()}</p>
    <p>
      <Link href="https://github.com/dequelabs/axe-core#readme" newTabLabel={m.site_new_tab()}
        >{m.site_home_limits_link()}</Link
      >
    </p>
  </div>
</section>

<section aria-labelledby="who-title">
  <h2 id="who-title">{m.site_home_who_title()}</h2>
  <ul class="site-grid">
    <li class="site-card">
      <h3>{m.site_home_who_owner_title()}</h3>
      <p>{m.site_home_who_owner_body()}</p>
    </li>
    <li class="site-card">
      <h3>{m.site_home_who_agency_title()}</h3>
      <p>{m.site_home_who_agency_body()}</p>
    </li>
    <li class="site-card">
      <h3>{m.site_home_who_team_title()}</h3>
      <p>{m.site_home_who_team_body()}</p>
    </li>
  </ul>
</section>

<section class="end" aria-labelledby="end-title">
  <h2 id="end-title">{m.site_home_end_title()}</h2>
  <p>{m.site_home_end_body()}</p>
  <div class="site-actions">
    <a class="site-button primary" href={resolve('/(site)/scan')}>{m.site_cta_scan()}</a>
  </div>
</section>

<style>
  .hero {
    padding-block: var(--rs-space-6);
  }
  .note {
    color: var(--rs-color-text-muted);
  }
</style>
