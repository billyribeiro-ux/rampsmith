<script lang="ts">
  import { m } from '#lib/paraglide/messages.js';
  import { getAppContext } from '../context.svelte.ts';
  import { planPageUrl } from '../nav.ts';
  import { planLabel } from '../plans.ts';
  import type { FeatureGate } from '../types.ts';

  /**
   * A plan-gated action, shown rather than hidden (PLAN §20, Built for Shopify 4.1): visually
   * disabled, labelled with the plan that unlocks it, and explained in text, because a disabled
   * control cannot take focus.
   */
  let { gate, name, description }: { gate: FeatureGate; name: string; description: string } =
    $props();
  const app = getAppContext();
  const allowed = $derived(gate.gate === 'allowed');
  const plansUrl = $derived(planPageUrl(app.shop));
  const requirement = $derived(
    gate.unlocked_by === null
      ? m.app_gate_unavailable()
      : m.app_gate_requires({ plan: planLabel(gate.unlocked_by) }),
  );
</script>

<s-stack direction="inline" gap="base" alignItems="center">
  <s-button disabled={!allowed} accessibilityLabel={allowed ? name : `${name}. ${requirement}`}>
    {name}
  </s-button>
  <s-stack gap="small-200">
    <s-text>{description}</s-text>
    {#if !allowed}
      <s-stack direction="inline" gap="small" alignItems="center">
        <s-badge tone="info">{requirement}</s-badge>
        {#if plansUrl !== undefined}
          <s-link href={plansUrl} target="_top">{m.app_plan_compare()}</s-link>
        {/if}
      </s-stack>
    {/if}
  </s-stack>
</s-stack>
