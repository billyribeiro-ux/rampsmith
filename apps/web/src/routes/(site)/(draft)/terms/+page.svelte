<script lang="ts">
  import { m } from '#lib/paraglide/messages.js';
  import DraftPage from '#lib/site/DraftPage.svelte';
  import { termsOfService } from '#lib/site/legal.ts';
</script>

<DraftPage
  document={termsOfService}
  banner={m.site_legal_draft()}
  bannerBody={m.site_legal_draft_body()}
/>
