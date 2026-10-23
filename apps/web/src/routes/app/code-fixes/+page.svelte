<script lang="ts">
  import { onMount } from 'svelte';
  import { press, valueOf } from '#lib/app/dom.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { getAppContext } from '#lib/app/context.svelte.ts';
  import { asApiError, errorMessage } from '#lib/app/errors.ts';
  import { formatDateTime } from '#lib/app/format.ts';
  import { Resource } from '#lib/app/resource.svelte.ts';
  import type {
    CodeFixBatch,
    CodeFixBatchStatus,
    CodeFixes,
    CodeFixPullRequest,
    GithubRepository,
  } from '#lib/app/types.ts';
  import ErrorBlock from '#lib/app/components/ErrorBlock.svelte';
  import Loading from '#lib/app/components/Loading.svelte';
  import LockedFeature from '#lib/app/components/LockedFeature.svelte';

  const app = getAppContext();
  const screen = new Resource<CodeFixes>(() => app.api.codeFixes());

  let busy = $state<'' | 'connect' | 'save' | 'start' | 'disconnect'>('');
  let failure = $state('');
  /** The link to GitHub once the api has issued its one-time state. */
  let continueHref = $state('');
  let continueLink: HTMLElement | undefined = $state();
  let repositoryId = $state('');
  let branch = $state('');
  let started = $state(false);

  const data = $derived(screen.data);
  const connection = $derived(data?.connection ?? null);
  const repositories = $derived(
    (data?.repositories ?? []).filter((r) => r.can_push && !r.archived),
  );
  const chosen = $derived(data?.repositories.find((r) => r.selected));
  const selected = $derived(repositories.find((r) => r.id === repositoryId));
  const ready = $derived(chosen?.theme_state === 'ok');
  const inFlight = $derived(
    (data?.batches ?? []).some((b) =>
      ['reading', 'patching', 'ready', 'opening'].includes(b.status),
    ),
  );
  const gate = $derived({
    feature: 'github_pull_requests' as const,
    gate: data?.plan.gate ?? 'unavailable',
    unlocked_by: data?.plan.unlocked_by ?? null,
  });

  /** Takes the repository form's starting values from what the api says is chosen. */
  function seed(next: CodeFixes | undefined): void {
    const current = next?.repositories.find((r) => r.selected);
    const first = next?.repositories.find((r) => r.can_push && !r.archived);
    const repo = current ?? first;
    repositoryId = repo?.id ?? '';
    branch = repo?.connected_branch ?? repo?.default_branch ?? '';
  }

  async function load(quiet = false): Promise<void> {
    await screen.refresh({ quiet });
    if (!quiet) seed(screen.data);
  }

  onMount(() => {
    void load();
    // Coming back from the GitHub tab: look again.
    const visible = () => {
      if (document.visibilityState === 'visible' && continueHref !== '') void load(true);
    };
    document.addEventListener('visibilitychange', visible);
    return () => {
      document.removeEventListener('visibilitychange', visible);
    };
  });

  // A request in progress is read by background jobs; the list follows it until it ends.
  $effect(() => {
    if (!inFlight) return;
    const timer = setInterval(() => {
      void load(true);
    }, 3000);
    return () => {
      clearInterval(timer);
    };
  });

  async function connect(): Promise<void> {
    busy = 'connect';
    failure = '';
    try {
      const { state } = await app.api.startGithubConnection();
      continueHref = `/github/connect?state=${encodeURIComponent(state)}`;
      app.announce(m.app_codefix_connect_ready());
      await Promise.resolve();
      setTimeout(() => {
        continueLink?.focus();
      }, 0);
    } catch (error) {
      failure = errorMessage(asApiError(error));
    } finally {
      busy = '';
    }
  }

  async function save(): Promise<void> {
    if (selected === undefined) return;
    busy = 'save';
    failure = '';
    try {
      screen.data = await app.api.chooseRepository(selected.id, branch.trim());
      seed(screen.data);
      app.announce(m.app_codefix_repo_saved({ repo: selected.full_name }));
    } catch (error) {
      failure = errorMessage(asApiError(error));
    } finally {
      busy = '';
    }
  }

  async function start(): Promise<void> {
    busy = 'start';
    failure = '';
    try {
      await app.api.startCodeFixBatch();
      started = true;
      app.announce(m.app_codefix_started());
      await load(true);
    } catch (error) {
      failure = errorMessage(asApiError(error));
    } finally {
      busy = '';
    }
  }

  async function disconnect(): Promise<void> {
    busy = 'disconnect';
    failure = '';
    try {
      screen.data = await app.api.disconnectGithub();
      continueHref = '';
      seed(screen.data);
      app.announce(m.app_codefix_disconnected());
    } catch (error) {
      failure = errorMessage(asApiError(error));
    } finally {
      busy = '';
    }
  }

  const BATCH_STATE: Record<CodeFixBatchStatus, () => string> = {
    reading: () => m.app_codefix_batch_reading(),
    patching: () => m.app_codefix_batch_patching(),
    ready: () => m.app_codefix_batch_ready(),
    opening: () => m.app_codefix_batch_opening(),
    opened: () => m.app_codefix_batch_opened(),
    nothing_to_fix: () => m.app_codefix_batch_nothing_to_fix(),
    failed: () => m.app_codefix_batch_failed(),
  };

  const SKIP: Record<string, () => string> = {
    refused: () => m.app_codefix_skip_refused(),
    'needs-review': () => m.app_codefix_skip_needs_review(),
    unmapped: () => m.app_codefix_skip_unmapped(),
    'no-recipe': () => m.app_codefix_skip_no_recipe(),
    'already-fixed': () => m.app_codefix_skip_already_fixed(),
  };

  function skipped(batch: CodeFixBatch): string {
    return batch.skipped
      .map((s) =>
        m.app_codefix_skip({ code: (SKIP[s.code] ?? (() => s.code))(), count: String(s.count) }),
      )
      .join('; ');
  }

  function result(batch: CodeFixBatch): string {
    if (batch.status === 'failed') {
      return m.app_codefix_batch_failure({ code: batch.failure_code ?? 'unknown' });
    }
    if (batch.fixed === null || batch.considered === null) return '';
    return m.app_codefix_batch_result({
      fixed: String(batch.fixed),
      considered: String(batch.considered),
    });
  }

  function theme(repo: GithubRepository): string {
    switch (repo.theme_state) {
      case 'ok':
        return m.app_codefix_theme_ok();
      case 'not_a_theme':
        return m.app_codefix_theme_not_a_theme();
      case 'unreachable':
        return m.app_codefix_theme_unreachable();
      default:
        return m.app_codefix_theme_unchecked();
    }
  }

  const PR_STATE: Record<CodeFixPullRequest['state'], () => string> = {
    open: () => m.app_codefix_pr_open(),
    merged: () => m.app_codefix_pr_merged(),
    closed: () => m.app_codefix_pr_closed(),
  };

  /** Only GitHub addresses are linked; anything else the api might return is shown as text. */
  function githubUrl(url: string): string | undefined {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' && parsed.hostname === 'github.com'
        ? parsed.href
        : undefined;
    } catch {
      return undefined;
    }
  }
