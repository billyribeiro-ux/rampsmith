<script lang="ts">
  import CheckIcon from 'phosphor-svelte/lib/CheckIcon';
  import LockIcon from 'phosphor-svelte/lib/LockIcon';
  import { resolve } from '$app/paths';
  import { m } from '#lib/paraglide/messages.js';
  import {
    FEATURES,
    PLANS,
    includes,
    unlockedBy,
    usd,
    type FeatureId,
    type Plan,
    type PlanId,
  } from '#lib/site/plans.ts';

  const names: Record<PlanId, () => string> = {
    free: () => m.site_plan_free(),
    starter: () => m.site_plan_starter(),
    growth: () => m.site_plan_growth(),
    pro: () => m.site_plan_pro(),
  };
  const scans: Record<PlanId, () => string> = {
    free: () => m.site_plan_free_scans(),
    starter: () => m.site_plan_starter_scans(),
    growth: () => m.site_plan_growth_scans(),
    pro: () => m.site_plan_pro_scans(),
  };
  const fixes: Record<PlanId, () => string> = {
    free: () => m.site_plan_free_fixes(),
    starter: () => m.site_plan_starter_fixes(),
    growth: () => m.site_plan_growth_fixes(),
    pro: () => m.site_plan_pro_fixes(),
  };
  const features: Record<FeatureId, () => string> = {
    scans: () => m.site_feature_scans(),
    data_fixes: () => m.site_feature_data_fixes(),
    core_prs: () => m.site_feature_core_prs(),
    all_recipes: () => m.site_feature_all_recipes(),
    rewrites: () => m.site_feature_rewrites(),
    alerts: () => m.site_feature_alerts(),
    custom_widgets: () => m.site_feature_custom_widgets(),
    languages: () => m.site_feature_languages(),
    priority: () => m.site_feature_priority(),
  };

  const drafts = (plan: Plan): string => {
    const count = plan.altTextDrafts.toLocaleString('en-US');
    return plan.altTextRecurs
      ? m.site_plan_alt_monthly({ count })
      : m.site_plan_alt_once({ count });
  };
</script>

<svelte:head>
  <title>{m.site_pricing_title()} · {m.app_name()}</title>
  <meta name="description" content={m.site_pricing_lede()} />
</svelte:head>

<h1>{m.site_pricing_title()}</h1>
<p class="site-lede">{m.site_pricing_lede()}</p>

<ul class="site-grid plans" aria-label={m.site_pricing_plans_label()}>
  {#each PLANS as plan (plan.id)}
    <li class="site-card plan">
      <h2>{names[plan.id]()}</h2>
      <p class="price">
        {#if plan.monthly === 0}
          <span class="amount">{m.site_plan_free_price()}</span>
        {:else}
          <span class="amount">{m.site_plan_per_month({ price: usd(plan.monthly) })}</span>
          <span class="yearly">{m.site_plan_per_year({ price: usd(plan.yearly) })}</span>
        {/if}
      </p>
      <dl>
        <dt>{m.site_plan_scans()}</dt>
        <dd>{scans[plan.id]()}</dd>
        <dt>{m.site_plan_fixes()}</dt>
        <dd>{fixes[plan.id]()}</dd>
        <dt>{m.site_plan_alt()}</dt>
        <dd>{drafts(plan)}</dd>
      </dl>
    </li>
  {/each}
</ul>

<section aria-labelledby="matrix-title">
  <h2 id="matrix-title">{m.site_pricing_matrix_title()}</h2>
  <p>{m.site_pricing_matrix_lede()}</p>
  <!-- A scrollable region must be reachable by keyboard (WCAG 2.1.1). -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div class="scroll" role="region" aria-labelledby="matrix-title" tabindex="0">
    <table>
      <caption class="rs-visually-hidden">{m.site_pricing_matrix_caption()}</caption>
      <thead>
        <tr>
          <th scope="col">{m.site_pricing_col_feature()}</th>
          {#each PLANS as plan (plan.id)}
            <th scope="col">{names[plan.id]()}</th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each FEATURES as feature (feature)}
          <tr>
            <th scope="row">{features[feature]()}</th>
            {#each PLANS as plan (plan.id)}
              {#if includes(plan.id, feature)}
                <td>
                  <span class="state included">
                    <CheckIcon size={20} weight="bold" aria-hidden="true" />
                    {m.site_pricing_included()}
                  </span>
                </td>
              {:else}
                <td class="locked">
                  <span class="state">
                    <LockIcon size={20} aria-hidden="true" />
                    <span>
                      {m.site_pricing_locked()}
                      <span class="from">
                        {m.site_pricing_locked_from({ plan: names[unlockedBy(feature)]() })}
                      </span>
                    </span>
                  </span>
                </td>
              {/if}
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</section>

<section aria-labelledby="notes-title">
  <h2 id="notes-title">{m.site_pricing_notes_title()}</h2>
  <ul>
    <li>{m.site_pricing_note_billing()}</li>
    <li>{m.site_pricing_note_free()}</li>
    <li>{m.site_pricing_note_agency()}</li>
    <li>{m.site_pricing_note_limits()}</li>
  </ul>
</section>

<div class="site-actions">
  <a class="site-button primary" href={resolve('/(site)/scan')}>{m.site_cta_scan()}</a>
  <a class="site-button secondary" href={resolve('/(site)/how-it-works')}>{m.site_cta_how()}</a>
</div>

<style>
  .plans {
    margin-block: var(--rs-space-6);
  }
  .plan h2 {
    margin: 0;
    font-size: 1.5rem;
  }
  .price {
    margin-block: var(--rs-space-2) var(--rs-space-4);
  }
  .amount {
    display: block;
    font-family: var(--site-display);
    font-size: 1.75rem;
    font-weight: 700;
  }
  .yearly {
    color: var(--rs-color-text-muted);
  }
  dt {
    margin-top: var(--rs-space-3);
    font-weight: 700;
  }
  dd {
    margin: 0;
  }
  .scroll {
    overflow-x: auto;
  }
  .scroll table {
    min-width: 44rem;
  }
  .state {
    display: inline-flex;
    gap: var(--rs-space-2);
    align-items: flex-start;
  }
  .included {
    color: var(--rs-color-success);
    font-weight: 600;
  }
  /* Plan-gated: visible and labelled, but visually set back. The text keeps 4.5:1. */
  .locked {
    background: repeating-linear-gradient(
      135deg,
      transparent 0 0.5rem,
      color-mix(in srgb, var(--rs-color-border) 14%, transparent) 0.5rem 1rem
    );
    color: var(--rs-color-text-muted);
  }
  .from {
    display: block;
    font-size: 0.875rem;
  }
</style>
