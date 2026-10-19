<script lang="ts">
  import Tabs from '../../src/lib/Tabs.svelte';

  let selected = $state('open');
  const tabs = [
    { id: 'open', label: 'Open' },
    { id: 'fixed', label: 'Fixed' },
    { id: 'ignored', label: 'Ignored' },
  ];
</script>

<Tabs {tabs} bind:selected label="Findings">
  {#snippet panel(id)}
    <p>{id} findings</p>
  {/snippet}
</Tabs>
