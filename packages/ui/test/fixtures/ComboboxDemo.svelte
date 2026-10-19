<script lang="ts">
  import Combobox from '../../src/lib/Combobox.svelte';

  let value: string | undefined = $state();
</script>

<Combobox
  label="Theme"
  bind:value
  noResults="No matches"
  results={(n: number) => `${n.toString()} results`}
  options={[
    { value: 'dawn', label: 'Dawn' },
    { value: 'refresh', label: 'Refresh' },
    { value: 'sense', label: 'Sense' },
    { value: 'craft', label: 'Craft' },
  ]}
/>
<p>Chosen: {value ?? 'none'}</p>
