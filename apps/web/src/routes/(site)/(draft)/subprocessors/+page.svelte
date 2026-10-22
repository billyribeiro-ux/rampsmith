<script lang="ts">
  import { m } from '#lib/paraglide/messages.js';

  const rows = [
    [m.site_sub_railway(), m.site_sub_railway_role(), m.site_sub_railway_data()],
    [m.site_sub_cloudflare(), m.site_sub_cloudflare_role(), m.site_sub_cloudflare_data()],
    [m.site_sub_anthropic(), m.site_sub_anthropic_role(), m.site_sub_anthropic_data()],
    [m.site_sub_aws(), m.site_sub_aws_role(), m.site_sub_aws_data()],
    [m.site_sub_github(), m.site_sub_github_role(), m.site_sub_github_data()],
    [m.site_sub_stripe(), m.site_sub_stripe_role(), m.site_sub_stripe_data()],
    [m.site_sub_grafana(), m.site_sub_grafana_role(), m.site_sub_grafana_data()],
  ] as const;
</script>

<svelte:head>
  <title>{m.site_sub_title()} · {m.app_name()}</title>
  <meta name="description" content={m.site_sub_lede()} />
  <meta name="robots" content="noindex, nofollow" />
</svelte:head>

<h1>{m.site_sub_title()}</h1>
<p class="site-lede">{m.site_sub_lede()}</p>
<div class="site-callout warning" role="note">
  <p><strong>{m.site_legal_draft_title()}</strong></p>
  <p>{m.site_sub_draft()}</p>
</div>

<!-- A scrollable region must be reachable by keyboard (WCAG 2.1.1). -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div class="scroll" role="region" aria-label={m.site_sub_caption()} tabindex="0">
  <table>
    <caption class="rs-visually-hidden">{m.site_sub_caption()}</caption>
    <thead>
      <tr>
        <th scope="col">{m.site_sub_col_name()}</th>
        <th scope="col">{m.site_sub_col_role()}</th>
        <th scope="col">{m.site_sub_col_data()}</th>
      </tr>
    </thead>
    <tbody>
      {#each rows as [name, role, data] (name)}
        <tr>
          <th scope="row">{name}</th>
          <td>{role}</td>
          <td>{data}</td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .scroll {
    overflow-x: auto;
    margin-block: var(--rs-space-6);
  }
  .scroll table {
    min-width: 36rem;
  }
</style>
