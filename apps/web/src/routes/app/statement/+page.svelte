<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { m } from '#lib/paraglide/messages.js';
  import { ApiError, type StatementPreview } from '#lib/app/api.ts';
  import { getAppContext } from '#lib/app/context.svelte.ts';
  import { hasSaveBar, valueOf, press } from '#lib/app/dom.ts';
  import { asApiError, errorMessage } from '#lib/app/errors.ts';
  import { formatDateTime } from '#lib/app/format.ts';
  import { Resource } from '#lib/app/resource.svelte.ts';
  import type { Draft, StatementContent, StatementState } from '#lib/app/types.ts';
  import ErrorBlock from '#lib/app/components/ErrorBlock.svelte';
  import Loading from '#lib/app/components/Loading.svelte';

  const app = getAppContext();
  const res = new Resource<StatementState>(() => app.api.statement());

  const EMPTY: Draft<StatementContent> = {
    organization: '',
    contact: { email: '', phone: '', postal_address: '', form_url: '', response_time: '' },
    measures: [],
    limitations: [],
    compatibility: '',
  };

  let content = $state<Draft<StatementContent>>(structuredClone(EMPTY));
  let saved = $state('');
  let saving = $state(false);
  let saveError = $state('');
  let fieldErrors = $state<Record<string, string>>({});
  let preview = $state<StatementPreview | undefined>(undefined);
  let previewError = $state('');
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  let addButton: HTMLElement | undefined = $state();

  const serialized = $derived(JSON.stringify(content));
  const dirty = $derived(serialized !== saved);
  const measuresText = $derived(content.measures.join('\n'));

  onMount(async () => {
    await res.refresh();
    if (res.data?.draft !== null && res.data?.draft !== undefined) {
      content = structuredClone($state.snapshot(res.data.draft)) as Draft<StatementContent>;
    }
    saved = JSON.stringify(content);
  });

  async function refreshPreview(): Promise<void> {
    try {
      preview = await app.api.previewStatement($state.snapshot(content));
      previewError = '';
    } catch (error) {
      const failed = asApiError(error);
      previewError =
        failed.code === 'validation_failed'
          ? m.app_statement_preview_incomplete()
          : errorMessage(failed);
    }
  }

  // The preview follows the form after a short pause, so typing is never interrupted.
  $effect(() => {
    if (res.status !== 'ready' || serialized === '') return;
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => void refreshPreview(), 500);
    return () => {
      clearTimeout(previewTimer);
    };
  });

  async function save(event?: Event): Promise<void> {
    event?.preventDefault();
    saving = true;
    saveError = '';
    fieldErrors = {};
    try {
      res.data = await app.api.saveStatement($state.snapshot(content));
      saved = JSON.stringify(content);
      app.announce(m.app_statement_saved());
    } catch (error) {
      const failed = error instanceof ApiError ? error : asApiError(error);
      saveError = errorMessage(failed);
      fieldErrors = Object.fromEntries(failed.fieldErrors.map((e) => [e.field, e.message]));
    } finally {
      saving = false;
    }
  }

  function discard(): void {
    content = JSON.parse(saved) as Draft<StatementContent>;
    fieldErrors = {};
    saveError = '';
  }

  function setMeasures(text: string): void {
    content.measures = text.split('\n').filter((line) => line.trim() !== '');
  }

  function addLimitation(): void {
    content.limitations.push({ description: '', reason: '', alternative: '' });
  }

  async function removeLimitation(index: number): Promise<void> {
    content.limitations.splice(index, 1);
    app.announce(m.app_statement_limitation_removed());
    await tick();
    addButton?.focus();
  }

  async function copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      app.announce(m.app_statement_copied());
    } catch {
      app.announce(m.app_statement_copy_failed());
    }
  }

  const statusLabel = $derived(
    preview === undefined
      ? ''
      : {
          not_evaluated: m.app_statement_status_not_evaluated(),
          known_barriers: m.app_statement_status_known_barriers(),
          no_known_barriers: m.app_statement_status_no_known_barriers(),
        }[preview.status],
  );
</script>

<svelte:head>
  <title>{m.app_statement_title()}</title>
</svelte:head>

