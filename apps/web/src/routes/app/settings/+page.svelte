<script lang="ts">
  import { onMount } from 'svelte';
  import { m } from '#lib/paraglide/messages.js';
  import { getAppContext } from '#lib/app/context.svelte.ts';
  import { checkedOf, hasSaveBar, valueOf } from '#lib/app/dom.ts';
  import { asApiError, errorMessage } from '#lib/app/errors.ts';
  import { formatNumber, formatUsd } from '#lib/app/format.ts';
  import { embedActivationUrl, planPageUrl } from '#lib/app/nav.ts';
  import { SHOPIFY_API_KEY } from '$app/env/public';
  import { planLabel } from '#lib/app/plans.ts';
  import { Resource } from '#lib/app/resource.svelte.ts';
  import { ApiError } from '#lib/app/api.ts';
  import type { EmailPreferences, FeatureKey, Settings, SettingsUpdate } from '#lib/app/types.ts';
  import ErrorBlock from '#lib/app/components/ErrorBlock.svelte';
  import Loading from '#lib/app/components/Loading.svelte';

  const app = getAppContext();
  const res = new Resource<Settings>(() => app.api.settings());

  // The email switch saves on its own, apart from the form: it is a choice, not a draft.
  let emailPrefs = $state<EmailPreferences | undefined>(undefined);
  let emailBusy = $state(false);
  let emailError = $state('');

  async function loadEmail(): Promise<void> {
    try {
      emailPrefs = await app.api.emailPreferences();
    } catch {
      emailPrefs = undefined;
    }
  }

  async function setEmail(enabled: boolean): Promise<void> {
    emailBusy = true;
    emailError = '';
    try {
      emailPrefs = await app.api.setEmailPreference('notification', enabled);
      app.announce(m.app_settings_email_saved());
    } catch (error) {
      emailError = errorMessage(error instanceof ApiError ? error : asApiError(error));
      await loadEmail();
    } finally {
      emailBusy = false;
    }
  }

  const notificationsOn = $derived(emailPrefs?.categories.every((c) => c.enabled) ?? true);

  // The form's working copy, in the units the merchant types (dollars, not micro-dollars).
  let weekly = $state(false);
  let email = $state('');
  let maxChars = $state('150');
  let budget = $state('0');
  let password = $state('');
  let clearPassword = $state(false);

  let saved = $state('');
  let saving = $state(false);
  let saveError = $state('');
  let fieldErrors = $state<Record<string, string>>({});

  const snapshot = $derived(
    JSON.stringify([weekly, email, maxChars, budget, password !== '', clearPassword]),
  );
  const dirty = $derived(saved !== '' && snapshot !== saved);

  function load(settings: Settings): void {
    weekly = settings.weekly_rescan;
    email = settings.notification_email ?? '';
    maxChars = String(settings.alt_text_max_characters);
    budget = String(settings.ai_budget_micro_usd / 1_000_000);
    password = '';
    clearPassword = false;
    saved = JSON.stringify([weekly, email, maxChars, budget, false, false]);
  }

  onMount(async () => {
    await Promise.all([res.refresh(), loadEmail()]);
    if (res.data !== undefined) load(res.data);
  });

  const cadenceLocked = $derived(res.data?.entitlements.scan_cadence === 'monthly');
  const budgetMax = $derived((res.data?.ai_budget_max_micro_usd ?? 0) / 1_000_000);
  const plansUrl = $derived(planPageUrl(app.shop));
  const embedUrl = $derived(embedActivationUrl(app.shop, SHOPIFY_API_KEY));

  function fieldError(name: string): string | undefined {
    return fieldErrors[name];
  }

  function build(): { update?: SettingsUpdate; errors: Record<string, string> } {
    const errors: Record<string, string> = {};
    const chars = Number(maxChars);
    if (!Number.isInteger(chars) || chars < 40 || chars > 300) {
      errors['alt_text_max_characters'] = m.app_settings_chars_invalid();
    }
    const dollars = Number(budget);
    if (budget.trim() === '' || !Number.isFinite(dollars) || dollars < 0 || dollars > budgetMax) {
      errors['ai_budget_micro_usd'] = m.app_settings_budget_invalid({
        max: formatUsd(budgetMax * 1_000_000),
      });
    }
    if (email.trim() !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email.trim())) {
      errors['notification_email'] = m.app_settings_email_invalid();
    }
    if (Object.keys(errors).length > 0) return { errors };
    return {
      errors,
      update: {
        ...(cadenceLocked ? {} : { weekly_rescan: weekly }),
        notification_email: email.trim() === '' ? null : email.trim(),
        alt_text_max_characters: chars,
        ai_budget_micro_usd: Math.round(dollars * 1_000_000),
        ...(clearPassword
          ? { storefront_password: null }
          : password === ''
            ? {}
            : { storefront_password: password }),
      },
    };
  }

  async function save(event?: Event): Promise<void> {
    event?.preventDefault();
    saveError = '';
    const built = build();
    fieldErrors = built.errors;
    if (built.update === undefined) {
      saveError = m.app_settings_fix_fields();
      return;
    }
    saving = true;
    try {
      res.data = await app.api.updateSettings(built.update);
      load(res.data);
      app.announce(m.app_settings_saved());
    } catch (error) {
      const failed = error instanceof ApiError ? error : asApiError(error);
      saveError = errorMessage(failed);
      fieldErrors = Object.fromEntries(failed.fieldErrors.map((e) => [e.field, e.message]));
    } finally {
      saving = false;
    }
  }

  function discard(): void {
    if (res.data !== undefined) load(res.data);
    fieldErrors = {};
    saveError = '';
  }

  const FEATURE_NAMES: Record<FeatureKey, () => string> = {
    data_fixes: () => m.app_feature_data_fixes(),
    core_recipes: () => m.app_feature_core_recipes(),
    github_pull_requests: () => m.app_feature_prs(),
    every_recipe: () => m.app_feature_every_recipe(),
    description_rewrites: () => m.app_feature_rewrites(),
    regression_alerts: () => m.app_feature_regression_alerts(),
    ai_widget_proposals: () => m.app_feature_widget_proposals(),
    multi_language_statements: () => m.app_feature_multi_language(),
    priority_queue: () => m.app_feature_priority_queue(),
  };
