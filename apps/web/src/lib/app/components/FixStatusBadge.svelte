<script lang="ts">
  import { m } from '#lib/paraglide/messages.js';
  import type { FixStatus } from '../types.ts';

  let { status }: { status: FixStatus } = $props();

  const tone = $derived(
    status === 'verified' || status === 'applied'
      ? 'success'
      : status === 'failed'
        ? 'critical'
        : status === 'proposed'
          ? 'info'
          : 'neutral',
  );
  const label = $derived(
    {
      proposed: m.app_fix_status_proposed(),
      approved: m.app_fix_status_approved(),
      applying: m.app_fix_status_applying(),
      applied: m.app_fix_status_applied(),
      verified: m.app_fix_status_verified(),
      failed: m.app_fix_status_failed(),
      reverted: m.app_fix_status_reverted(),
      rejected: m.app_fix_status_rejected(),
    }[status],
  );
</script>

<s-badge {tone}>{label}</s-badge>
