<script lang="ts">
  import { m } from '#lib/paraglide/messages.js';

  let { label = m.app_loading() }: { label?: string } = $props();
</script>

<s-stack direction="inline" gap="small" alignItems="center">
  <s-spinner accessibilityLabel={label}></s-spinner>
  <s-text>{label}</s-text>
</s-stack>
