<script lang="ts">
  import { m } from '#lib/paraglide/messages.js';
  import EmailLinkPage from '#lib/site/EmailLinkPage.svelte';
  import type { LinkFormData } from '#lib/server/email-link-route.ts';
  import type { PageData } from './$types';

  let { data, form }: { data: PageData; form: LinkFormData | null | undefined } = $props();
</script>

<EmailLinkPage
  {data}
  {form}
  heading={m.site_email_unsub_title()}
  lede={m.site_email_unsub_lede()}
/>
