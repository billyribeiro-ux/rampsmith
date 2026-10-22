<script lang="ts">
  import { press } from '#lib/app/dom.ts';
  import { m } from '#lib/paraglide/messages.js';
  import type { ApiError } from '../api.ts';
  import { errorMessage } from '../errors.ts';

  let {
    error,
    retry,
  }: { error: ApiError | undefined; retry?: (() => void | Promise<void>) | undefined } = $props();
</script>

<s-banner tone="critical" heading={m.app_error_heading()}>
  <s-paragraph>{errorMessage(error)}</s-paragraph>
  {#if retry !== undefined}
    <s-button slot="secondary-actions" {@attach press(() => void retry())}>{m.app_retry()}</s-button
    >
  {/if}
</s-banner>
