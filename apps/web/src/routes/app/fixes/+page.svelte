<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { m } from '#lib/paraglide/messages.js';
  import { getAppContext } from '#lib/app/context.svelte.ts';
  import { asApiError, errorMessage } from '#lib/app/errors.ts';
  import { Resource } from '#lib/app/resource.svelte.ts';
  import type { FixList, FixSummary, Settings } from '#lib/app/types.ts';
  import ErrorBlock from '#lib/app/components/ErrorBlock.svelte';
  import FixCard from '#lib/app/components/FixCard.svelte';
  import Loading from '#lib/app/components/Loading.svelte';
  import LockedFeature from '#lib/app/components/LockedFeature.svelte';

  const app = getAppContext();
  const queue = new Resource<FixList>(() => app.api.fixes('queue'));
  const applied = new Resource<FixList>(() => app.api.fixes('applied'));

  let maxCharacters = $state(150);
  let gates = $state<Settings['entitlements']['features']>([]);
  let busy = $state<Record<string, boolean>>({});
  let errors = $state<Record<string, string>>({});
  let emptyQueue: HTMLElement | undefined = $state();
  let emptyApplied: HTMLElement | undefined = $state();

  const queued = $derived(queue.data?.items ?? []);
  const done = $derived(applied.data?.items ?? []);
  const inFlight = $derived(
    [...queued, ...done].some((f) => f.status === 'approved' || f.status === 'applying'),
  );

  onMount(() => {
    void Promise.all([queue.refresh(), applied.refresh()]);
    // Best effort: the merchant's character limit and plan gates; the page works without them.
    app.api.settings().then(
      (s) => {
        maxCharacters = s.alt_text_max_characters;
        gates = s.entitlements.features;
      },
      () => undefined,
    );
  });

  // Approved fixes are written by a background job; the lists follow it until it is done.
  $effect(() => {
    if (!inFlight) return;
    const timer = setInterval(() => {
      void Promise.all([queue.refresh({ quiet: true }), applied.refresh({ quiet: true })]);
    }, 2000);
    return () => {
      clearInterval(timer);
    };
  });

  function setBusy(id: string, on: boolean): void {
    busy = { ...busy, [id]: on };
  }

  function setError(id: string, text: string): void {
    errors = { ...errors, [id]: text };
  }

  /** Puts focus on the heading of the card after the one that left, or on the empty message. */
  async function focusNext(
    list: 'queue' | 'applied',
    items: readonly FixSummary[],
    leaving: string,
  ): Promise<void> {
    const index = items.findIndex((f) => f.id === leaving);
    const next = items[index + 1] ?? items[index - 1];
    await tick();
    const target =
      next === undefined
        ? list === 'queue'
          ? emptyQueue
          : emptyApplied
        : document.getElementById(`fix-${next.id}`);
    target?.focus();
  }

  async function decide(
    fix: FixSummary,
    kind: 'approve' | 'reject',
    confirmed = false,
  ): Promise<void> {
    setBusy(fix.id, true);
    setError(fix.id, '');
    const before = queued;
    try {
      if (kind === 'approve') await app.api.approveFix(fix.id, { confirmFlagged: confirmed });
      else await app.api.rejectFix(fix.id);
      app.announce(
        kind === 'approve'
          ? m.app_announce_approved({ product: fix.product_title })
          : m.app_announce_rejected({ product: fix.product_title }),
      );
      await Promise.all([queue.refresh({ quiet: true }), applied.refresh({ quiet: true })]);
      await focusNext('queue', before, fix.id);
    } catch (error) {
      setError(fix.id, errorMessage(asApiError(error)));
    } finally {
      setBusy(fix.id, false);
    }
  }

  async function undo(fix: FixSummary): Promise<void> {
    setBusy(fix.id, true);
    setError(fix.id, '');
    const before = done;
    try {
      await app.api.undoFix(fix.id);
      app.announce(m.app_announce_undone({ product: fix.product_title }));
      await Promise.all([queue.refresh({ quiet: true }), applied.refresh({ quiet: true })]);
      await focusNext('applied', before, fix.id);
    } catch (error) {
      setError(fix.id, errorMessage(asApiError(error)));
    } finally {
      setBusy(fix.id, false);
    }
  }

  async function save(fix: FixSummary, alt: string): Promise<boolean> {
    setBusy(fix.id, true);
    setError(fix.id, '');
    try {
      const updated = await app.api.editFix(fix.id, alt);
      if (queue.data !== undefined) {
        queue.data = {
          ...queue.data,
          items: queue.data.items.map((f) => (f.id === fix.id ? updated : f)),
        };
      }
      app.announce(m.app_announce_edited({ product: fix.product_title }));
      return true;
    } catch (error) {
      setError(fix.id, errorMessage(asApiError(error)));
      return false;
    } finally {
      setBusy(fix.id, false);
    }
  }

  const gate = (feature: string) => gates.find((g) => g.feature === feature);
  const rewrites = $derived(gate('description_rewrites'));
  const pullRequests = $derived(gate('github_pull_requests'));
