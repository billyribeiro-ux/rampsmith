<script lang="ts">
  import { onMount } from 'svelte';
  import { resolve } from '$app/paths';
  import { press } from '#lib/app/dom.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { getAppContext } from '#lib/app/context.svelte.ts';
  import { asApiError, errorMessage } from '#lib/app/errors.ts';
  import { formatDateTime, formatNumber } from '#lib/app/format.ts';
  import { planPageUrl } from '#lib/app/nav.ts';
  import { planLabel } from '#lib/app/plans.ts';
  import { Resource } from '#lib/app/resource.svelte.ts';
  import type { Regression, RegressionItem, RegressionList } from '#lib/app/types.ts';
  import ErrorBlock from '#lib/app/components/ErrorBlock.svelte';
  import ImpactBadge from '#lib/app/components/ImpactBadge.svelte';
  import Loading from '#lib/app/components/Loading.svelte';

  const app = getAppContext();
  const regressions = new Resource<RegressionList>(() => app.api.regressions());
  let dismissError = $state('');

  onMount(() => {
    void regressions.refresh();
  });

  const plansUrl = $derived(planPageUrl(app.shop));

  async function dismiss(record: Regression): Promise<void> {
    dismissError = '';
    try {
      await app.api.dismissRegression(record.id);
      app.announce(m.app_regression_dismissed());
      await regressions.refresh({ quiet: true });
    } catch (error) {
      dismissError = errorMessage(asApiError(error));
    }
  }

  function kind(item: RegressionItem): string {
    return item.kind === 'new' ? m.app_regression_kind_new() : m.app_regression_kind_reappeared();
  }

  function rate(value: number | null): string {
    return value === null ? '' : `${formatNumber(Math.round(value * 10) / 10)}%`;
  }
</script>

<svelte:head>
  <title>{m.app_regression_title()}</title>
</svelte:head>

<s-page heading={m.app_regression_heading()}>
  {#if regressions.status === 'loading'}
    <s-section><Loading /></s-section>
  {:else if regressions.status === 'error'}
    <s-section>
      <ErrorBlock error={regressions.error} retry={() => regressions.refresh()} />
    </s-section>
  {:else if regressions.data !== undefined}
    {@const data = regressions.data}
    {#if data.gate === 'locked'}
      <!-- Shown, not hidden, and labelled with the plan that unlocks it (Built for Shopify 4.3.7). -->
      <s-section>
        <s-empty-state heading={m.app_regression_locked_heading()}>
          <s-stack gap="small">
            <s-paragraph>{m.app_regression_locked_body()}</s-paragraph>
            <s-stack direction="inline" gap="small" alignItems="center">
              <s-badge tone="info">
                {data.unlocked_by === null
                  ? m.app_gate_unavailable()
                  : m.app_gate_requires({ plan: planLabel(data.unlocked_by) })}
              </s-badge>
              {#if plansUrl !== undefined}
                <s-link href={plansUrl} target="_top">{m.app_plan_compare()}</s-link>
              {/if}
            </s-stack>
          </s-stack>
        </s-empty-state>
      </s-section>
    {:else}
      <s-section heading={m.app_regression_about_heading()}>
        <s-paragraph>{m.app_regression_about()}</s-paragraph>
      </s-section>

      {#if dismissError !== ''}
        <s-banner tone="critical" heading={m.app_regression_dismiss_failed()}>
          <s-paragraph>{dismissError}</s-paragraph>
        </s-banner>
      {/if}

      {#if data.items.length === 0}
        <s-section>
          <s-empty-state heading={m.app_regression_empty_heading()}>
            <s-paragraph>{m.app_regression_empty_body()}</s-paragraph>
          </s-empty-state>
        </s-section>
      {:else}
        {#each data.items as record (record.id)}
          <s-section
            heading={m.app_regression_record({ when: formatDateTime(record.detected_at) })}
          >
            <s-stack gap="base">
              <s-paragraph>
                {m.app_regression_counts({
                  added: formatNumber(record.new_count),
                  returned: formatNumber(record.reappeared_count),
                })}
              </s-paragraph>
              {#if record.pass_rate !== null && record.previous_pass_rate !== null}
                <s-paragraph>
                  {m.app_regression_pass_rate({
                    now: rate(record.pass_rate),
                    before: rate(record.previous_pass_rate),
                  })}
                </s-paragraph>
              {/if}
              <div class="app-scroll">
                <table class="app-table">
                  <caption class="app-sr-only">
                    {m.app_regression_caption({ when: formatDateTime(record.detected_at) })}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">{m.app_regression_col_issue()}</th>
                      <th scope="col">{m.app_regression_col_impact()}</th>
                      <th scope="col">{m.app_regression_col_criterion()}</th>
                      <th scope="col">{m.app_regression_col_kind()}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {#each record.items as item (item.finding_id)}
                      <tr>
                        <th scope="row">
                          <a
                            class="app-link"
                            href={resolve('/app/findings/[id]', { id: item.finding_id })}
                            >{item.title}</a
                          >
                        </th>
                        <td><ImpactBadge impact={item.impact} /></td>
                        <td>{item.criteria.join(', ')}</td>
                        <td>{kind(item)}</td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
              {#if record.new_count + record.reappeared_count > record.items.length}
                <s-text color="subdued">
                  {m.app_regression_more({
                    count: formatNumber(
                      record.new_count + record.reappeared_count - record.items.length,
                    ),
                  })}
                </s-text>
              {/if}
              {#if !record.dismissed}
                <s-stack direction="inline">
                  <s-button {@attach press(() => void dismiss(record))}>
                    {m.app_regression_dismiss()}
                  </s-button>
                </s-stack>
              {/if}
            </s-stack>
          </s-section>
        {/each}
      {/if}
    {/if}
  {/if}
</s-page>