<s-page heading={m.app_statement_heading()}>
  {#if res.status === 'loading'}
    <s-section><Loading /></s-section>
  {:else if res.status === 'error'}
    <s-section><ErrorBlock error={res.error} retry={() => res.refresh()} /></s-section>
  {:else}
    <s-section>
      <s-banner tone="info">
        <s-paragraph>{m.app_statement_intro()}</s-paragraph>
        <s-paragraph>{m.app_statement_review_note()}</s-paragraph>
      </s-banner>
    </s-section>

    <form data-save-bar={dirty ? '' : undefined} onsubmit={save} onreset={discard}>
      <s-section heading={m.app_statement_form_heading()}>
        <s-stack gap="base">
          <s-text-field
            label={m.app_statement_organization()}
            required
            value={content.organization}
            error={fieldErrors['organization']}
            oninput={(e: Event) => {
              content.organization = valueOf(e);
            }}
          ></s-text-field>
          <s-text-field
            label={m.app_statement_email()}
            value={content.contact.email}
            error={fieldErrors['contact.email']}
            details={m.app_statement_contact_hint()}
            oninput={(e: Event) => {
              content.contact.email = valueOf(e);
            }}
          ></s-text-field>
          <s-text-field
            label={m.app_statement_phone()}
            value={content.contact.phone}
            error={fieldErrors['contact.phone']}
            oninput={(e: Event) => {
              content.contact.phone = valueOf(e);
            }}
          ></s-text-field>
          <s-text-area
            label={m.app_statement_address()}
            rows="2"
            value={content.contact.postal_address}
            error={fieldErrors['contact.postal_address']}
            oninput={(e: Event) => {
              content.contact.postal_address = valueOf(e);
            }}
          ></s-text-area>
          <s-text-field
            label={m.app_statement_form_url()}
            value={content.contact.form_url}
            error={fieldErrors['contact.form_url']}
            oninput={(e: Event) => {
              content.contact.form_url = valueOf(e);
            }}
          ></s-text-field>
          <s-text-field
            label={m.app_statement_response_time()}
            value={content.contact.response_time}
            details={m.app_statement_response_hint()}
            oninput={(e: Event) => {
              content.contact.response_time = valueOf(e);
            }}
          ></s-text-field>
          <s-text-area
            label={m.app_statement_measures()}
            rows="4"
            value={measuresText}
            details={m.app_statement_measures_hint()}
            oninput={(e: Event) => {
              setMeasures(valueOf(e));
            }}
          ></s-text-area>
          <s-text-area
            label={m.app_statement_compatibility()}
            rows="2"
            value={content.compatibility}
            oninput={(e: Event) => {
              content.compatibility = valueOf(e);
            }}
          ></s-text-area>
        </s-stack>
      </s-section>

      <s-section heading={m.app_statement_limitations()}>
        <s-stack gap="base">
          <s-paragraph color="subdued">{m.app_statement_limitations_hint()}</s-paragraph>
          {#each content.limitations as limitation, index (index)}
            <fieldset class="limitation">
              <legend>{m.app_statement_limitation_n({ n: index + 1 })}</legend>
              <s-stack gap="small">
                <s-text-field
                  label={m.app_statement_limitation_description()}
                  value={limitation.description}
                  oninput={(e: Event) => {
                    limitation.description = valueOf(e);
                  }}
                ></s-text-field>
                <s-text-field
                  label={m.app_statement_limitation_reason()}
                  value={limitation.reason}
                  oninput={(e: Event) => {
                    limitation.reason = valueOf(e);
                  }}
                ></s-text-field>
                <s-text-field
                  label={m.app_statement_limitation_alternative()}
                  value={limitation.alternative}
                  oninput={(e: Event) => {
                    limitation.alternative = valueOf(e);
                  }}
                ></s-text-field>
                <div>
                  <s-button
                    tone="critical"
                    accessibilityLabel={m.app_statement_limitation_remove_n({ n: index + 1 })}
                    {@attach press(() => void removeLimitation(index))}
                  >
                    {m.app_statement_limitation_remove()}
                  </s-button>
                </div>
              </s-stack>
            </fieldset>
          {/each}
          <div>
            <s-button bind:this={addButton} {@attach press(addLimitation)}
              >{m.app_statement_limitation_add()}</s-button
            >
          </div>
        </s-stack>
      </s-section>

      {#if saveError !== ''}
        <s-section>
          <s-banner tone="critical" heading={m.app_statement_save_failed()}>
            <s-paragraph>{saveError}</s-paragraph>
          </s-banner>
        </s-section>
      {/if}

      <!-- App Bridge shows its contextual save bar for the form above; without it (a plain
           browser tab, the tests) the same two actions sit in the page. -->
      {#if !hasSaveBar()}
        <s-section>
          <s-stack direction="inline" gap="small">
            <s-button type="submit" variant="primary" loading={saving} disabled={saving || !dirty}>
              {m.app_save()}
            </s-button>
            <s-button type="reset" disabled={saving || !dirty}>{m.app_discard()}</s-button>
          </s-stack>
        </s-section>
      {/if}
    </form>

    <s-section heading={m.app_statement_preview_heading()}>
      <s-stack gap="base">
        {#if previewError !== ''}
          <s-banner tone="warning"><s-paragraph>{previewError}</s-paragraph></s-banner>
        {/if}
        {#if preview !== undefined}
          <s-badge tone={preview.status === 'known_barriers' ? 'caution' : 'info'}>
            {statusLabel}
          </s-badge>
          <iframe
            class="preview"
            title={m.app_statement_preview_title()}
            sandbox=""
            srcdoc={preview.document}
          ></iframe>
          <s-stack direction="inline" gap="small">
            <s-button {@attach press(() => void copy(preview?.fragment ?? ''))}>
              {m.app_statement_copy_html()}
            </s-button>
            <s-button {@attach press(() => void copy(preview?.text ?? ''))}>
              {m.app_statement_copy_text()}
            </s-button>
          </s-stack>
        {:else}
          <Loading label={m.app_statement_preview_loading()} />
        {/if}
      </s-stack>
    </s-section>

    <s-section heading={m.app_statement_versions()}>
      {#if (res.data?.versions.length ?? 0) === 0}
        <s-paragraph>{m.app_statement_no_versions()}</s-paragraph>
      {:else}
        <ul class="app-list">
          {#each res.data?.versions ?? [] as version (version.id)}
            <li>
              {m.app_statement_version_line({
                version: version.version,
                status:
                  version.status === 'published'
                    ? m.app_statement_published()
                    : m.app_statement_draft(),
                when: formatDateTime(version.created_at),
              })}
            </li>
          {/each}
        </ul>
      {/if}
    </s-section>
  {/if}
</s-page>

<style>
  .preview {
    inline-size: 100%;
    block-size: 28rem;
    border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
    background: #fff;
  }
  .limitation {
    margin: 0;
    padding: 0.75rem;
    border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
    border-radius: 0.5rem;
  }
  .limitation legend {
    padding-inline: 0.25rem;
    font-weight: 600;
  }
</style>
