<script lang="ts">
  import { resolve } from '$app/paths';
  import { m } from '#lib/paraglide/messages.js';
</script>

<svelte:head>
  <title>{m.site_how_title()} · {m.app_name()}</title>
  <meta name="description" content={m.site_how_lede()} />
</svelte:head>

<h1>{m.site_how_title()}</h1>
<p class="site-lede">{m.site_how_lede()}</p>

<ol class="steps site-grid">
  <li class="site-card">
    <h2>{m.site_how_s1_title()}</h2>
    <p>{m.site_how_s1_body()}</p>
  </li>
  <li class="site-card">
    <h2>{m.site_how_s2_title()}</h2>
    <p>{m.site_how_s2_body()}</p>
  </li>
  <li class="site-card">
    <h2>{m.site_how_s3_title()}</h2>
    <p>{m.site_how_s3_body()}</p>
  </li>
  <li class="site-card">
    <h2>{m.site_how_s4_title()}</h2>
    <p>{m.site_how_s4_body()}</p>
  </li>
</ol>

<section aria-labelledby="channels-title">
  <h2 id="channels-title">{m.site_how_channels_title()}</h2>
  <p>{m.site_how_channels_lede()}</p>
  <!-- A scrollable region must be reachable by keyboard (WCAG 2.1.1). -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div class="scroll" role="region" aria-labelledby="channels-title" tabindex="0">
    <table>
      <thead>
        <tr>
          <th scope="col">{m.site_how_ch_col_channel()}</th>
          <th scope="col">{m.site_how_ch_col_what()}</th>
          <th scope="col">{m.site_how_ch_col_undo()}</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <th scope="row">{m.site_how_ch_data()}</th>
          <td>{m.site_how_ch_data_what()}</td>
          <td>{m.site_how_ch_data_undo()}</td>
        </tr>
        <tr>
          <th scope="row">{m.site_how_ch_pr()}</th>
          <td>{m.site_how_ch_pr_what()}</td>
          <td>{m.site_how_ch_pr_undo()}</td>
        </tr>
        <tr>
          <th scope="row">{m.site_how_ch_pkg()}</th>
          <td>{m.site_how_ch_pkg_what()}</td>
          <td>{m.site_how_ch_pkg_undo()}</td>
        </tr>
      </tbody>
    </table>
  </div>
</section>

<section aria-labelledby="checked-title">
  <h2 id="checked-title">{m.site_how_checks_title()}</h2>
  <ul>
    <li>{m.site_how_checks_pages()}</li>
    <li>{m.site_how_checks_states()}</li>
    <li>{m.site_how_checks_out()}</li>
  </ul>
</section>

<section aria-labelledby="people-title">
  <h2 id="people-title">{m.site_how_people_title()}</h2>
  <p>{m.site_how_people_body()}</p>
  <p class="note">{m.home_note()}</p>
</section>

<div class="site-actions">
  <a class="site-button primary" href={resolve('/(site)/scan')}>{m.site_cta_scan()}</a>
  <a class="site-button secondary" href={resolve('/(site)/pricing')}>{m.site_cta_pricing()}</a>
</div>

<style>
  .steps {
    counter-reset: step;
    margin-block: var(--rs-space-6);
  }
  .steps > li {
    counter-increment: step;
  }
  .steps h2 {
    margin-top: 0;
    font-size: 1.35rem;
  }
  .steps h2::before {
    content: counter(step) '. ';
    color: var(--rs-color-accent);
  }
  .scroll {
    overflow-x: auto;
  }
  .scroll table {
    min-width: 36rem;
  }
  .note {
    color: var(--rs-color-text-muted);
  }
</style>
