<script lang="ts">
  import { m } from '#lib/paraglide/messages.js';
  import type { Impact } from '../types.ts';

  let { impact }: { impact: Impact } = $props();

  const tone = $derived(
    impact === 'critical'
      ? 'critical'
      : impact === 'serious'
        ? 'warning'
        : impact === 'moderate'
          ? 'caution'
          : 'neutral',
  );
  const label = $derived(
    impact === 'critical'
      ? m.app_impact_critical()
      : impact === 'serious'
        ? m.app_impact_serious()
        : impact === 'moderate'
          ? m.app_impact_moderate()
          : m.app_impact_minor(),
  );
</script>

<!-- The word carries the meaning; the tone only adds to it. -->
<s-badge {tone}>{label}</s-badge>
