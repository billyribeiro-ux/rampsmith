<script lang="ts">
  // The frame of every marketing page: skip link, header with the main navigation, the main
  // landmark and the footer. The navigation marks the current page with aria-current (WCAG 2.4.8
  // is AAA, but a screen-reader user still needs to know where they are).
  import type { Snippet } from 'svelte';
  import { page } from '$app/state';
  import { resolve } from '$app/paths';
  import { SkipLink } from '@rampsmith/ui';
  import { m } from '#lib/paraglide/messages.js';
  import './site.css';

  let { children }: { children: Snippet } = $props();

  const current = (href: string): 'page' | undefined =>
    page.url.pathname === href ? 'page' : undefined;
</script>

<div class="site">
  <SkipLink>{m.skip_to_content()}</SkipLink>
  <header>
    <div class="site-container bar">
      <a
        class="brand"
        href={resolve('/(site)')}
        aria-current={current(resolve('/(site)'))}
        aria-label={m.site_brand_home()}
      >
        {m.app_name()}
      </a>
      <nav aria-label={m.site_nav_label()}>
        <ul>
          <li>
            <a
              href={resolve('/(site)/how-it-works')}
              aria-current={current(resolve('/(site)/how-it-works'))}>{m.site_nav_how()}</a
            >
          </li>
          <li>
            <a href={resolve('/(site)/pricing')} aria-current={current(resolve('/(site)/pricing'))}
              >{m.site_nav_pricing()}</a
            >
          </li>
          <li>
            <a href={resolve('/(site)/scan')} aria-current={current(resolve('/(site)/scan'))}
              >{m.site_nav_scan()}</a
            >
          </li>
          <li>
            <a href={resolve('/dashboard/(app)')}>{m.site_nav_sign_in()}</a>
          </li>
        </ul>
      </nav>
    </div>
  </header>

  <main id="main" tabindex="-1">
    <div class="site-container">
      {@render children()}
    </div>
  </main>

  <footer>
    <div class="site-container">
      <nav aria-label={m.site_footer_label()}>
        <ul>
          <li>
            <a
              href={resolve('/(site)/(draft)/accessibility')}
              aria-current={current(resolve('/(site)/(draft)/accessibility'))}
              >{m.site_footer_statement()}</a
            >
          </li>
          <li>
            <a
              href={resolve('/(site)/(draft)/privacy')}
              aria-current={current(resolve('/(site)/(draft)/privacy'))}
              >{m.site_footer_privacy()}</a
            >
          </li>
          <li>
            <a
              href={resolve('/(site)/(draft)/terms')}
              aria-current={current(resolve('/(site)/(draft)/terms'))}>{m.site_footer_terms()}</a
            >
          </li>
          <li>
            <a
              href={resolve('/(site)/(draft)/dpa')}
              aria-current={current(resolve('/(site)/(draft)/dpa'))}>{m.site_footer_dpa()}</a
            >
          </li>
          <li>
            <a
              href={resolve('/(site)/(draft)/subprocessors')}
              aria-current={current(resolve('/(site)/(draft)/subprocessors'))}
              >{m.site_footer_subprocessors()}</a
            >
          </li>
        </ul>
      </nav>
      <p>{m.site_footer_note()}</p>
      <p>{m.site_footer_draft()}</p>
    </div>
  </footer>
</div>

<style>
  header {
    border-bottom: 1px solid var(--rs-color-border);
  }
  .bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--rs-space-2) var(--rs-space-6);
    padding-block: var(--rs-space-2);
  }
  .brand {
    display: inline-flex;
    align-items: center;
    min-height: var(--rs-target);
    font-family: var(--site-display);
    font-size: 1.5rem;
    font-weight: 700;
    text-decoration: none;
    color: var(--rs-color-accent);
  }
  ul {
    display: flex;
    flex-wrap: wrap;
    gap: 0 var(--rs-space-4);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  nav a {
    display: inline-flex;
    align-items: center;
    min-height: var(--rs-target);
    color: var(--rs-color-text);
    text-underline-offset: 0.3em;
  }
  nav a[aria-current='page'] {
    font-weight: 700;
    text-decoration: underline;
    text-decoration-thickness: 2px;
  }
  footer {
    border-top: 1px solid var(--rs-color-border);
    padding-block: var(--rs-space-6);
    color: var(--rs-color-text-muted);
    font-size: 0.9375rem;
  }
  footer p {
    max-width: 42rem;
  }
  footer nav a {
    color: var(--rs-color-text-muted);
  }
</style>
