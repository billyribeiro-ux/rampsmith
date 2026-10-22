<script lang="ts">
  import { onMount } from 'svelte';
  import { press } from '#lib/app/dom.ts';
  import { resolve } from '$app/paths';
  import { m } from '#lib/paraglide/messages.js';
  import { asApiError, errorMessage } from '#lib/app/errors.ts';
  import { getAppContext } from '#lib/app/context.svelte.ts';
  import { Resource } from '#lib/app/resource.svelte.ts';
  import { formatDateTime, formatNumber, formatPercent } from '#lib/app/format.ts';
  import { planPageUrl } from '#lib/app/nav.ts';
  import { planLabel } from '#lib/app/plans.ts';
  import { IMPACTS, type Impact, type Overview, type ScanStatus } from '#lib/app/types.ts';
  import ErrorBlock from '#lib/app/components/ErrorBlock.svelte';
  import ImpactBadge from '#lib/app/components/ImpactBadge.svelte';
  import Loading from '#lib/app/components/Loading.svelte';

  const app = getAppContext();
  const overview = new Resource<Overview>(() => app.api.overview());

  let starting = $state(false);
  let startError = $state('');

  const scan = $derived(overview.data?.latest_scan ?? null);
  const running = $derived(scan?.status === 'queued' || scan?.status === 'running');

  onMount(() => {
    void overview.refresh();
  });

  // While a scan runs the overview refreshes itself; the finished scan is announced once.
  $effect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      void overview.refresh({ quiet: true }).then(() => {
        const status = overview.data?.latest_scan?.status;
        if (status !== undefined && status !== 'queued' && status !== 'running') {
          app.announce(m.app_scan_finished());
        }
      });
    }, 3000);
    return () => {
      clearInterval(timer);
    };
  });

  async function start(): Promise<void> {
    starting = true;
    startError = '';
    try {
      await app.api.startScan();
      app.announce(m.app_scan_started());
      await overview.refresh({ quiet: true });
    } catch (error) {
      startError = errorMessage(asApiError(error));
    } finally {
      starting = false;
    }
  }

  function statusLabel(status: ScanStatus): string {
    return {
      queued: m.app_scan_status_queued(),
      running: m.app_scan_status_running(),
      succeeded: m.app_scan_status_succeeded(),
      partial: m.app_scan_status_partial(),
      failed: m.app_scan_status_failed(),
      cancelled: m.app_scan_status_cancelled(),
    }[status];
  }

  function statusTone(status: ScanStatus): 'success' | 'critical' | 'info' | 'caution' {
    return status === 'succeeded'
      ? 'success'
      : status === 'failed'
        ? 'critical'
        : status === 'partial'
          ? 'caution'
          : 'info';
  }

  function impactCount(data: Overview, impact: Impact): number {
    return data.open_by_impact[impact];
  }

  const plansUrl = $derived(planPageUrl(app.shop));
</script>

<svelte:head>
  <title>{m.app_overview_title()}</title>
</svelte:head>

