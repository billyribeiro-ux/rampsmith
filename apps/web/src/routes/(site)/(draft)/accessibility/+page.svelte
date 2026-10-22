<script lang="ts">
  import { m } from '#lib/paraglide/messages.js';
  import DraftPage from '#lib/site/DraftPage.svelte';
  import { accessibilityStatement } from '#lib/site/legal.ts';
</script>

<DraftPage
  document={accessibilityStatement}
  banner={m.site_statement_draft()}
  bannerBody={m.site_statement_draft_body()}
/>
