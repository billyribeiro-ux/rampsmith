<script lang="ts">
  import { m } from '#lib/paraglide/messages.js';
  import DraftPage from '#lib/site/DraftPage.svelte';
  import { privacyPolicy } from '#lib/site/legal.ts';
</script>

<DraftPage
  document={privacyPolicy}
  banner={m.site_legal_draft()}
  bannerBody={m.site_legal_draft_body()}
/>
