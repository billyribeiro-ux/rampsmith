<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { resolve } from '$app/paths';
  import { m } from '#lib/paraglide/messages.js';
  import { appHref } from '#lib/app/nav.ts';
  import { getAppContext } from '#lib/app/context.svelte.ts';
  import { understandingUrl } from '#lib/app/criteria.ts';
  import { formatDateTime, formatNumber } from '#lib/app/format.ts';
  import { Resource } from '#lib/app/resource.svelte.ts';
  import type { FindingDetail } from '#lib/app/types.ts';
  import ErrorBlock from '#lib/app/components/ErrorBlock.svelte';
  import FixStatusBadge from '#lib/app/components/FixStatusBadge.svelte';
  import ImpactBadge from '#lib/app/components/ImpactBadge.svelte';
  import Loading from '#lib/app/components/Loading.svelte';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const app = getAppContext();
  const id = $derived(page.params.id ?? '');
  const finding = new Resource<FindingDetail>(() => app.api.finding(id));

  /** Evidence crops by id, loaded as data URLs (the CSP allows `data:` images only). */
  let crops = $state<Record<string, string>>({});

  onMount(async () => {
    await finding.refresh();
    for (const ref of finding.data?.evidence ?? []) {
      app.api.evidence(ref.id).then(
        (url) => {
          crops = { ...crops, [ref.id]: url };
        },
        () => undefined,
      );
    }
  });

  const heading = $derived(finding.data?.title ?? m.app_finding_heading());
</script>

<svelte:head>
  <title>{heading}</title>
</svelte:head>

<s-page {heading}>
  <s-link slot="breadcrumb-actions" href={appHref('/app/findings', app.carry)}>
    {m.app_back_to_findings()}
  </s-link>

  {#if finding.status === 'loading'}
    <s-section><Loading /></s-section>
  {:else if finding.status === 'error'}
    <s-section><ErrorBlock error={finding.error} retry={() => finding.refresh()} /></s-section>
  {:else if finding.data !== undefined}
    {@const f = finding.data}
    <s-section heading={m.app_finding_summary()}>
      <s-stack gap="base">
        <s-stack direction="inline" gap="small" alignItems="center">
          <ImpactBadge impact={f.impact} />
          <s-badge tone="neutral">
            {f.origin === 'render' ? m.app_origin_render() : m.app_origin_data()}
          </s-badge>
          {#if f.on_purchase_path}
            <s-badge tone="info">{m.app_purchase_path()}</s-badge>
          {/if}
        </s-stack>
        <s-paragraph>{f.explanation}</s-paragraph>
        <s-text>
          {m.app_where({
            templates: formatNumber(f.templates_affected),
            occurrences: formatNumber(f.occurrence_count),
          })}
        </s-text>
      </s-stack>
    </s-section>

    <s-section heading={m.app_finding_criteria()}>
      <ul class="app-list">
        {#each f.criteria as criterion (criterion)}
          {@const learn = understandingUrl(data.criteria, criterion)}
          <li>
            <strong>{criterion}</strong>
            {data.criteria[criterion] ?? ''}
            {#if learn !== undefined}
              <a class="app-link" href={learn} target="_blank" rel="external noreferrer">
                {m.app_criterion_learn({ id: criterion })}
              </a>
            {/if}
          </li>
        {/each}
      </ul>
    </s-section>

    <s-section heading={m.app_finding_evidence()}>
      {#if f.evidence.length === 0}
        <s-paragraph>{m.app_finding_no_evidence()}</s-paragraph>
      {:else}
        <div class="evidence">
          {#each f.evidence as ref (ref.id)}
            <figure>
              {#if crops[ref.id] !== undefined}
                <img
                  src={crops[ref.id]}
                  alt={ref.kind === 'before'
                    ? m.app_evidence_before_alt()
                    : m.app_evidence_after_alt()}
                />
              {:else}
                <span class="missing">{m.app_loading()}</span>
              {/if}
              <figcaption>
                {ref.kind === 'before' ? m.app_evidence_before() : m.app_evidence_after()}
              </figcaption>
            </figure>
          {/each}
        </div>
      {/if}
    </s-section>

    <s-section heading={m.app_finding_where()}>
      {#if f.templates.length > 0}
        <s-paragraph>{m.app_finding_templates({ templates: f.templates.join(', ') })}</s-paragraph>
      {/if}
      {#if f.occurrences.length === 0}
        <s-paragraph>{m.app_finding_no_occurrences()}</s-paragraph>
      {:else}
        <div class="app-scroll">
          <table class="app-table">
            <caption class="app-sr-only">{m.app_occurrences_caption()}</caption>
            <thead>
              <tr>
                <th scope="col">{m.app_col_page()}</th>
                <th scope="col">{m.app_col_state()}</th>
                <th scope="col">{m.app_col_element()}</th>
              </tr>
            </thead>
            <tbody>
              {#each f.occurrences as o, index (index)}
                <tr>
                  <td class="app-code">{o.page_url}</td>
                  <td>{o.page_state}</td>
                  <td>
                    <code class="app-code">{o.target}</code>
                    <code class="app-code app-note">{o.html_excerpt}</code>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </s-section>

    <s-section heading={m.app_finding_fixes()}>
      {#if f.fixes.length === 0}
        <s-paragraph>{m.app_finding_no_fix()}</s-paragraph>
      {:else}
        <ul class="app-list">
          {#each f.fixes as fix (fix.id)}
            <li>
              <FixStatusBadge status={fix.status} />
              <a class="app-link" href={resolve('/app/fixes')}>
                {m.app_finding_fix_link({ when: formatDateTime(fix.proposed_at) })}
              </a>
            </li>
          {/each}
        </ul>
      {/if}
    </s-section>
  {/if}
</s-page>

<style>
  .evidence {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
  }
  figure {
    margin: 0;
    max-inline-size: 24rem;
  }
  img {
    max-inline-size: 100%;
    border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
  }
  .missing {
    display: block;
    padding: 1rem;
  }
  li {
    margin-block: 0.25rem;
  }
</style>
