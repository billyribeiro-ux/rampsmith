<script lang="ts">
  import { onMount } from 'svelte';
  import { press } from '#lib/app/dom.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { getAppContext } from '#lib/app/context.svelte.ts';
  import { asApiError, errorMessage } from '#lib/app/errors.ts';
  import { formatDateTime } from '#lib/app/format.ts';
  import { Resource } from '#lib/app/resource.svelte.ts';
  import type { FixList, FixSummary } from '#lib/app/types.ts';
  import ErrorBlock from '#lib/app/components/ErrorBlock.svelte';
  import FixStatusBadge from '#lib/app/components/FixStatusBadge.svelte';
  import Loading from '#lib/app/components/Loading.svelte';

  const app = getAppContext();
  const log = new Resource<FixList>(() => app.api.fixes('all'));
  let more = $state<FixSummary[]>([]);
  let cursor = $state<string | null>(null);
  let loadingMore = $state(false);
  let exporting = $state<'csv' | 'json' | ''>('');
  let exportError = $state('');

  const entries = $derived([...(log.data?.items ?? []), ...more]);

  onMount(async () => {
    await log.refresh();
    cursor = log.data?.next_cursor ?? null;
  });

  async function loadMore(): Promise<void> {
    if (cursor === null) return;
    loadingMore = true;
    try {
      const next = await app.api.fixes('all', cursor);
      more = [...more, ...next.items];
      cursor = next.next_cursor;
    } finally {
      loadingMore = false;
    }
  }

  async function download(format: 'csv' | 'json'): Promise<void> {
    exporting = format;
    exportError = '';
    try {
      const file = await app.api.exportLog(format);
      const url = URL.createObjectURL(file.blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = file.filename;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => {
        URL.revokeObjectURL(url);
      }, 10_000);
      app.announce(m.app_log_exported({ file: file.filename }));
    } catch (error) {
      exportError = errorMessage(asApiError(error));
    } finally {
      exporting = '';
    }
  }

  function verification(fix: FixSummary): string {
    switch (fix.status) {
      case 'verified':
        return m.app_log_verified({
          when: fix.verified_at === null ? '' : formatDateTime(fix.verified_at),
        });
      case 'failed':
        return m.app_log_failed();
      case 'applied':
        return m.app_log_pending();
      case 'reverted':
        return m.app_log_reverted();
      case 'rejected':
        return m.app_log_rejected();
      case 'proposed':
      case 'approved':
      case 'applying':
        return m.app_log_not_applied();
    }
  }
</script>

<svelte:head>
  <title>{m.app_log_title()}</title>
</svelte:head>

<s-page heading={m.app_log_heading()}>
  <s-section heading={m.app_log_export_heading()}>
    <s-stack gap="base">
      <s-paragraph>{m.app_log_export_body()}</s-paragraph>
      <s-stack direction="inline" gap="small">
        <s-button
          loading={exporting === 'csv'}
          disabled={exporting !== ''}
          {@attach press(() => void download('csv'))}
        >
          {m.app_log_export_csv()}
        </s-button>
        <s-button
          loading={exporting === 'json'}
          disabled={exporting !== ''}
          {@attach press(() => void download('json'))}
        >
          {m.app_log_export_json()}
        </s-button>
      </s-stack>
      {#if exportError !== ''}
        <s-banner tone="critical" heading={m.app_log_export_failed()}>
          <s-paragraph>{exportError}</s-paragraph>
        </s-banner>
      {/if}
    </s-stack>
  </s-section>

  <s-section heading={m.app_log_list_heading()}>
    {#if log.status === 'loading'}
      <Loading />
    {:else if log.status === 'error'}
      <ErrorBlock error={log.error} retry={() => log.refresh()} />
    {:else if entries.length === 0}
      <s-empty-state heading={m.app_log_empty_heading()}>
        <s-paragraph>{m.app_log_empty_body()}</s-paragraph>
      </s-empty-state>
    {:else}
      <div class="app-scroll">
        <table class="app-table">
          <caption class="app-sr-only">{m.app_log_caption()}</caption>
          <thead>
            <tr>
              <th scope="col">{m.app_log_col_change()}</th>
              <th scope="col">{m.app_log_col_criterion()}</th>
              <th scope="col">{m.app_log_col_status()}</th>
              <th scope="col">{m.app_log_col_approved()}</th>
              <th scope="col">{m.app_log_col_verification()}</th>
            </tr>
          </thead>
          <tbody>
            {#each entries as fix (fix.id)}
              <tr>
                <th scope="row">
                  {fix.product_title}
                  <span class="app-note">
                    {m.app_log_change({
                      before: fix.change.before ?? m.app_fix_current_none(),
                      after: fix.change.after,
                    })}
                  </span>
                </th>
                <td>{[...new Set(fix.findings.flatMap((f) => f.criteria))].join(', ')}</td>
                <td><FixStatusBadge status={fix.status} /></td>
                <td>
                  {#if fix.approved_at !== null}
                    {fix.approver_name ?? m.app_log_system()}
                    <span class="app-note">{formatDateTime(fix.approved_at)}</span>
                  {:else}
                    {m.app_log_not_approved()}
                  {/if}
                </td>
                <td>{verification(fix)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
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
