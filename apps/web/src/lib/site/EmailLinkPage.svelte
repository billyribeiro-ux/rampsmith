<script lang="ts">
  // The page behind an email's unsubscribe or preferences link (ADR-274). Opening it changes
  // nothing; each category has its own button, which works as a plain form post and, with
  // JavaScript, updates in place and keeps the focus on the confirmation.
  import { enhance } from '$app/forms';
  import { Button } from '@rampsmith/ui';
  import { m } from '#lib/paraglide/messages.js';
  import type { LinkFormData, LinkPageData } from '#lib/server/email-link-route.ts';
  import type { EmailCategory } from '#lib/server/email-link.ts';

  let {
    data,
    form,
    heading,
    lede,
  }: {
    data: LinkPageData;
    form: LinkFormData | null | undefined;
    heading: string;
    lede: string;
  } = $props();

  // The newest answer: what the last post returned, else what the load saw.
  const view = $derived(form?.view ?? data.view);
  let confirmation: HTMLParagraphElement | undefined = $state();

  const NAMES: Record<EmailCategory, () => string> = {
    notification: () => m.site_email_cat_notification(),
    marketing: () => m.site_email_cat_marketing(),
  };
  const DETAILS: Record<EmailCategory, () => string> = {
    notification: () => m.site_email_cat_notification_detail(),
    marketing: () => m.site_email_cat_marketing_detail(),
  };

  function confirmed(): string | undefined {
    const changed = form?.changed;
    if (changed === undefined || form?.view.status !== 'ok') return undefined;
    const name = NAMES[changed.category]();
    return changed.enabled
      ? m.site_email_now_on({ category: name })
      : m.site_email_now_off({ category: name });
  }
  const message = $derived(confirmed());
</script>

<svelte:head>
  <title>{heading} · {m.app_name()}</title>
  <meta name="robots" content="noindex, nofollow" />
  <meta name="referrer" content="same-origin" />
</svelte:head>

<h1>{heading}</h1>

{#if view.status === 'ok'}
  <p class="site-lede">{lede}</p>

  {#if message !== undefined}
    <p class="site-callout" role="status" tabindex="-1" bind:this={confirmation}>{message}</p>
  {/if}

  <ul class="categories" aria-label={m.site_email_list_label()}>
    {#each view.categories as item (item.category)}
      <li>
        <div>
          <h2 class="category-name">{NAMES[item.category]()}</h2>
          <p>{DETAILS[item.category]()}</p>
          <p class="state">
            {item.enabled ? m.site_email_state_on() : m.site_email_state_off()}
          </p>
        </div>
        <form
          method="POST"
          use:enhance={() =>
            async ({ update }) => {
              await update({ reset: false });
              confirmation?.focus();
            }}
        >
          <input type="hidden" name="token" value={data.token} />
          <input type="hidden" name="category" value={item.category} />
          <input type="hidden" name="enabled" value={item.enabled ? 'false' : 'true'} />
          <Button type="submit" variant={item.enabled ? 'primary' : 'secondary'}>
            {item.enabled
              ? m.site_email_turn_off({ category: NAMES[item.category]() })
              : m.site_email_turn_on({ category: NAMES[item.category]() })}
          </Button>
        </form>
      </li>
    {/each}
  </ul>

  <p class="note">{m.site_email_note()}</p>
{:else if view.status === 'expired'}
  <div class="site-callout warning" role="note">
    <h2 class="callout-title">{m.site_email_expired_title()}</h2>
    <p>{m.site_email_expired_body()}</p>
  </div>
{:else if view.status === 'unavailable'}
  <div class="site-callout warning" role="alert">
    <h2 class="callout-title">{m.site_email_unavailable_title()}</h2>
    <p>{m.site_email_unavailable_body()}</p>
  </div>
{:else}
  <div class="site-callout warning" role="note">
    <h2 class="callout-title">{m.site_email_invalid_title()}</h2>
    <p>{m.site_email_invalid_body()}</p>
  </div>
{/if}

<style>
  .categories {
    list-style: none;
    padding: 0;
    margin-block: var(--rs-space-6);
    display: grid;
    gap: var(--rs-space-4);
  }
  .categories li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--rs-space-4);
    padding: var(--rs-space-4);
    border: 1px solid currentColor;
    border-radius: var(--rs-radius, 0.5rem);
  }
  .category-name,
  .callout-title {
    margin: 0 0 var(--rs-space-2);
    font-family: var(--rs-font);
    font-size: 1.15rem;
  }
  .state {
    font-weight: 600;
  }
  .note {
    max-inline-size: 60ch;
  }
  [role='status']:focus {
    outline: none;
  }
</style>
