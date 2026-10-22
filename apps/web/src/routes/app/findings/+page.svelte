<script lang="ts">
  import { onMount } from 'svelte';
  import { resolve } from '$app/paths';
  import { m } from '#lib/paraglide/messages.js';
  import type { FindingQuery } from '#lib/app/api.ts';
  import { getAppContext } from '#lib/app/context.svelte.ts';
  import { valueOf, press } from '#lib/app/dom.ts';
  import { asApiError } from '#lib/app/errors.ts';
  import { formatNumber } from '#lib/app/format.ts';
  import { Resource } from '#lib/app/resource.svelte.ts';
  import {
    IMPACTS,
    type FindingList,
    type FindingOrigin,
    type FindingSummary,
    type Impact,
  } from '#lib/app/types.ts';
  import ErrorBlock from '#lib/app/components/ErrorBlock.svelte';
  import FixStatusBadge from '#lib/app/components/FixStatusBadge.svelte';
  import ImpactBadge from '#lib/app/components/ImpactBadge.svelte';
  import Loading from '#lib/app/components/Loading.svelte';

  const app = getAppContext();

  let impact = $state<'' | Impact>('');
  let origin = $state<'' | FindingOrigin>('');
  let fixFilter = $state<'' | 'with' | 'without'>('');

  const query = $derived<FindingQuery>({
    status: 'open',
    ...(impact === '' ? {} : { impact }),
    ...(origin === '' ? {} : { origin }),
    ...(fixFilter === '' ? {} : { hasFix: fixFilter === 'with' }),
  });

  const list = new Resource<FindingList>(() => app.api.findings(query));
  let more = $state<FindingSummary[]>([]);
  let cursor = $state<string | null>(null);
  let loadingMore = $state(false);
  let moreError = $state(false);

  const items = $derived([...(list.data?.items ?? []), ...more]);

  async function reload(): Promise<void> {
    more = [];
    await list.refresh();
    cursor = list.data?.next_cursor ?? null;
    if (list.status === 'ready') {
      app.announce(m.app_findings_count({ count: list.data?.total ?? 0 }));
    }
  }

  async function loadMore(): Promise<void> {
    if (cursor === null) return;
    loadingMore = true;
    moreError = false;
    try {
      const page = await app.api.findings({ ...query, cursor });
      more = [...more, ...page.items];
      cursor = page.next_cursor;
    } catch (error) {
      asApiError(error);
      moreError = true;
    } finally {
      loadingMore = false;
    }
  }

  onMount(() => {
    void reload();
  });

  function choose(update: () => void): void {
    update();
    void reload();
  }
</script>

<svelte:head>
  <title>{m.app_findings_title()}</title>
</svelte:head>

<s-page heading={m.app_findings_heading()}>
  <s-section heading={m.app_filters_heading()}>
    <s-stack direction="inline" gap="base">
      <s-select
        label={m.app_filter_impact()}
        value={impact}
        onchange={(e: Event) => {
          choose(() => {
            impact = valueOf(e) as '' | Impact;
          });
        }}
      >
        <s-option value="">{m.app_filter_all()}</s-option>
        {#each [...IMPACTS].reverse() as level (level)}
          <s-option value={level}>
            {{
              critical: m.app_impact_critical(),
              serious: m.app_impact_serious(),
              moderate: m.app_impact_moderate(),
              minor: m.app_impact_minor(),
            }[level]}
          </s-option>
        {/each}
      </s-select>
      <s-select
        label={m.app_filter_origin()}
        value={origin}
        onchange={(e: Event) => {
          choose(() => {
            origin = valueOf(e) as '' | FindingOrigin;
          });
        }}
      >
        <s-option value="">{m.app_filter_all()}</s-option>
        <s-option value="render">{m.app_origin_render()}</s-option>
        <s-option value="data">{m.app_origin_data()}</s-option>
      </s-select>
      <s-select
        label={m.app_filter_fix()}
        value={fixFilter}
        onchange={(e: Event) => {
          choose(() => {
            fixFilter = valueOf(e) as '' | 'with' | 'without';
          });
        }}
      >
        <s-option value="">{m.app_filter_all()}</s-option>
        <s-option value="with">{m.app_filter_fix_with()}</s-option>
        <s-option value="without">{m.app_filter_fix_without()}</s-option>
      </s-select>
    </s-stack>
  </s-section>

  <s-section heading={m.app_findings_list_heading()}>
    {#if list.status === 'loading'}
      <Loading />
    {:else if list.status === 'error'}
      <ErrorBlock error={list.error} retry={() => reload()} />
    {:else if items.length === 0}
      <s-empty-state heading={m.app_findings_empty_heading()}>
        <s-paragraph>
          {impact === '' && origin === '' && fixFilter === ''
            ? m.app_findings_empty_body()
            : m.app_findings_empty_filtered()}
        </s-paragraph>
      </s-empty-state>
    {:else}
      <p>{m.app_findings_count({ count: list.data?.total ?? items.length })}</p>
      <div class="app-scroll">
        <table class="app-table">
          <caption class="app-sr-only">{m.app_findings_table_caption()}</caption>
          <thead>
            <tr>
              <th scope="col">{m.app_col_issue()}</th>
              <th scope="col">{m.app_col_impact()}</th>
              <th scope="col">{m.app_col_criterion()}</th>
              <th scope="col">{m.app_col_where()}</th>
              <th scope="col">{m.app_col_fix()}</th>
            </tr>
          </thead>
          <tbody>
            {#each items as finding (finding.id)}
              <tr>
                <th scope="row">
                  <a class="app-link" href={resolve('/app/findings/[id]', { id: finding.id })}
                    >{finding.title}</a
                  >
                  {#if finding.on_purchase_path}
                    <span class="app-note">{m.app_purchase_path()}</span>
                  {/if}
                </th>
                <td><ImpactBadge impact={finding.impact} /></td>
                <td>{finding.criteria.join(', ')}</td>
                <td>
                  {m.app_where({
                    templates: formatNumber(finding.templates_affected),
                    occurrences: formatNumber(finding.occurrence_count),
                  })}
                </td>
                <td>
                  {#if finding.fix === null}
                    <span class="app-note">{m.app_no_fix_yet()}</span>
                  {:else}
                    <FixStatusBadge status={finding.fix.status} />
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if moreError}
        <s-banner tone="critical"><s-paragraph>{m.app_error_unexpected()}</s-paragraph></s-banner>
      {/if}
      {#if cursor !== null}
        <p>
          <s-button loading={loadingMore} {@attach press(() => void loadMore())}>
            {m.app_load_more()}
          </s-button>
        </p>
      {/if}
    {/if}
  </s-section>
</s-page>
