<script lang="ts">
  import { m } from '#lib/paraglide/messages.js';
  import type { FreeScanResult } from '#lib/server/scanner/client.ts';

  interface Props {
    result: FreeScanResult;
    cached: boolean;
  }

  let { result, cached }: Props = $props();

  const date = $derived(
    new Intl.DateTimeFormat('en-US', {
      dateStyle: 'long',
      timeStyle: 'short',
      timeZone: 'UTC',
    }).format(new Date(result.scannedAt)) + ' UTC',
  );
</script>

<h2 id="result-title">{m.site_scan_result_title({ domain: result.domain })}</h2>
<p class="meta">{m.site_scan_result_date({ date })}</p>
{#if cached}
  <p class="meta">{m.site_scan_result_cached()}</p>
{/if}
{#if result.isFixture}
  <div class="site-callout warning" role="note">
    <p>{m.site_scan_result_fixture()}</p>
  </div>
{/if}

<p class="score">
  {m.site_scan_result_passes({
    passed: result.checksPassed.toString(),
    total: result.checksRun.toString(),
  })}
</p>

<h3>{m.site_scan_result_failures()}</h3>
{#if result.failures.length === 0}
  <p>{m.site_scan_result_none()}</p>
{:else}
  <ul class="groups">
    {#each result.failures as failure (failure.ruleId)}
      <li class="site-card">
        <h4>{failure.title}</h4>
        <p class="meta">
          {m.site_scan_result_count({
            count: failure.count.toString(),
            criterion: failure.criterion,
          })}
        </p>
        <p class="examples-title">{m.site_scan_result_examples()}</p>
        <ul class="examples">
          {#each failure.examples.slice(0, 3) as example, i (i)}
            <li><code>{example.snippet}</code></li>
          {/each}
        </ul>
      </li>
    {/each}
  </ul>
{/if}

<h3>{m.site_scan_result_pages()}</h3>
<ul>
  {#each result.pages as page (page)}
    <li><code>{page}</code></li>
  {/each}
</ul>

<div class="site-callout">
  <p>{m.site_scan_result_partial()}</p>
</div>

<style>
  .meta {
    margin-block: var(--rs-space-1);
    color: var(--rs-color-text-muted);
  }
  .score {
    font-family: var(--site-display);
    font-size: 1.5rem;
    font-weight: 700;
    margin-block: var(--rs-space-4);
  }
  .groups {
    display: grid;
    gap: var(--rs-space-4);
    padding: 0;
    list-style: none;
    max-width: 48rem;
  }
  .site-card h4 {
    margin: 0;
    font-size: 1.15rem;
  }
  .examples-title {
    margin-bottom: var(--rs-space-1);
    font-weight: 700;
  }
  .examples {
    margin: 0;
    padding-inline-start: var(--rs-space-4);
  }
</style>