<s-page heading={m.app_overview_heading()}>
  <s-button
    slot="primary-action"
    variant="primary"
    loading={starting}
    disabled={running || starting}
    {@attach press(() => void start())}
  >
    {m.app_scan_start()}
  </s-button>

  {#if startError !== ''}
    <s-banner tone="critical" heading={m.app_scan_start_failed()}>
      <s-paragraph>{startError}</s-paragraph>
    </s-banner>
  {/if}

  {#if overview.status === 'loading'}
    <s-section>
      <Loading />
    </s-section>
  {:else if overview.status === 'error'}
    <s-section>
      <ErrorBlock error={overview.error} retry={() => overview.refresh()} />
    </s-section>
  {:else if overview.data !== undefined}
    {@const data = overview.data}
    {#if scan === null}
      <s-section>
        <s-empty-state heading={m.app_overview_empty_heading()}>
          <s-paragraph>{m.app_overview_empty_body()}</s-paragraph>
          <s-button slot="primary-action" variant="primary" {@attach press(() => void start())}>
            {m.app_scan_start()}
          </s-button>
        </s-empty-state>
      </s-section>
    {:else}
      <s-section heading={m.app_scan_heading()}>
        <s-stack gap="base">
          <s-stack direction="inline" gap="small" alignItems="center">
            <s-badge tone={statusTone(scan.status)}>{statusLabel(scan.status)}</s-badge>
            {#if scan.finished_at !== null}
              <s-text>{m.app_scan_finished_at({ when: formatDateTime(scan.finished_at) })}</s-text>
            {:else}
              <s-text>{m.app_scan_started_at({ when: formatDateTime(scan.created_at) })}</s-text>
            {/if}
          </s-stack>
          {#if running}
            <s-progress
              value={scan.pages_done}
              max={Math.max(scan.pages_planned, 1)}
              accessibilityLabel={m.app_scan_progress_label()}
            ></s-progress>
            <s-text>
              {m.app_scan_pages({
                done: formatNumber(scan.pages_done),
                planned: formatNumber(scan.pages_planned),
              })}
            </s-text>
          {/if}
          {#if scan.status === 'failed' || scan.status === 'partial'}
            <s-banner tone={scan.status === 'failed' ? 'critical' : 'warning'}>
              <s-paragraph>
                {scan.status === 'failed' ? m.app_scan_failed_body() : m.app_scan_partial_body()}
              </s-paragraph>
            </s-banner>
          {/if}
          {#if data.next_scan_at !== null}
            <s-text color="subdued">
              {m.app_scan_next({ when: formatDateTime(data.next_scan_at) })}
            </s-text>
          {/if}
        </s-stack>
      </s-section>

      <s-section heading={m.app_issues_heading()}>
        <ul class="counts" aria-label={m.app_issues_by_impact()}>
          {#each [...IMPACTS].reverse() as impact (impact)}
            <li>
              <ImpactBadge {impact} />
              <span class="count">{formatNumber(impactCount(data, impact))}</span>
            </li>
          {/each}
        </ul>
        <p>
          <a class="app-link" href={resolve('/app/findings')}>{m.app_issues_view_all()}</a>
        </p>
      </s-section>

      <s-section heading={m.app_checks_heading()}>
        {#if scan.checks_run > 0}
          <s-paragraph>
            {m.app_checks_pass_rate({
              rate: formatPercent(scan.checks_passed / scan.checks_run),
              passed: formatNumber(scan.checks_passed),
              run: formatNumber(scan.checks_run),
            })}
          </s-paragraph>
        {:else}
          <s-paragraph>{m.app_checks_none()}</s-paragraph>
        {/if}
        <s-paragraph color="subdued">{m.app_checks_caveat()}</s-paragraph>
      </s-section>
    {/if}

    <s-section heading={m.app_fixes_heading()}>
      <s-stack gap="small">
        <s-paragraph>
          {m.app_fixes_awaiting({ count: data.fixes_awaiting_approval })}
        </s-paragraph>
        <s-paragraph>{m.app_fixes_applied({ count: data.fixes_applied })}</s-paragraph>
        <p>
          <a class="app-link" href={resolve('/app/fixes')}>{m.app_fixes_review_link()}</a>
        </p>
      </s-stack>
    </s-section>

    <s-section heading={m.app_plan_heading()}>
      <s-stack gap="small">
        <s-paragraph>{m.app_plan_current({ plan: planLabel(data.entitlements.plan) })}</s-paragraph>
        <s-paragraph>
          {m.app_plan_drafts({
            used: formatNumber(data.entitlements.alt_text_drafts.used),
            limit: formatNumber(data.entitlements.alt_text_drafts.limit),
          })}
        </s-paragraph>
        {#if plansUrl !== undefined}
          <s-link href={plansUrl} target="_top">{m.app_plan_compare()}</s-link>
        {/if}
      </s-stack>
    </s-section>
  {/if}
</s-page>

<style>
  .counts {
    display: flex;
    flex-wrap: wrap;
    gap: 1.5rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .counts li {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .count {
    font-size: 1.5rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
</style>