</script>

<svelte:head>
  <title>{m.app_settings_title()}</title>
</svelte:head>

<s-page heading={m.app_settings_heading()}>
  {#if res.status === 'loading'}
    <s-section><Loading /></s-section>
  {:else if res.status === 'error'}
    <s-section><ErrorBlock error={res.error} retry={() => res.refresh()} /></s-section>
  {:else if res.data !== undefined}
    {@const settings = res.data}
    <form data-save-bar={dirty ? '' : undefined} onsubmit={save} onreset={discard}>
      <s-section heading={m.app_settings_scans()}>
        <s-stack gap="base">
          <s-switch
            label={m.app_settings_weekly()}
            checked={weekly}
            disabled={cadenceLocked}
            details={cadenceLocked ? undefined : m.app_settings_weekly_hint()}
            onchange={(e: Event) => {
              weekly = checkedOf(e);
            }}
          ></s-switch>
          {#if cadenceLocked}
            <s-stack direction="inline" gap="small" alignItems="center">
              <s-badge tone="info">
                {m.app_gate_requires({ plan: planLabel('starter') })}
              </s-badge>
              <s-text>{m.app_settings_weekly_locked()}</s-text>
              {#if plansUrl !== undefined}
                <s-link href={plansUrl} target="_top">{m.app_plan_compare()}</s-link>
              {/if}
            </s-stack>
          {/if}
          <s-text-field
            label={m.app_settings_email()}
            value={email}
            error={fieldError('notification_email')}
            details={m.app_settings_email_hint()}
            oninput={(e: Event) => {
              email = valueOf(e);
            }}
          ></s-text-field>
          <s-password-field
            label={m.app_settings_password()}
            value={password}
            disabled={clearPassword}
            details={settings.storefront_password_set
              ? m.app_settings_password_saved()
              : m.app_settings_password_hint()}
            oninput={(e: Event) => {
              password = valueOf(e);
            }}
          ></s-password-field>
          {#if settings.storefront_password_set}
            <s-checkbox
              label={m.app_settings_password_remove()}
              checked={clearPassword}
              onchange={(e: Event) => {
                clearPassword = checkedOf(e);
                if (clearPassword) password = '';
              }}
            ></s-checkbox>
          {/if}
        </s-stack>
      </s-section>

      <s-section heading={m.app_settings_ai()}>
        <s-stack gap="base">
          <s-number-field
            label={m.app_settings_chars()}
            value={maxChars}
            min="40"
            max="300"
            step="1"
            error={fieldError('alt_text_max_characters')}
            details={m.app_settings_chars_hint()}
            oninput={(e: Event) => {
              maxChars = valueOf(e);
            }}
          ></s-number-field>
          <s-number-field
            label={m.app_settings_budget()}
            value={budget}
            min="0"
            max={String(budgetMax)}
            step="0.5"
            prefix="$"
            error={fieldError('ai_budget_micro_usd')}
            details={m.app_settings_budget_hint({
              max: formatUsd(settings.ai_budget_max_micro_usd),
            })}
            oninput={(e: Event) => {
              budget = valueOf(e);
            }}
          ></s-number-field>
        </s-stack>
      </s-section>

      {#if saveError !== ''}
        <s-section>
          <s-banner tone="critical" heading={m.app_settings_save_failed()}>
            <s-paragraph>{saveError}</s-paragraph>
          </s-banner>
        </s-section>
      {/if}

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

    {#if emailPrefs !== undefined}
      <s-section heading={m.app_settings_email_section()}>
        <s-stack gap="base">
          <s-switch
            label={m.app_settings_email_notifications()}
            checked={notificationsOn}
            disabled={emailBusy || !emailPrefs.address_known}
            details={m.app_settings_email_notifications_hint()}
            onchange={(e: Event) => void setEmail(checkedOf(e))}
          ></s-switch>
          {#if !emailPrefs.address_known}
            <s-text>{m.app_settings_email_no_address()}</s-text>
          {/if}
          {#if emailError !== ''}
            <s-banner tone="critical" heading={m.app_settings_email_failed()}>
              <s-paragraph>{emailError}</s-paragraph>
            </s-banner>
          {/if}
        </s-stack>
      </s-section>
    {/if}

    {#if embedUrl !== undefined}
      <s-section heading={m.app_setup_heading()}>
        <s-stack gap="small">
          <s-paragraph>{m.app_setup_body()}</s-paragraph>
          <s-paragraph>{m.app_setup_steps()}</s-paragraph>
          <s-link href={embedUrl} target="_top">{m.app_setup_link()}</s-link>
        </s-stack>
      </s-section>
    {/if}

    <s-section heading={m.app_settings_plan()}>
      <s-stack gap="base">
        <s-paragraph>
          {m.app_settings_plan_line({ plan: planLabel(settings.entitlements.plan) })}
        </s-paragraph>
        <s-paragraph>
          {m.app_plan_drafts({
            used: formatNumber(settings.entitlements.alt_text_drafts.used),
            limit: formatNumber(settings.entitlements.alt_text_drafts.limit),
          })}
        </s-paragraph>
        <ul class="app-list features" aria-label={m.app_settings_features()}>
          {#each settings.entitlements.features as gate (gate.feature)}
            <li>
              <span class="name">{FEATURE_NAMES[gate.feature]()}</span>
              {#if gate.gate === 'allowed'}
                <s-badge tone="success">{m.app_gate_included()}</s-badge>
              {:else}
                <s-badge tone="info">
                  {gate.unlocked_by === null
                    ? m.app_gate_unavailable()
                    : m.app_gate_requires({ plan: planLabel(gate.unlocked_by) })}
                </s-badge>
              {/if}
            </li>
          {/each}
        </ul>
        {#if plansUrl !== undefined}
          <s-link href={plansUrl} target="_top">{m.app_plan_compare()}</s-link>
        {/if}
      </s-stack>
    </s-section>
  {/if}
</s-page>

<style>
  .features li {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding-block: 0.375rem;
  }
  .name {
    min-inline-size: 16rem;
  }
</style>