</script>

<svelte:head>
  <title>{m.app_codefix_title()}</title>
</svelte:head>

<s-page heading={m.app_codefix_heading()}>
  {#if screen.status === 'loading' && data === undefined}
    <s-section>
      <Loading />
    </s-section>
  {:else if screen.status === 'error' && data === undefined}
    <s-section>
      <ErrorBlock error={screen.error} retry={() => load()} />
    </s-section>
  {:else if data !== undefined && !data.enabled}
    <s-section heading={m.app_codefix_off_heading()}>
      <s-paragraph>{m.app_codefix_off_body()}</s-paragraph>
    </s-section>
  {:else if data !== undefined}
    <s-section heading={m.app_codefix_intro_heading()}>
      <s-paragraph>{m.app_codefix_intro_body()}</s-paragraph>
    </s-section>

    {#if failure !== ''}
      <s-banner tone="critical" heading={m.app_error_heading()}>
        <s-paragraph>{failure}</s-paragraph>
      </s-banner>
    {/if}

    {#if data.plan.gate !== 'allowed'}
      <s-section heading={m.app_codefix_connect_heading()}>
        <LockedFeature
          {gate}
          name={m.app_codefix_gate_name()}
          description={m.app_codefix_gate_description()}
        />
      </s-section>
    {:else if connection === null}
      <s-section heading={m.app_codefix_connect_heading()}>
        <s-stack gap="base">
          <s-paragraph>{m.app_codefix_connect_body()}</s-paragraph>
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-button
              variant="primary"
              loading={busy === 'connect'}
              disabled={busy !== ''}
              {@attach press(() => void connect())}
            >
              {m.app_codefix_connect_button()}
            </s-button>
            {#if continueHref !== ''}
              <s-link href={continueHref} target="_blank" bind:this={continueLink}>
                {m.app_codefix_connect_continue()}
              </s-link>
              <s-button {@attach press(() => void load(true))}>
                {m.app_codefix_connect_refresh()}
              </s-button>
            {/if}
          </s-stack>
        </s-stack>
      </s-section>
    {:else}
      <s-section heading={m.app_codefix_account_heading()}>
        <s-stack gap="base">
          <s-paragraph>
            {m.app_codefix_account({ account: connection.account, kind: connection.account_type })}
            {#if connection.connected_by !== null}
              {m.app_codefix_account_by({
                user: connection.connected_by,
                when: formatDateTime(connection.linked_at),
              })}
            {/if}
          </s-paragraph>
          <s-paragraph>{m.app_codefix_disconnect_note()}</s-paragraph>
          <s-stack direction="inline" gap="small">
            <s-button
              tone="critical"
              loading={busy === 'disconnect'}
              disabled={busy !== ''}
              {@attach press(() => void disconnect())}
            >
              {m.app_codefix_disconnect()}
            </s-button>
          </s-stack>
        </s-stack>
      </s-section>

      <s-section heading={m.app_codefix_repo_heading()}>
        {#if repositories.length === 0}
          <s-stack gap="base">
            <s-paragraph>{m.app_codefix_repo_none()}</s-paragraph>
            <s-stack direction="inline" gap="small">
              <s-button {@attach press(() => void load(true))}>
                {m.app_codefix_connect_refresh()}
              </s-button>
            </s-stack>
          </s-stack>
        {:else}
          <s-stack gap="base">
            <s-select
              label={m.app_codefix_repo_label()}
              value={repositoryId}
              onchange={(e: Event) => {
                repositoryId = valueOf(e);
                const repo = repositories.find((r) => r.id === repositoryId);
                branch = repo?.connected_branch ?? repo?.default_branch ?? '';
              }}
            >
              {#each repositories as repo (repo.id)}
                <s-option value={repo.id}>
                  {repo.full_name} ({repo.visibility === 'private'
                    ? m.app_codefix_repo_private()
                    : m.app_codefix_repo_public()})
                </s-option>
              {/each}
            </s-select>
            <s-text-field
              label={m.app_codefix_branch_label()}
              details={m.app_codefix_branch_details()}
              value={branch}
              oninput={(e: Event) => {
                branch = valueOf(e);
              }}
            ></s-text-field>
            {#if chosen !== undefined}
              <s-paragraph>{chosen.full_name}: {theme(chosen)}</s-paragraph>
            {/if}
            <s-stack direction="inline" gap="small">
              <s-button
                loading={busy === 'save'}
                disabled={busy !== '' || selected === undefined || branch.trim() === ''}
                {@attach press(() => void save())}
              >
                {m.app_codefix_repo_save()}
              </s-button>
            </s-stack>
          </s-stack>
        {/if}
      </s-section>

      <s-section heading={m.app_codefix_start_heading()}>
        <s-stack gap="base">
          <s-paragraph>{m.app_codefix_start_body()}</s-paragraph>
          {#if !ready}
            <s-paragraph>{m.app_codefix_start_blocked()}</s-paragraph>
          {/if}
          <s-stack direction="inline" gap="small">
            <s-button
              variant="primary"
              loading={busy === 'start'}
              disabled={busy !== '' || !ready || inFlight}
              {@attach press(() => void start())}
            >
              {m.app_codefix_start_button()}
            </s-button>
          </s-stack>
          {#if started && inFlight}
            <s-paragraph>{m.app_codefix_started()}</s-paragraph>
          {/if}
        </s-stack>
      </s-section>

      <s-section heading={m.app_codefix_batches_heading()}>
        {#if data.batches.length === 0}
          <s-paragraph>{m.app_codefix_batches_none()}</s-paragraph>
        {:else}
          <div class="app-scroll">
            <table class="app-table">
              <caption class="app-sr-only">{m.app_codefix_batches_caption()}</caption>
              <thead>
                <tr>
                  <th scope="col">{m.app_codefix_col_when()}</th>
                  <th scope="col">{m.app_codefix_col_state()}</th>
                  <th scope="col">{m.app_codefix_col_result()}</th>
                </tr>
              </thead>
              <tbody>
                {#each data.batches as batch (batch.id)}
                  <tr>
                    <th scope="row">{formatDateTime(batch.created_at)}</th>
                    <td>{BATCH_STATE[batch.status]()}</td>
                    <td>
                      {result(batch)}
                      {#if batch.skipped.length > 0}
                        <span class="app-note">
                          {m.app_codefix_skip_heading()}
                          {skipped(batch)}
                        </span>
                      {/if}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </s-section>

      <s-section heading={m.app_codefix_prs_heading()}>
        {#if data.pull_requests.length === 0}
          <s-paragraph>{m.app_codefix_prs_none()}</s-paragraph>
        {:else}
          <div class="app-scroll">
            <table class="app-table">
              <caption class="app-sr-only">{m.app_codefix_prs_caption()}</caption>
              <thead>
                <tr>
                  <th scope="col">{m.app_codefix_col_pr()}</th>
                  <th scope="col">{m.app_codefix_col_state()}</th>
                  <th scope="col">{m.app_codefix_col_changes()}</th>
                  <th scope="col">{m.app_codefix_col_opened()}</th>
                </tr>
              </thead>
              <tbody>
                {#each data.pull_requests as pr (pr.id)}
                  {@const href = githubUrl(pr.html_url)}
                  <tr>
                    <th scope="row">
                      {#if href !== undefined}
                        <s-link {href} target="_blank">
                          {m.app_codefix_pr_link({ number: String(pr.number) })}
                        </s-link>
                      {:else}
                        #{pr.number}
                      {/if}
                      <span class="app-note"
                        >{m.app_codefix_pr_part({ part: String(pr.part) })}</span
                      >
                    </th>
                    <td>{PR_STATE[pr.state]()}</td>
                    <td>
                      {m.app_codefix_pr_changes({
                        fixes: String(pr.fix_count),
                        files: String(pr.files),
                        lines: String(pr.changed_lines),
                      })}
                      {#if pr.edited}
                        <span class="app-note">{m.app_codefix_pr_edited()}</span>
                      {/if}
                    </td>
                    <td>{formatDateTime(pr.opened_at)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </s-section>
    {/if}
  {/if}
</s-page>
