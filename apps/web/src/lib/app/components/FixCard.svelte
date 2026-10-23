<script lang="ts">
  import { tick } from 'svelte';
  import { m } from '#lib/paraglide/messages.js';
  import { checkedOf, on, press, valueOf } from '../dom.ts';
  import { formatDateTime } from '../format.ts';
  import type { FixSummary } from '../types.ts';
  import FixStatusBadge from './FixStatusBadge.svelte';
  import ProductImage from './ProductImage.svelte';

  /**
   * One alt-text draft or applied fix. A draft can be approved, edited or rejected; an applied
   * fix can be undone with one click. The card only reports what the merchant chose; the page
   * owns the lists, the requests and where focus goes next.
   */
  interface Props {
    fix: FixSummary;
    mode: 'queue' | 'applied';
    busy: boolean;
    error: string;
    maxCharacters: number;
    /** `confirmed` is true when the merchant ticked the check for a flagged draft. */
    onapprove: (confirmed: boolean) => void;
    onreject: () => void;
    onundo: () => void;
    /** Saves an edit; resolves true when it was saved. */
    onsave: (alt: string) => Promise<boolean>;
  }

  let { fix, mode, busy, error, maxCharacters, onapprove, onreject, onundo, onsave }: Props =
    $props();

  let editing = $state(false);
  let confirmed = $state(false);
  let text = $state('');
  let editButton = $state<HTMLElement | undefined>(undefined);
  let approveButton = $state<HTMLElement | undefined>(undefined);
  let field = $state<HTMLElement | undefined>(undefined);

  const length = $derived([...new Intl.Segmenter().segment(text)].length);
  const empty = $derived(text.trim() === '');
  const tooLong = $derived(length > maxCharacters);
  const fieldError = $derived(
    empty ? m.app_edit_empty() : tooLong ? m.app_edit_too_long({ max: maxCharacters }) : '',
  );
  const pending = $derived(fix.status === 'approved' || fix.status === 'applying');
  /** Why the draft was flagged, as sentences; unknown flags are dropped. */
  const flagTexts = $derived(
    fix.change.flags.flatMap((flag) =>
      flag === 'instruction_like_text_seen'
        ? [m.app_fix_flag_instruction_like_text_seen()]
        : flag === 'suspected_prompt_injection'
          ? [m.app_fix_flag_suspected_prompt_injection()]
          : [],
    ),
  );
  const flagged = $derived(mode === 'queue' && flagTexts.length > 0);

  async function startEdit(): Promise<void> {
    text = fix.change.after;
    editing = true;
    await tick();
    field?.focus();
  }

  async function cancel(): Promise<void> {
    editing = false;
    await tick();
    editButton?.focus();
  }

  async function save(): Promise<void> {
    if (fieldError !== '') return;
    if (await onsave(text.trim())) {
      editing = false;
      await tick();
      approveButton?.focus();
    }
  }

  function keydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && editing) {
      event.stopPropagation();
      void cancel();
    }
  }
</script>