</script>

<svelte:head>
  <title>{m.app_fixes_title()}</title>
</svelte:head>

<s-page heading={m.app_fixes_page_heading()}>
  <s-section heading={m.app_queue_heading()}>
    {#if queue.status === 'loading'}
      <Loading />
    {:else if queue.status === 'error'}
      <ErrorBlock error={queue.error} retry={() => queue.refresh()} />
    {:else}
      <p tabindex="-1" bind:this={emptyQueue} class="status">
        {queued.length === 0 ? m.app_queue_empty() : m.app_queue_count({ count: queued.length })}
      </p>
      {#each queued as fix (fix.id)}
        <FixCard
          {fix}
          mode="queue"
          busy={busy[fix.id] === true}
          error={errors[fix.id] ?? ''}
          {maxCharacters}
          onapprove={(confirmed: boolean) => void decide(fix, 'approve', confirmed)}
          onreject={() => void decide(fix, 'reject')}
          onundo={() => undefined}
          onsave={(alt: string) => save(fix, alt)}
        />
      {/each}
    {/if}
  </s-section>

  <s-section heading={m.app_applied_heading()}>
    {#if applied.status === 'loading'}
      <Loading />
    {:else if applied.status === 'error'}
      <ErrorBlock error={applied.error} retry={() => applied.refresh()} />
    {:else}
      <p tabindex="-1" bind:this={emptyApplied} class="status">
        {done.length === 0 ? m.app_applied_empty() : m.app_applied_count({ count: done.length })}
      </p>
      {#each done as fix (fix.id)}
        <FixCard
          {fix}
          mode="applied"
          busy={busy[fix.id] === true}
          error={errors[fix.id] ?? ''}
          {maxCharacters}
          onapprove={() => undefined}
          onreject={() => undefined}
          onundo={() => void undo(fix)}
          onsave={() => Promise.resolve(false)}
        />
      {/each}
    {/if}
  </s-section>

  {#if rewrites !== undefined || pullRequests !== undefined}
    <s-section heading={m.app_more_heading()}>
      <s-stack gap="base">
        {#if rewrites !== undefined}
          <LockedFeature
            gate={rewrites}
            name={m.app_feature_rewrites()}
            description={m.app_feature_rewrites_body()}
          />
        {/if}
        {#if pullRequests !== undefined}
          <LockedFeature
            gate={pullRequests}
            name={m.app_feature_prs()}
            description={m.app_feature_prs_body()}
          />
        {/if}
      </s-stack>
    </s-section>
  {/if}
</s-page>

<style>
  .status {
    margin: 0 0 0.5rem;
  }
  .status:focus-visible {
    outline: 2px solid #005bd3;
    outline-offset: 2px;
  }
</style>
