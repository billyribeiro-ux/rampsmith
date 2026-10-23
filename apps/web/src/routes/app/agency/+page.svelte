<script lang="ts">
  import { onMount } from 'svelte';
  import { press, valueOf } from '#lib/app/dom.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { getAppContext } from '#lib/app/context.svelte.ts';
  import { asApiError } from '#lib/app/errors.ts';
  import { formatDateTime } from '#lib/app/format.ts';
  import { Resource } from '#lib/app/resource.svelte.ts';
  import type { AgencyCodePreview, AgencyLink, AgencyLinkList } from '#lib/app/types.ts';
  import ErrorBlock from '#lib/app/components/ErrorBlock.svelte';
  import Loading from '#lib/app/components/Loading.svelte';

  const app = getAppContext();
  const links = new Resource<AgencyLinkList>(() => app.api.agencyLinks());

  let code = $state('');
  let checking = $state(false);
  let preview = $state<AgencyCodePreview | undefined>();
  let problem = $state('');

  onMount(() => {
    void links.refresh();
  });

  function describe(error: unknown): string {
    const known = asApiError(error);
    if (known.code === 'rate_limited') return m.app_agency_code_limited();
    if (known.code === 'not_found') return m.app_agency_code_invalid();
    return m.app_agency_failed();
  }

  async function check(): Promise<void> {
    problem = '';
    preview = undefined;
    checking = true;
    try {
      preview = await app.api.previewAgencyLink(code);
    } catch (error) {
      problem = describe(error);
    } finally {
      checking = false;
    }
  }

  async function approve(): Promise<void> {
    problem = '';
    checking = true;
    try {
      const granted = await app.api.approveAgencyLink(code);
      app.announce(m.app_agency_approved({ name: granted.organization_name }));
      code = '';
      preview = undefined;
      await links.refresh({ quiet: true });
    } catch (error) {
      problem = describe(error);
    } finally {
      checking = false;
    }
  }

  function cancel(): void {
    preview = undefined;
    problem = '';
  }

  async function revoke(link: AgencyLink): Promise<void> {
    problem = '';
    try {
      await app.api.revokeAgencyLink(link.id);
      app.announce(m.app_agency_revoked({ name: link.organization_name }));
      await links.refresh({ quiet: true });
    } catch {
      problem = m.app_agency_revoke_failed();
    }
  }
</script>

<svelte:head>
  <title>{m.app_agency_title()}</title>
</svelte:head>

<s-page heading={m.app_agency_heading()}>
  <s-section heading={m.app_agency_about_heading()}>
    <s-paragraph>{m.app_agency_about()}</s-paragraph>
  </s-section>

  {#if problem !== ''}
    <s-banner tone="critical" heading={problem}></s-banner>
  {/if}

  <s-section heading={m.app_agency_list_heading()}>
    {#if links.status === 'loading'}
      <Loading />
    {:else if links.status === 'error'}
      <ErrorBlock error={links.error} retry={() => links.refresh()} />
    {:else if links.data !== undefined}
      {#if links.data.links.length === 0}
        <s-paragraph>{m.app_agency_empty()}</s-paragraph>
      {:else}
        <div class="app-scroll">
          <table class="app-table">
            <caption class="app-sr-only">{m.app_agency_caption()}</caption>
            <thead>
              <tr>
                <th scope="col">{m.app_agency_col_agency()}</th>
                <th scope="col">{m.app_agency_col_since()}</th>
                <th scope="col">{m.app_agency_col_actions()}</th>
              </tr>
            </thead>
            <tbody>
              {#each links.data.links as link (link.id)}
                <tr>
                  <th scope="row">{link.organization_name}</th>
                  <td>{formatDateTime(link.granted_at)}</td>
                  <td>
                    <s-button
                      tone="critical"
                      accessibilityLabel={`${m.app_agency_revoke()}: ${link.organization_name}`}
                      {@attach press(() => void revoke(link))}
                    >
                      {m.app_agency_revoke()}
                    </s-button>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    {/if}
  </s-section>

  <s-section heading={m.app_agency_add_heading()}>
    <s-stack gap="base">
      <s-paragraph>{m.app_agency_add_body()}</s-paragraph>
      {#if preview === undefined}
        <s-text-field
          label={m.app_agency_code_label()}
          details={m.app_agency_code_hint()}
          value={code}
          autocomplete="off"
          maxLength="16"
          oninput={(e: Event) => {
            code = valueOf(e);
          }}
        ></s-text-field>
        <s-stack direction="inline">
          <s-button
            variant="primary"
            disabled={checking || code.trim() === ''}
            {@attach press(() => void check())}
          >
            {m.app_agency_check()}
          </s-button>
        </s-stack>
      {:else}
        <s-banner
          tone="warning"
          heading={m.app_agency_confirm_heading({ name: preview.organization_name })}
        >
          <s-paragraph>
            {m.app_agency_confirm_body({ name: preview.organization_name })}
          </s-paragraph>
        </s-banner>
        <s-stack direction="inline" gap="small">
          <s-button variant="primary" disabled={checking} {@attach press(() => void approve())}>
            {m.app_agency_approve()}
          </s-button>
          <s-button {@attach press(cancel)}>{m.app_agency_cancel()}</s-button>
        </s-stack>
      {/if}
    </s-stack>
  </s-section>
</s-page>