<article class="card" aria-labelledby={`fix-${fix.id}`}>
  <ProductImage url={fix.image_url} product={fix.product_title} />
  <div class="body">
    <h3 id={`fix-${fix.id}`} tabindex="-1">{fix.product_title}</h3>
    <s-stack direction="inline" gap="small" alignItems="center">
      <FixStatusBadge status={fix.status} />
      {#if fix.origin === 'ai'}
        <s-badge tone="neutral">{m.app_fix_ai_draft()}</s-badge>
      {/if}
      {#if fix.edited}
        <s-badge tone="neutral">{m.app_fix_edited()}</s-badge>
      {/if}
      {#if fix.change.contains_text}
        <s-badge tone="info">{m.app_fix_has_text()}</s-badge>
      {/if}
    </s-stack>

    {#if mode === 'queue' && editing}
      <div {@attach on('keydown', keydown)}>
        <s-text-area
          bind:this={field}
          label={m.app_edit_label()}
          value={text}
          rows="3"
          error={fieldError === '' ? undefined : fieldError}
          details={m.app_edit_count({ count: length, max: maxCharacters })}
          oninput={(e: Event) => {
            text = valueOf(e);
          }}
        ></s-text-area>
        <s-stack direction="inline" gap="small">
          <s-button
            variant="primary"
            disabled={busy || fieldError !== ''}
            {@attach press(() => void save())}
          >
            {m.app_edit_save()}
          </s-button>
          <s-button disabled={busy} {@attach press(() => void cancel())}
            >{m.app_edit_cancel()}</s-button
          >
        </s-stack>
      </div>
    {:else}
      <dl class="facts">
        <dt>{m.app_fix_current()}</dt>
        <dd>{fix.change.before ?? m.app_fix_current_none()}</dd>
        <dt>{m.app_fix_suggested()}</dt>
        <dd class="suggested">{fix.change.after}</dd>
      </dl>
    {/if}

    {#if mode === 'applied' && fix.applied_at !== null}
      <s-text color="subdued">
        {m.app_fix_applied_at({ when: formatDateTime(fix.applied_at) })}
        {#if fix.approver_name !== null}
          {m.app_fix_approved_by({ name: fix.approver_name })}
        {/if}
      </s-text>
    {/if}

    {#if flagged}
      <s-banner tone="warning" heading={m.app_fix_flag_heading()}>
        <s-stack gap="small">
          {#each flagTexts as sentence (sentence)}
            <s-paragraph>{sentence}</s-paragraph>
          {/each}
          <s-checkbox
            label={m.app_fix_flag_confirm()}
            checked={confirmed}
            disabled={busy || pending}
            onchange={(e: Event) => {
              confirmed = checkedOf(e);
            }}
          ></s-checkbox>
        </s-stack>
      </s-banner>
    {/if}
    {#if error !== ''}
      <s-banner tone="critical"><s-paragraph>{error}</s-paragraph></s-banner>
    {/if}
    {#if fix.status === 'failed'}
      <s-banner tone="warning"><s-paragraph>{m.app_fix_failed()}</s-paragraph></s-banner>
    {/if}

    {#if mode === 'queue' && !editing}
      <s-stack direction="inline" gap="small">
        <s-button
          bind:this={approveButton}
          variant="primary"
          loading={busy}
          disabled={busy || pending || (flagged && !confirmed)}
          accessibilityLabel={m.app_fix_approve_for({ product: fix.product_title })}
          {@attach press(() => {
            onapprove(confirmed);
          })}
        >
          {m.app_fix_approve()}
        </s-button>
        <s-button
          bind:this={editButton}
          disabled={busy || pending}
          accessibilityLabel={m.app_fix_edit_for({ product: fix.product_title })}
          {@attach press(() => void startEdit())}
        >
          {m.app_fix_edit()}
        </s-button>
        <s-button
          tone="critical"
          disabled={busy || pending}
          accessibilityLabel={m.app_fix_reject_for({ product: fix.product_title })}
          {@attach press(onreject)}
        >
          {m.app_fix_reject()}
        </s-button>
      </s-stack>
    {:else if mode === 'applied' && (fix.status === 'applied' || fix.status === 'verified')}
      <s-button
        loading={busy}
        disabled={busy}
        accessibilityLabel={m.app_fix_undo_for({ product: fix.product_title })}
        {@attach press(onundo)}
      >
        {m.app_fix_undo()}
      </s-button>
    {/if}
  </div>
</article>

<style>
  .card {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    padding-block: 1rem;
    border-block-end: 1px solid color-mix(in srgb, currentColor 18%, transparent);
  }
  .body {
    flex: 1 1 18rem;
    display: grid;
    gap: 0.75rem;
    align-content: start;
    min-inline-size: 0;
  }
  h3 {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
  }
  h3:focus-visible {
    outline: 2px solid #005bd3;
    outline-offset: 2px;
  }
  .facts {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.25rem 1rem;
    margin: 0;
  }
  .facts dt {
    font-weight: 500;
  }
  .facts dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .suggested {
    font-weight: 600;
  }
</style>
