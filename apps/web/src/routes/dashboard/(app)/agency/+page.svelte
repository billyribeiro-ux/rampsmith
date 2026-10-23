<script lang="ts">
  import { enhance } from '$app/forms';
  import { resolve } from '$app/paths';
  import { Button, Link } from '@rampsmith/ui';
  import StandaloneShell from '#lib/components/StandaloneShell.svelte';
  import { m } from '#lib/paraglide/messages.js';
  import { getLocale } from '#lib/paraglide/runtime.js';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();

  const when = (iso: string | null | undefined): string => {
    if (iso === null || iso === undefined) return m.dash_agency_not_scanned();
    const date = new Date(iso);
    return Number.isNaN(date.getTime())
      ? ''
      : new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(
          date,
        );
  };

  const named = $derived(
    new Map(data.organizations.map((organization) => [organization.id, organization.name])),
  );
  const failure = $derived(form !== null && 'failure' in form ? form.failure : undefined);
</script>

<svelte:head>
  <title>{m.dash_agency_title()}</title>
</svelte:head>

<StandaloneShell>
  <h1>{m.dash_agency_heading()}</h1>
  <p>{m.dash_agency_lede()}</p>
  <p><Link href={resolve('/dashboard/(app)')}>{m.dash_agency_back()}</Link></p>

  {#if data.unavailable || failure !== undefined}
    <p role="alert" class="error">
      {failure === 'limit' ? m.dash_agency_error_limit() : m.dash_agency_error()}
    </p>
  {/if}

  {#if form !== null && 'code' in form}
    <section aria-labelledby="code-heading" class="code">
      <h2 id="code-heading">
        {m.dash_agency_code_heading({ name: named.get(form.organization ?? '') ?? '' })}
      </h2>
      <p class="value"><output>{form.code}</output></p>
      <p>{m.dash_agency_code_body({ expires: when(form.expires_at) })}</p>
    </section>
  {/if}

  <h2>{m.dash_agency_orgs_heading()}</h2>
  {#if data.organizations.length === 0}
    <p>{m.dash_agency_orgs_empty()}</p>
  {:else}
    <ul>
      {#each data.organizations as organization (organization.id)}
        <li>
          <strong>{organization.name}</strong>
          <form method="POST" action="?/createCode" use:enhance class="inline">
            <input type="hidden" name="organization" value={organization.id} />
            <Button type="submit">{m.dash_agency_code_button({ name: organization.name })}</Button>
          </form>
        </li>
      {/each}
    </ul>
  {/if}
  <form method="POST" action="?/createOrganization" use:enhance>
    <p>
      <label for="organization-name">{m.dash_agency_org_name()}</label>
      <input
        id="organization-name"
        name="name"
        type="text"
        autocomplete="organization"
        required
        maxlength="100"
        value={form !== null && 'name' in form ? form.name : ''}
      />
    </p>
    <p><Button type="submit">{m.dash_agency_org_create()}</Button></p>
  </form>

  <h2>{m.dash_agency_stores_heading()}</h2>
  {#if data.stores.length === 0}
    <p>{m.dash_agency_stores_empty()}</p>
  {:else}
    <div class="scroll">
      <table>
        <caption class="sr-only">{m.dash_agency_caption()}</caption>
        <thead>
          <tr>
            <th scope="col">{m.dash_agency_col_store()}</th>
            <th scope="col">{m.dash_agency_col_organization()}</th>
            <th scope="col">{m.dash_agency_col_checks()}</th>
            <th scope="col">{m.dash_agency_col_open()}</th>
            <th scope="col">{m.dash_agency_col_serious()}</th>
            <th scope="col">{m.dash_agency_col_regressions()}</th>
            <th scope="col">{m.dash_agency_col_last_scan()}</th>
            <th scope="col">{m.dash_agency_col_actions()}</th>
          </tr>
        </thead>
        <tbody>
          {#each data.stores as store (store.link_id)}
            <tr>
              <th scope="row">{store.shop_domain}</th>
              <td>{store.organization_name}</td>
              <td>{typeof store.pass_rate === 'number' ? `${String(store.pass_rate)}%` : ''}</td>
              <td>{store.open_findings}</td>
              <td>{store.open_serious}</td>
              <td>
                {store.regression_new === null || store.regression_new === undefined
                  ? m.dash_agency_regressions_none()
                  : m.dash_agency_regressions_some({
                      added: store.regression_new,
                      returned: store.regression_reappeared ?? 0,
                    })}
              </td>
              <td>{when(store.scan_at)}</td>
              <td>
                <form method="POST" action="?/unlink" use:enhance>
                  <input type="hidden" name="link" value={store.link_id} />
                  <Button
                    type="submit"
                    aria-label={m.dash_agency_unlink_label({ store: store.shop_domain })}
                  >
                    {m.dash_agency_unlink()}
                  </Button>
                </form>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</StandaloneShell>

<style>
  label {
    display: block;
    font-weight: 600;
  }
  input[type='text'] {
    font: inherit;
    min-height: var(--rs-target);
    padding: 0 var(--rs-space-3);
    min-width: min(100%, 20rem);
    border: 1px solid var(--rs-color-border);
    border-radius: var(--rs-radius);
  }
  .error {
    color: var(--rs-color-critical);
  }
  .code {
    border: 1px solid var(--rs-color-border);
    border-radius: var(--rs-radius);
    padding: var(--rs-space-4);
  }
  .value output {
    font-family: ui-monospace, monospace;
    font-size: 1.5rem;
    font-weight: 700;
    letter-spacing: 0.1em;
  }
  .inline {
    display: inline-block;
    margin-inline-start: var(--rs-space-3);
  }
  .scroll {
    overflow-x: auto;
  }
  table {
    border-collapse: collapse;
    width: 100%;
  }
  th,
  td {
    text-align: start;
    padding: var(--rs-space-2) var(--rs-space-3);
    border-bottom: 1px solid var(--rs-color-border);
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
